import { PLATFORM_ORGANIZATION } from '../../erp/catalog'
import { membershipsOf, type AuthContext } from '../../erp/handlers/auth-context'
import { getErpDb, newId, nowStamp, tick, type BackofficeState } from '../../erp/handlers/db'
import { ApiError, domainError } from '../../erp/handlers/errors'
import type { RouteContext } from '../../erp/handlers/http'
import { DEFAULT_NOTIFICATION_PREFS, type MockUser, type NotificationPrefs, type WineryResponse } from '../../erp/schemas'
import { DEFAULT_APP_URLS, renderEmail, type AppUrls, type MailDraft } from '../mail'
import {
  buildWineryDetail,
  chainAuditEvent,
  deriveLotPrefix,
  uniqueSlug,
  type AuditInput,
  type WineryProfile,
} from '../model'
import { CLIENT_APPS, type AuditEvent, type ClientApp, type MailTemplate, type MockEmail, type WineryDetail } from '../schemas'
import { settingEntry } from '../settings-catalog'

// Utilidades comunes de los handlers de la Ola 1: estado, reloj, buzón, bitácora, bodegas y
// configuración efectiva.

export const bo = (): BackofficeState => getErpDb().backoffice

/** Marca de tiempo de una escritura (avanza el reloj un minuto). */
export const stamp = (): string => tick()
/** Instante actual del reloj de los mocks, sin avanzarlo. */
export const now = (): string => nowStamp()
export const nowMs = (): number => getErpDb().clock

export const SYSTEM_NAME = 'Sistema'

// ---------------------------------------------------------------------------
// URLs de las apps y buzón simulado
// ---------------------------------------------------------------------------

let appUrls: AppUrls = { ...DEFAULT_APP_URLS }

/** Cambia las URL base de las apps en los enlaces de los correos (p. ej. las de Vercel). */
export function setMockAppUrls(urls: Partial<AppUrls>): void {
  appUrls = { ...appUrls, ...Object.fromEntries(Object.entries(urls).filter(([, v]) => Boolean(v))) }
}

export function getMockAppUrls(): AppUrls {
  return { ...appUrls }
}

/** "Envía" un correo: lo guarda en el buzón simulado. */
export function sendMail(draft: MailDraft): MockEmail {
  const email = renderEmail(draft, newId('email'), now(), appUrls)
  bo().mailbox.push(email)
  return email
}

export interface MailboxFilter {
  to?: string
  template?: MailTemplate
  /** Solo los enviados a partir de este instante ISO. */
  since?: string
}

function matches(e: MockEmail, f: MailboxFilter): boolean {
  return (
    (!f.to || e.to.toLowerCase() === f.to.toLowerCase()) &&
    (!f.template || e.template === f.template) &&
    (!f.since || e.createdAt >= f.since)
  )
}

/**
 * Buzón simulado (como Mailpit): los correos que el backend enviaría. Lo usan el panel `/__mocks`
 * de cada app y las e2e para leer enlaces y tokens. Los más recientes primero.
 */
export const mockMailbox = {
  list(filter: MailboxFilter = {}): MockEmail[] {
    return bo()
      .mailbox.filter((e) => matches(e, filter))
      .slice()
      .reverse()
  },
  latest(filter: MailboxFilter = {}): MockEmail | null {
    return this.list(filter)[0] ?? null
  },
  clear(): void {
    bo().mailbox = []
  },
}

// ---------------------------------------------------------------------------
// Bitácora
// ---------------------------------------------------------------------------

export interface AuditEntry {
  action: string
  resource: { type: string; id: string | null }
  organizationId: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  reason?: string | null
  /** Actor explícito (p. ej. la persona que acaba de crear su cuenta); por defecto, la sesión. */
  actor?: AuditInput['actor']
}

/** Actor de la sesión (o `null` = sistema/público). */
export function actorOf(auth: AuthContext | null): AuditInput['actor'] {
  if (!auth) return { userId: null, fullName: null, role: null, organizationId: null, viaPlatform: false }
  return {
    userId: auth.user.id,
    fullName: auth.user.fullName,
    role: auth.membershipRole,
    organizationId: auth.organizationId,
    viaPlatform: auth.organizationType === 'PLATFORM',
  }
}

/** Actor de una persona concreta en una organización. */
export function personActor(user: MockUser, role: string | null, organizationId: string | null): AuditInput['actor'] {
  return { userId: user.id, fullName: user.fullName, role, organizationId, viaPlatform: organizationId === PLATFORM_ORGANIZATION.id }
}

/** App de origen: la cabecera `X-Client-App` si es válida; si no, `PUBLIC` en rutas públicas sin sesión o `API`. */
export function sourceApp(ctx: RouteContext | null): ClientApp {
  const header = ctx?.clientApp?.trim().toUpperCase()
  if (header && (CLIENT_APPS as readonly string[]).includes(header)) return header as ClientApp
  if (!ctx) return 'WORKER'
  return ctx.isPublic && !ctx.optionalAuth ? 'PUBLIC' : 'API'
}

/** Añade un evento encadenado a la bitácora (toda escritura de los mocks deja uno). */
export function recordAudit(ctx: RouteContext | null, entry: AuditEntry): AuditEvent {
  const state = bo()
  const input: AuditInput = {
    occurredAt: now(),
    actor: entry.actor ?? actorOf(ctx?.optionalAuth ?? null),
    source: {
      app: sourceApp(ctx),
      ip: ctx?.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
      deviceId: ctx?.request.headers.get('x-device-id') || null,
    },
    action: entry.action,
    resource: entry.resource,
    organizationId: entry.organizationId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    correlationId: ctx?.correlationId ?? null,
  }
  const event = chainAuditEvent(state.audit.at(-1), input, newId('audit'))
  state.audit.push(event)
  return event
}

// ---------------------------------------------------------------------------
// Bodegas
// ---------------------------------------------------------------------------

export function findWinery(id: string): WineryResponse {
  const w = getErpDb().wineries.find((x) => x.id === id)
  // Como el backend: bodega inexistente → 404 `ORG_NOT_FOUND`.
  if (!w) throw domainError(404, 'ORG_NOT_FOUND', 'Organización no encontrada')
  return w
}

/** Perfil de la Ola 1 de una bodega; lo crea si falta (bodegas creadas por rutas del ERP). */
export function profileOf(winery: WineryResponse): WineryProfile {
  const state = bo()
  let profile = state.profiles.find((p) => p.wineryId === winery.id)
  if (!profile) {
    profile = {
      wineryId: winery.id,
      slug: uniqueSlug(winery.commercialName, new Set(state.profiles.map((p) => p.slug))),
      lotPrefix: null,
      publicStory: null,
      website: null,
      activatedAt: winery.approvedAt ?? null,
      statusHistory: [{ status: winery.certificationStatus, at: winery.createdAt, by: SYSTEM_NAME, reason: null }],
    }
    state.profiles.push(profile)
  }
  // Una bodega activada por la ruta del ERP (`/v1/wineries/:id/approve`) recibe su prefijo.
  if (!profile.lotPrefix && (winery.certificationStatus === 'ACTIVE' || winery.certificationStatus === 'SUSPENDED')) {
    profile.lotPrefix = deriveLotPrefix(winery.id, winery.commercialName, takenLotPrefixes())
    profile.activatedAt ??= winery.approvedAt ?? now()
  }
  return profile
}

export function takenLotPrefixes(): Set<string> {
  return new Set(bo().profiles.map((p) => p.lotPrefix).filter((p): p is string => Boolean(p)))
}

/** Prefijo de lote de una bodega (para el código de lote del embotellado), si lo tiene. */
export function lotPrefixOf(wineryId: string): string | null {
  return bo().profiles.find((p) => p.wineryId === wineryId)?.lotPrefix ?? null
}

export function wineryDetail(winery: WineryResponse): WineryDetail {
  return buildWineryDetail(winery, profileOf(winery), { users: getErpDb().users, invitations: bo().invitations, nowIso: now() })
}

/** Cambia el estado de la bodega, lo anota en su historial y en la bitácora. */
export function setWineryStatus(
  ctx: RouteContext | null,
  winery: WineryResponse,
  status: WineryResponse['certificationStatus'],
  opts: { by: string; reason: string | null; action: string; actor?: AuditInput['actor']; after?: Record<string, unknown> },
): void {
  const before = winery.certificationStatus
  const profile = profileOf(winery)
  const at = stamp()
  winery.certificationStatus = status
  profile.statusHistory.push({ status, at, by: opts.by, reason: opts.reason })
  recordAudit(ctx, {
    action: opts.action,
    resource: { type: 'winery', id: winery.id },
    organizationId: winery.id,
    before: { status: before },
    after: { status, ...opts.after },
    reason: opts.reason,
    actor: opts.actor,
  })
}

/**
 * Activación (ORG-05): al aceptar el dueño la invitación, la bodega pasa a `ACTIVE` y recibe su
 * prefijo de lote (único y definitivo). El evento `winery.activated` del outbox queda en la bitácora.
 */
export function activateWinery(ctx: RouteContext | null, winery: WineryResponse, owner: MockUser): void {
  const profile = profileOf(winery)
  profile.lotPrefix ??= deriveLotPrefix(winery.id, winery.commercialName, takenLotPrefixes())
  setWineryStatus(ctx, winery, 'ACTIVE', {
    by: owner.fullName,
    reason: null,
    action: 'WINERY_ACTIVATED',
    actor: personActor(owner, 'OWNER', winery.id),
    after: { lotPrefix: profile.lotPrefix, event: 'winery.activated' },
  })
  profile.activatedAt = now()
  winery.approvedAt ??= profile.activatedAt
}

/** Correo del dueño activo de una bodega (avisos EQP-10 y cambios de estado). */
export function ownerEmailOf(winery: WineryResponse): string | null {
  return winery.members?.find((m) => m.memberRole === 'OWNER' && m.isActive)?.email ?? null
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export function findUser(id: string): MockUser | undefined {
  return getErpDb().users.find((u) => u.id === id)
}

/** ¿Tiene la persona una membresía de plataforma activa? (exige TOTP al iniciar sesión). */
export function hasActivePlatformMembership(user: MockUser): boolean {
  return membershipsOf(user).some((m) => m.organizationType === 'PLATFORM' && m.status === 'ACTIVE')
}

export function prefsOf(userId: string): { notificationPrefs: NotificationPrefs; promotionsConsent: boolean } {
  return bo().prefs[userId] ?? { notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS }, promotionsConsent: false }
}

// ---------------------------------------------------------------------------
// Configuración efectiva
// ---------------------------------------------------------------------------

/** Valor efectivo de un parámetro para una bodega (ajuste de la bodega → estándar general). */
export function effectiveSetting(key: string, wineryId: string | null = null): { value: unknown; source: 'GLOBAL' | 'WINERY' } {
  const state = bo()
  const override = wineryId ? state.overrides.find((o) => o.key === key && o.wineryId === wineryId) : undefined
  if (override) return { value: override.value, source: 'WINERY' }
  const global = state.settings.find((s) => s.key === key)
  return { value: global ? global.value : settingEntry(key)?.default, source: 'GLOBAL' }
}

/** Horas de caducidad de las invitaciones (`invitacion.caducidadHoras`). */
export function invitationTtlHours(): number {
  const v = effectiveSetting('invitacion.caducidadHoras').value
  return typeof v === 'number' ? v : 72
}

// ---------------------------------------------------------------------------
// Captcha y contraseñas
// ---------------------------------------------------------------------------

/** Turnstile simulado: vale cualquier token salvo el que contenga `fail`. */
export function checkCaptcha(token: string): void {
  if (/fail/i.test(token)) throw domainError(422, 'CAPTCHA_INVALID', 'No se pudo verificar el captcha', 'captchaToken')
}

const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  '0123456789',
  'password123',
  'password1234',
  'contraseña',
  'contrasena123',
  'qwertyuiop',
  'drinksonchain',
  'demo123456',
  'aaaaaaaaaa',
  'iloveyou123',
])

/** Política de contraseñas nuevas (contrato de la Ola 1 §1): ≥ 10 caracteres y no común. */
export function checkPassword(password: string, field = 'password'): void {
  const problems: string[] = []
  if (password.length < 10) problems.push('Debe tener al menos 10 caracteres')
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) problems.push('Es una contraseña demasiado común')
  if (problems.length) {
    throw new ApiError(
      422,
      'AUTH_WEAK_PASSWORD',
      'La contraseña no cumple la política',
      problems.map((message) => ({ field, message })),
    )
  }
}
