import { anyStaff, orgMember, platform } from '../../erp/handlers/auth-context'
import { getErpDb } from '../../erp/handlers/db'
import { ApiError, domainError, fieldError, invalid } from '../../erp/handlers/errors'
import { listResult, ok, parseBody, type RouteContext, type RouteSpec } from '../../erp/handlers/http'
import {
  buildSettingDefinitions,
  isBelowLegalMinimum,
  toSettingOverride,
  validateSettingValue,
  type StoredOverride,
} from '../model'
import { ResetSettingOverridesSchema, SetSettingOverridesSchema, UpdateSettingSchema, type EffectiveSetting } from '../schemas'
import { SETTINGS_CATALOG, settingEntry, type SettingCatalogEntry } from '../settings-catalog'
import { bo, effectiveSetting, recordAudit, stamp } from './support'

// Configuración en dos niveles (contrato de la Ola 1 §6): estándar general, ajustes por bodega,
// "volver al estándar", historial, mínimos legales (A-31) y valor efectivo para la bodega.

const ADMINS = platform(['ADMIN'])

function entryOf(key: string): SettingCatalogEntry {
  const entry = settingEntry(key)
  if (!entry) throw domainError(404, 'SETTING_NOT_FOUND', `Parámetro "${key}" no encontrado`)
  return entry
}

function definition(key: string) {
  const state = bo()
  return buildSettingDefinitions(state.settings, state.overrides).find((d) => d.key === key)!
}

function assertValue(entry: SettingCatalogEntry, value: unknown): void {
  const problem = validateSettingValue(entry, value)
  if (problem) throw invalid([fieldError('value', problem)])
}

function assertLegal(entry: SettingCatalogEntry, value: unknown, exception: boolean): void {
  if (!exception && isBelowLegalMinimum(entry, value)) {
    throw domainError(
      422,
      'SETTING_BELOW_LEGAL_MINIMUM',
      `El valor es más laxo que el mínimo legal (${JSON.stringify(entry.legalMinimum)}); solo administración puede autorizar una excepción por bodega, con motivo`,
      'value',
    )
  }
}

/** Bodegas del cuerpo (`'ALL'` = todas las no revocadas); ids desconocidos → 422. */
function targetWineries(ids: string[] | 'ALL'): { id: string; name: string }[] {
  const wineries = getErpDb().wineries
  if (ids === 'ALL') return wineries.filter((w) => w.certificationStatus !== 'REVOKED').map((w) => ({ id: w.id, name: w.commercialName }))
  const unknown = ids.map((id, i) => [id, i] as const).filter(([id]) => !wineries.some((w) => w.id === id))
  if (unknown.length) throw invalid(unknown.map(([id, i]) => fieldError(`wineryIds.${i}`, `Bodega "${id}" no encontrada`)))
  return [...new Set(ids)].map((id) => ({ id, name: wineries.find((w) => w.id === id)!.commercialName }))
}

function history(ctx: RouteContext, key: string, scope: string, before: unknown, after: unknown, reason: string, at: string) {
  bo().settingHistory.push({ key, at, by: ctx.auth.user.fullName, scope, before, after, reason })
}

export const settingsRoutes: RouteSpec[] = [
  {
    method: 'get',
    path: '/v1/platform/settings',
    access: anyStaff,
    handle() {
      const state = bo()
      return ok(buildSettingDefinitions(state.settings, state.overrides))
    },
  },
  {
    method: 'put',
    path: '/v1/platform/settings/:key',
    access: ADMINS,
    async handle(ctx) {
      const entry = entryOf(ctx.params.key!)
      const body = await parseBody(ctx.request, UpdateSettingSchema)
      if (entry.levels === 'WINERY') {
        throw domainError(422, 'SETTING_LEVEL_NOT_ALLOWED', 'Este parámetro solo se ajusta por bodega', 'value')
      }
      assertValue(entry, body.value)
      assertLegal(entry, body.value, false)
      const state = bo()
      let stored = state.settings.find((s) => s.key === entry.key)
      if (!stored) {
        stored = { key: entry.key, value: entry.default, updatedAt: stamp(), updatedBy: null }
        state.settings.push(stored)
      }
      const before = stored.value
      const at = stamp()
      Object.assign(stored, { value: body.value, updatedAt: at, updatedBy: ctx.auth.user.fullName })
      history(ctx, entry.key, 'GLOBAL', before, body.value, body.reason, at)
      recordAudit(ctx, {
        action: 'SETTING_CHANGED',
        resource: { type: 'SETTING', id: entry.key },
        organizationId: null,
        before: { value: before },
        after: { value: body.value },
        reason: body.reason,
      })
      return ok(definition(entry.key))
    },
  },
  {
    method: 'get',
    path: '/v1/platform/settings/:key/overrides',
    access: anyStaff,
    list: 'paged',
    handle({ params, query }) {
      const entry = entryOf(params.key!)
      const wineries = getErpDb().wineries
      const items = bo()
        .overrides.filter((o) => o.key === entry.key)
        .map((o) => toSettingOverride(o, wineries.find((w) => w.id === o.wineryId)?.commercialName ?? o.wineryId))
      return listResult(items, query)
    },
  },
  {
    method: 'put',
    path: '/v1/platform/settings/:key/overrides',
    access: ADMINS,
    async handle(ctx) {
      const entry = entryOf(ctx.params.key!)
      const body = await parseBody(ctx.request, SetSettingOverridesSchema)
      if (entry.levels === 'GLOBAL') {
        throw domainError(422, 'SETTING_LEVEL_NOT_ALLOWED', 'Este parámetro solo tiene estándar general: no admite ajustes por bodega', 'wineryIds')
      }
      assertValue(entry, body.value)
      const exception = body.legalException === true
      if (exception && !['SUPERADMIN', 'ADMIN'].includes(ctx.auth.platformRole ?? '')) {
        throw new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Solo administración autoriza excepciones al mínimo legal')
      }
      assertLegal(entry, body.value, exception)
      const targets = targetWineries(body.wineryIds)
      const state = bo()
      const at = stamp()
      for (const t of targets) {
        const current = state.overrides.find((o) => o.key === entry.key && o.wineryId === t.id)
        const before = current ? current.value : effectiveSetting(entry.key).value
        const next: StoredOverride = {
          key: entry.key,
          wineryId: t.id,
          value: body.value,
          legalException: exception && isBelowLegalMinimum(entry, body.value),
          reason: body.reason,
          updatedAt: at,
          updatedBy: ctx.auth.user.fullName,
        }
        state.overrides = [...state.overrides.filter((o) => !(o.key === entry.key && o.wineryId === t.id)), next]
        history(ctx, entry.key, t.id, before, body.value, body.reason, at)
        recordAudit(ctx, {
          action: 'SETTING_OVERRIDE_SET',
          resource: { type: 'SETTING', id: entry.key },
          organizationId: t.id,
          before: { value: current ? current.value : null },
          after: { value: body.value, legalException: next.legalException },
          reason: body.reason,
        })
      }
      return ok({ updated: targets.length })
    },
  },
  {
    method: 'post',
    path: '/v1/platform/settings/:key/overrides/reset',
    access: ADMINS,
    async handle(ctx) {
      const entry = entryOf(ctx.params.key!)
      const body = await parseBody(ctx.request, ResetSettingOverridesSchema)
      const targets = targetWineries(body.wineryIds)
      const state = bo()
      const at = stamp()
      let reset = 0
      for (const t of targets) {
        const current = state.overrides.find((o) => o.key === entry.key && o.wineryId === t.id)
        if (!current) continue
        state.overrides = state.overrides.filter((o) => o !== current)
        reset++
        const standard = effectiveSetting(entry.key).value
        history(ctx, entry.key, t.id, current.value, standard, body.reason, at)
        recordAudit(ctx, {
          action: 'SETTING_OVERRIDE_RESET',
          resource: { type: 'SETTING', id: entry.key },
          organizationId: t.id,
          before: { value: current.value },
          after: { value: standard },
          reason: body.reason,
        })
      }
      return ok({ reset })
    },
  },
  {
    method: 'get',
    path: '/v1/platform/settings/:key/history',
    access: anyStaff,
    list: 'paged',
    handle({ params, query }) {
      const entry = entryOf(params.key!)
      const items = bo()
        .settingHistory.filter((h) => h.key === entry.key)
        .map(({ key: _key, ...h }) => h)
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/organizations/current/settings',
    access: orgMember(),
    handle({ auth }) {
      const items: EffectiveSetting[] = SETTINGS_CATALOG.map((s) => {
        const eff = effectiveSetting(s.key, auth.organizationId)
        return { key: s.key, description: s.description, value: eff.value, source: eff.source, appliesAt: s.appliesAt }
      })
      return ok(items)
    },
  },
]
