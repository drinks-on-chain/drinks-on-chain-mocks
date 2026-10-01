import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuditEventSchema,
  DashboardAlertSchema,
  MockEmailSchema,
  WineryDetailSchema,
  type AuditEvent,
} from '../src'
import {
  buildWineryDetail,
  MemberBlockSchema,
  StaffMfaSchema,
  StoredApplicationSchema,
  StoredInvitationSchema,
  StoredOverrideSchema,
  StoredSettingHistorySchema,
  StoredSettingSchema,
  verifyAuditChain,
  WineryProfileSchema,
  isBelowLegalMinimum,
} from '../src/backoffice/model'
import { generateBackofficeFixtures, REFERENCE_NOW } from '../src/backoffice/seed/generate'
import { SETTINGS_CATALOG } from '../src/backoffice/settings-catalog'
import { generateErpFixtures } from '../src/erp/seed/generate'
import { backofficeFixtures as B, demoStaff, erpFixtures as F } from '../src/fixtures'

// Fixtures de la Ola 1 (fixtures/backoffice/*.json). La referencia de Python solo cubre el ERP:
// estos datos se validan aquí con sus esquemas y reglas de coherencia.

const dir = join(import.meta.dirname, '..', 'fixtures', 'backoffice')
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const roundTrip = (data: unknown): unknown => JSON.parse(JSON.stringify(data))

const SCHEMAS: Record<string, z.ZodType> = {
  'applications.json': z.array(StoredApplicationSchema),
  'invitations.json': z.array(StoredInvitationSchema),
  'winery-profiles.json': z.array(WineryProfileSchema),
  'winery-details.json': z.array(WineryDetailSchema),
  'member-blocks.json': z.array(MemberBlockSchema),
  'staff-mfa.json': z.array(StaffMfaSchema),
  'settings.json': z.array(StoredSettingSchema),
  'setting-overrides.json': z.array(StoredOverrideSchema),
  'setting-history.json': z.array(StoredSettingHistorySchema),
  'alerts.json': z.array(DashboardAlertSchema),
  'audit.json': z.array(AuditEventSchema),
  'mailbox.json': z.array(MockEmailSchema),
}

describe('fixtures de la Ola 1: esquemas y generador', () => {
  it('cada archivo tiene esquema', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(SCHEMAS).sort())
  })

  it.each(Object.keys(SCHEMAS))('%s cumple su esquema zod sin campos extra', (name) => {
    const data = readJson(name)
    const result = SCHEMAS[name]!.safeParse(data)
    if (!result.success) throw new Error(z.prettifyError(result.error))
    expect(result.data).toStrictEqual(data)
  })

  it('están al día con el generador (pnpm seed) y el generador es determinista', () => {
    const set = generateBackofficeFixtures(generateErpFixtures())
    for (const [name, data] of Object.entries(set)) expect(readJson(name), name).toStrictEqual(roundTrip(data))
    expect(roundTrip(generateBackofficeFixtures(generateErpFixtures()))).toStrictEqual(roundTrip(set))
  })
})

describe('fixtures de la Ola 1: coherencia con el ERP', () => {
  const wineryIds = new Set(F.wineries.map((w) => w.id))
  const userIds = new Set(F.users.map((u) => u.id))

  it('personal interno: superusuario, ADMIN, OPERATIONS y SUPPORT con TOTP inscrito (y una persona sin inscribir)', () => {
    const roles = demoStaff.map((u) => [u.email, u.platformRole, u.mfa?.enrolled])
    expect(roles).toEqual(
      expect.arrayContaining([
        ['gestor@drinksonchain.test', 'SUPERADMIN', true],
        ['administracion@drinksonchain.test', 'ADMIN', true],
        ['operaciones@drinksonchain.test', 'OPERATIONS', true],
        ['soporte@drinksonchain.test', 'SUPPORT', true],
        ['analista@drinksonchain.test', 'OPERATIONS', false],
      ]),
    )
    for (const s of demoStaff.filter((u) => u.mfa?.enrolled)) expect(s.mfa!.recoveryCodes).toHaveLength(10)
  })

  it('solicitudes: al menos 8, en todos los estados, con notas y una reunión', () => {
    expect(B.applications.length).toBeGreaterThanOrEqual(8)
    expect(new Set(B.applications.map((a) => a.status))).toEqual(
      new Set(['UNVERIFIED', 'RECEIVED', 'IN_REVIEW', 'MEETING_SCHEDULED', 'APPROVED', 'REJECTED']),
    )
    expect(B.applications.some((a) => a.notes.length > 0)).toBe(true)
    expect(B.applications.some((a) => a.status === 'MEETING_SCHEDULED' && a.meeting)).toBe(true)
    for (const a of B.applications.filter((x) => x.status === 'APPROVED')) expect(wineryIds.has(a.wineryId!)).toBe(true)
    for (const a of B.applications.filter((x) => x.status === 'UNVERIFIED')) expect(a._mock.verifyToken).toBeTruthy()
    for (const a of B.applications.filter((x) => x.status === 'REJECTED')) expect(a.decision?.reason).toBeTruthy()
  })

  it('bodegas en los cuatro estados; perfiles y fichas coherentes con el ERP', () => {
    expect(new Set(F.wineries.map((w) => w.certificationStatus))).toEqual(new Set(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']))
    expect(B.wineryProfiles.map((p) => p.wineryId).sort()).toEqual([...wineryIds].sort())
    for (const p of B.wineryProfiles) {
      const w = F.wineries.find((x) => x.id === p.wineryId)!
      expect(p.statusHistory.at(-1)!.status, w.commercialName).toBe(w.certificationStatus)
      expect(Boolean(p.lotPrefix), w.commercialName).toBe(w.certificationStatus !== 'INVITED')
      expect(buildWineryDetail(w, p, { users: F.users, invitations: B.invitations, nowIso: REFERENCE_NOW })).toStrictEqual(
        B.wineryDetails.find((d) => d.id === w.id),
      )
    }
    expect(new Set(B.wineryProfiles.map((p) => p.slug)).size).toBe(B.wineryProfiles.length)
    expect(B.wineryDetails.find((d) => d.slug === 'altos-de-calamuchita')!.lotPrefix).toBe('ALT')
  })

  it('invitaciones en los cuatro estados, de bodega y de plataforma, con token', () => {
    expect(new Set(B.invitations.map((i) => i.status))).toEqual(new Set(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']))
    expect(new Set(B.invitations.map((i) => i.organizationType))).toEqual(new Set(['WINERY', 'PLATFORM']))
    expect(new Set(B.invitations.map((i) => i._mock.token)).size).toBe(B.invitations.length)
    for (const i of B.invitations) expect(userIds.has(i.invitedBy.userId)).toBe(true)
  })

  it('miembros bloqueados por el dueño y por la plataforma (y el estado del ERP lo refleja)', () => {
    expect(new Set(B.memberBlocks.map((b) => b.by))).toEqual(new Set(['OWNER', 'PLATFORM']))
    for (const b of B.memberBlocks) {
      const m = F.wineries.flatMap((w) => w.members ?? []).find((x) => x.id === b.membershipId)!
      expect(m.isActive).toBe(false)
    }
  })

  it('configuración: los 27 parámetros de docs-back/05 §4 con su valor por defecto, ajustes por bodega y una excepción legal', () => {
    expect(SETTINGS_CATALOG).toHaveLength(27)
    expect(B.settings.map((s) => s.key)).toEqual(SETTINGS_CATALOG.map((s) => s.key))
    for (const s of B.settings) expect(s.value, s.key).toStrictEqual(SETTINGS_CATALOG.find((c) => c.key === s.key)!.default)
    expect(B.settingOverrides.length).toBeGreaterThanOrEqual(3)
    const legal = B.settingOverrides.filter((o) => o.legalException)
    expect(legal).toHaveLength(1)
    const entry = SETTINGS_CATALOG.find((c) => c.key === legal[0]!.key)!
    expect(isBelowLegalMinimum(entry, legal[0]!.value)).toBe(true)
    expect(B.settingHistory.length).toBeGreaterThanOrEqual(B.settingOverrides.length)
  })

  it('bitácora: ~150 eventos encadenados por hash, en orden y sobre recursos de los fixtures', () => {
    const audit: AuditEvent[] = B.audit
    expect(audit.length).toBeGreaterThanOrEqual(140)
    expect(audit.map((e) => e.seq)).toEqual(audit.map((_, i) => i + 1))
    expect(verifyAuditChain(audit)).toEqual({ valid: true, checked: audit.length, firstBrokenSeq: null })
    for (let i = 1; i < audit.length; i++) expect(audit[i]!.occurredAt >= audit[i - 1]!.occurredAt).toBe(true)
    for (const e of audit) {
      if (e.actor.userId) expect(userIds.has(e.actor.userId), e.action).toBe(true)
      if (e.organizationId && e.organizationId !== demoStaff[0]!.memberships[0]!.organizationId) {
        expect(wineryIds.has(e.organizationId), e.action).toBe(true)
      }
    }
    const actions = new Set(audit.map((e) => e.action))
    for (const a of ['WINERY_APPLICATION_APPROVED', 'INVITATION_CREATED', 'MEMBER_BLOCKED', 'SETTING_OVERRIDE_SET', 'WINERY_SUSPENDED', 'BOTTLING_BATCH_CREATED']) {
      expect(actions.has(a), a).toBe(true)
    }
  })

  it('buzón: correos con enlace para las invitaciones pendientes y la solicitud sin verificar', () => {
    const pending = B.invitations.filter((i) => i.status === 'PENDING')
    for (const i of pending) expect(B.mailbox.some((m) => m.template === 'INVITATION' && m.token === i._mock.token)).toBe(true)
    const unverified = B.applications.find((a) => a.status === 'UNVERIFIED')!
    expect(B.mailbox.find((m) => m.template === 'APPLICATION_VERIFY')!.link).toBe(
      `http://localhost:3000/unirse/verificar?token=${unverified._mock.verifyToken}`,
    )
  })
})
