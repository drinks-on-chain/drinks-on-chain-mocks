import { z } from 'zod'
import { WINERY_CODES_BY_ID } from '../erp/catalog'
import { IsoDateTimeSchema } from '../erp/schemas/common'
import type { MockUser } from '../erp/schemas/users'
import type { WineryResponse } from '../erp/schemas/wineries'
import { canonicalJson, sha256Hex } from '../shared/crypto'
import { WineryApplicationSchema } from './schemas/applications'
import { type AuditEvent, AuditEventSchema } from './schemas/audit'
import { BlockedBySchema } from './schemas/team'
import { InvitationSchema, type Invitation, type InvitationStatus } from './schemas/invitations'
import { SettingHistoryEntrySchema, type SettingDefinition, type SettingOverride } from './schemas/settings'
import { WineryStatusChangeSchema, type WineryDetail } from './schemas/wineries'
import type { SettingCatalogEntry } from './settings-catalog'
import { SETTINGS_CATALOG } from './settings-catalog'

// Modelo de los datos de la Ola 1 que guardan los mocks (fixtures `fixtures/backoffice/*.json` y
// estado de los handlers) y funciones puras que comparten el generador y los handlers. Los campos
// `_mock` solo existen en los mocks (tokens en claro que el backend guardaría como hash).

// ---------------------------------------------------------------------------
// Registros guardados
// ---------------------------------------------------------------------------

export const StoredApplicationSchema = WineryApplicationSchema.extend({
  _mock: z.object({
    /** Token del enlace de verificación del correo de contacto (`null` una vez verificado). */
    verifyToken: z.string().nullable(),
  }),
})
export type StoredApplication = z.infer<typeof StoredApplicationSchema>

export const StoredInvitationSchema = InvitationSchema.extend({
  _mock: z.object({
    /** Token del enlace (el backend solo guarda su hash). */
    token: z.string(),
    /** Nombre del dueño invitado (alta directa o solicitud aprobada). */
    inviteeName: z.string().nullable(),
    /** Transferencia de titularidad: qué pasa con el dueño anterior al aceptar. */
    transfer: z
      .object({
        previousOwnerMembershipId: z.string(),
        keepPreviousOwnerAs: z.enum(['ENOLOGIST', 'BLOCKED']),
      })
      .nullable(),
    acceptedAt: IsoDateTimeSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
  }),
})
export type StoredInvitation = z.infer<typeof StoredInvitationSchema>

/** Datos de la bodega de la Ola 1 que no están en `WineryResponseDto`. */
export const WineryProfileSchema = z.object({
  wineryId: z.string(),
  slug: z.string(),
  lotPrefix: z.string().regex(/^[A-Z]{3,5}$/).nullable(),
  publicStory: z.string().nullable(),
  website: z.string().nullable(),
  activatedAt: IsoDateTimeSchema.nullable(),
  statusHistory: z.array(WineryStatusChangeSchema),
})
export type WineryProfile = z.infer<typeof WineryProfileSchema>

/** Quién bloqueó una membresía y por qué (el estado `BLOCKED` vive en la membresía). */
export const MemberBlockSchema = z.object({
  membershipId: z.string(),
  organizationId: z.string(),
  by: BlockedBySchema,
  reason: z.string().nullable(),
  at: IsoDateTimeSchema,
})
export type MemberBlock = z.infer<typeof MemberBlockSchema>

/** Segundo factor de una persona de plataforma. */
export const StaffMfaSchema = z.object({
  userId: z.string(),
  enrolled: z.boolean(),
  secret: z.string().nullable(),
  enrolledAt: IsoDateTimeSchema.nullable(),
  /** Códigos de recuperación sin usar. */
  recoveryCodes: z.array(z.string()),
})
export type StaffMfa = z.infer<typeof StaffMfaSchema>

/** Valor general guardado de un parámetro. */
export const StoredSettingSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: IsoDateTimeSchema,
  updatedBy: z.string().nullable(),
})
export type StoredSetting = z.infer<typeof StoredSettingSchema>

export const StoredOverrideSchema = z.object({
  key: z.string(),
  wineryId: z.string(),
  value: z.unknown(),
  legalException: z.boolean(),
  reason: z.string(),
  updatedAt: IsoDateTimeSchema,
  updatedBy: z.string(),
})
export type StoredOverride = z.infer<typeof StoredOverrideSchema>

export const StoredSettingHistorySchema = SettingHistoryEntrySchema.extend({ key: z.string() })
export type StoredSettingHistory = z.infer<typeof StoredSettingHistorySchema>

export { AuditEventSchema }

// ---------------------------------------------------------------------------
// Invitaciones
// ---------------------------------------------------------------------------

/** Estado efectivo: una invitación pendiente cuya caducidad pasó está `EXPIRED`. */
export function effectiveInvitationStatus(inv: Pick<Invitation, 'status' | 'expiresAt'>, nowIso: string): InvitationStatus {
  return inv.status === 'PENDING' && Date.parse(inv.expiresAt) <= Date.parse(nowIso) ? 'EXPIRED' : inv.status
}

/** Invitación pública (sin `_mock`). */
export function toInvitation(inv: StoredInvitation, nowIso: string): Invitation {
  const out: Partial<StoredInvitation> = { ...inv, status: effectiveInvitationStatus(inv, nowIso) }
  delete out._mock
  return out as Invitation
}

// ---------------------------------------------------------------------------
// Bodegas
// ---------------------------------------------------------------------------

/** `slug` de un nombre comercial: minúsculas sin tildes, guiones, sin el prefijo "bodega". */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^bodegas?-/, '')
}

/** `slug` único frente a los que ya existen (añade `-2`, `-3`…). */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name) || 'bodega'
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

const STOPWORDS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'E'])
const GENERIC = new Set(['BODEGA', 'BODEGAS', 'DESTILERIA', 'VINEDOS', 'VINEDO', 'VINAS', 'CASA', 'CERVECERIA', 'FINCA'])

/**
 * Prefijo del código de lote al activarse la bodega (ORG-05): 3 letras derivadas del nombre
 * comercial (iniciales de las palabras significativas, completadas con letras de la última), o el
 * código fijo del catálogo si la bodega ya lo tiene. Si está tomado se alarga hasta 5 letras y,
 * como último recurso, se cambia la última letra. Nunca cambia después.
 */
export function deriveLotPrefix(wineryId: string, tradeName: string, taken: ReadonlySet<string>): string {
  const known = WINERY_CODES_BY_ID[wineryId]
  if (known && !taken.has(known)) return known
  const words = tradeName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean)
  const significant = words.filter((w) => !STOPWORDS.has(w) && !GENERIC.has(w))
  const pool = significant.length ? significant : words.length ? words : ['DOC']
  const last = pool[pool.length - 1]!
  let base = pool.length === 1 ? last.slice(0, 3) : pool.map((w) => w[0]).join('').slice(0, 3)
  for (let i = 1; base.length < 3 && i < last.length; i++) base += last[i]
  base = base.padEnd(3, 'X')
  const letters = pool.join('')
  const candidates = [base]
  for (let len = 4; len <= 5; len++) candidates.push((base + letters.slice(3)).slice(0, len))
  for (const c of candidates) if (/^[A-Z]{3,5}$/.test(c) && !taken.has(c)) return c
  for (let code = 65; code <= 90; code++) {
    const c = base.slice(0, 2) + String.fromCharCode(code)
    if (!taken.has(c)) return c
  }
  throw new Error(`No hay prefijo de lote libre para ${tradeName}`)
}

export interface WineryDetailSources {
  users: readonly MockUser[]
  invitations: readonly StoredInvitation[]
  nowIso: string
}

/** Dueño: el miembro `OWNER` activo; si no hay, la invitación de dueño pendiente. */
function ownerOf(winery: WineryResponse, src: WineryDetailSources): WineryDetail['owner'] {
  const member = winery.members?.find((m) => m.memberRole === 'OWNER' && m.isActive)
  if (member) return { userId: member.userId, fullName: member.fullName, email: member.email }
  const invited = src.invitations.find(
    (i) =>
      i.organizationId === winery.id &&
      i.role === 'OWNER' &&
      i._mock.transfer === null &&
      ['PENDING', 'EXPIRED'].includes(effectiveInvitationStatus(i, src.nowIso)),
  )
  if (invited) return { userId: null, fullName: invited._mock.inviteeName ?? invited.email, email: invited.email }
  const any = winery.members?.find((m) => m.memberRole === 'OWNER')
  return any ? { userId: any.userId, fullName: any.fullName, email: any.email } : null
}

/** Ficha de la bodega (`WineryDetail`) a partir del DTO del ERP y de su perfil de la Ola 1. */
export function buildWineryDetail(winery: WineryResponse, profile: WineryProfile, src: WineryDetailSources): WineryDetail {
  return {
    id: winery.id,
    slug: profile.slug,
    legalName: winery.legalName,
    tradeName: winery.commercialName,
    taxId: winery.taxIdNit,
    category: winery.beverageCategory,
    region: winery.geographicRegion,
    status: winery.certificationStatus,
    lotPrefix: profile.lotPrefix,
    owner: ownerOf(winery, src),
    membersCount: (winery.members ?? []).filter((m) => m.isActive).length,
    createdAt: winery.createdAt,
    activatedAt: profile.activatedAt,
    address: winery.address ?? null,
    senasagRegistration: winery.senasagSanitaryReg ?? null,
    contactEmail: winery.contactEmail,
    contactPhone: winery.contactPhone ?? null,
    logoUrl: winery.logoUrl ?? null,
    publicStory: profile.publicStory,
    website: profile.website,
    statusHistory: profile.statusHistory,
  }
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export type SettingValueError = { code: 'VALIDATION_ERROR' | 'SETTING_BELOW_LEGAL_MINIMUM'; message: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Valida tipo, límites y enumeración de un valor. `null` si es válido. */
export function validateSettingValue(entry: SettingCatalogEntry, value: unknown): string | null {
  const range = (n: number): string | null => {
    if (entry.min !== undefined && n < entry.min) return `Debe ser mayor o igual que ${entry.min}`
    if (entry.max !== undefined && n > entry.max) return `Debe ser menor o igual que ${entry.max}`
    return null
  }
  switch (entry.type) {
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value) ? range(value) : 'Debe ser un número'
    case 'NUMBER_OR_UNLIMITED':
      if (value === null) return null
      return typeof value === 'number' && Number.isFinite(value) ? range(value) : 'Debe ser un número o null (ilimitado)'
    case 'BOOLEAN':
      return typeof value === 'boolean' ? null : 'Debe ser sí o no (boolean)'
    case 'STRING':
      return typeof value === 'string' ? null : 'Debe ser un texto'
    case 'LIST':
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim().length > 0)
        ? null
        : 'Debe ser una lista de textos no vacía'
    case 'OBJECT':
      return value === null || isPlainObject(value) ? null : 'Debe ser un objeto'
    case 'ENUM':
      return typeof value === 'string' && (entry.enumValues ?? []).includes(value)
        ? null
        : `Debe ser uno de: ${(entry.enumValues ?? []).join(', ')}`
  }
}

/** ¿Es el valor más laxo que el mínimo legal (A-31)? */
export function isBelowLegalMinimum(entry: SettingCatalogEntry, value: unknown): boolean {
  const floor = entry.legalMinimum
  if (floor === undefined || floor === null) return false
  if (typeof floor === 'number') return typeof value === 'number' && value < floor
  return Array.isArray(value) && value.some((v) => !floor.includes(v as string))
}

/** Definiciones completas (`GET /v1/platform/settings`). */
export function buildSettingDefinitions(globals: readonly StoredSetting[], overrides: readonly StoredOverride[]): SettingDefinition[] {
  return SETTINGS_CATALOG.map((entry) => {
    const stored = globals.find((g) => g.key === entry.key)
    const def: SettingDefinition = {
      key: entry.key,
      description: entry.description,
      type: entry.type,
      ...(entry.enumValues ? { enumValues: entry.enumValues } : {}),
      ...(entry.unit ? { unit: entry.unit } : {}),
      levels: entry.levels,
      appliesAt: entry.appliesAt,
      default: entry.default,
      ...(entry.min !== undefined ? { min: entry.min } : {}),
      ...(entry.max !== undefined ? { max: entry.max } : {}),
      legalMinimum: entry.legalMinimum ?? null,
      globalValue: stored ? stored.value : entry.default,
      overridesCount: overrides.filter((o) => o.key === entry.key).length,
      updatedAt: stored?.updatedAt ?? '2026-01-05T00:00:00Z',
      updatedBy: stored?.updatedBy ?? null,
    }
    return def
  })
}

export function toSettingOverride(o: StoredOverride, wineryName: string): SettingOverride {
  return {
    wineryId: o.wineryId,
    wineryName,
    value: o.value,
    legalException: o.legalException,
    reason: o.reason,
    updatedAt: o.updatedAt,
    updatedBy: o.updatedBy,
  }
}

// ---------------------------------------------------------------------------
// Bitácora encadenada
// ---------------------------------------------------------------------------

export type AuditInput = Omit<AuditEvent, 'id' | 'seq' | 'hash' | 'prevHash'>

/** `hash` de un evento: SHA-256 del JSON canónico del evento sin `hash` (incluye `prevHash`). */
export function auditHash(event: Omit<AuditEvent, 'hash'>): string {
  return sha256Hex(canonicalJson(event))
}

/** Crea el siguiente evento de la cadena. */
export function chainAuditEvent(previous: AuditEvent | undefined, input: AuditInput, id: string): AuditEvent {
  const body: Omit<AuditEvent, 'hash'> = {
    id,
    seq: (previous?.seq ?? 0) + 1,
    ...input,
    prevHash: previous?.hash ?? null,
  }
  return { ...body, hash: auditHash(body) }
}

/**
 * Comprueba la cadena (en orden de `seq`): cada `hash` recalculado y cada `prevHash` igual al
 * `hash` del evento anterior. Con `range` solo cuenta los eventos de ese intervalo de fechas.
 */
export function verifyAuditChain(
  events: readonly AuditEvent[],
  range: { from?: number; to?: number } = {},
): { valid: boolean; checked: number; firstBrokenSeq: number | null } {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  let checked = 0
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i]!
    const at = Date.parse(ev.occurredAt)
    if ((range.from !== undefined && at < range.from) || (range.to !== undefined && at > range.to)) continue
    checked++
    const { hash, ...rest } = ev
    const expectedPrev = i === 0 ? null : sorted[i - 1]!.hash
    if (auditHash(rest) !== hash || ev.prevHash !== expectedPrev) {
      return { valid: false, checked, firstBrokenSeq: ev.seq }
    }
  }
  return { valid: true, checked, firstBrokenSeq: null }
}
