import { findUserById, anyUser } from '../../erp/handlers/auth-context'
import { nextSeq } from '../../erp/handlers/db'
import { ApiError, domainError } from '../../erp/handlers/errors'
import { accepted, noContent, ok, parseBody, type RouteContext, type RouteSpec } from '../../erp/handlers/http'
import { findUserByEmail, openSession, sessionResult } from '../../erp/handlers/routes/auth-users'
import { revokeAllSessions } from '../../erp/handlers/sessions'
import type { MockUser, NotificationPrefs } from '../../erp/schemas'
import { sha256Hex } from '../../shared/crypto'
import { DEMO_TOTP_SECRET, MOCK_TOTP_BYPASS_CODE, otpauthUrl, verifyTotp } from '../../shared/totp'
import { emailVerifyMail, passwordResetMail, simpleMail } from '../mail'
import type { StaffMfa } from '../model'
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  MfaCodeSchema,
  MfaTokenSchema,
  ResendVerificationSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
  type MailApp,
  type MfaChallenge,
} from '../schemas'
import {
  bo,
  checkCaptcha,
  checkPassword,
  hasActivePlatformMembership,
  now,
  nowMs,
  personActor,
  prefsOf,
  recordAudit,
  sendMail,
  sourceApp,
} from './support'
import { PLATFORM_ORGANIZATION } from '../../erp/catalog'

// Cuenta e identidad (contrato de la Ola 1 §1): segundo factor del personal de plataforma,
// recuperación y cambio de contraseña, verificación del correo y preferencias.

const MFA_TOKEN_TTL_MS = 5 * 60_000
const RESET_TOKEN_TTL_MS = 60 * 60_000
const MAX_MFA_FAILURES = 5

/** Token opaco determinista (`<prefijo>_<24 hex>`). */
function opaqueToken(prefix: string, seed: string): string {
  return `${prefix}_${sha256Hex(`${prefix}:${seed}:${nextSeq(`token-${prefix}`)}`).slice(0, 24)}`
}

// ---------------------------------------------------------------------------
// Segundo factor (TOTP)
// ---------------------------------------------------------------------------

export function mfaOf(userId: string): StaffMfa | undefined {
  return bo().mfa.find((m) => m.userId === userId)
}

/** ¿Debe pasar el TOTP al iniciar sesión? (membresía de plataforma activa). */
export function needsMfa(user: MockUser): boolean {
  return hasActivePlatformMembership(user)
}

/** Respuesta de login sin tokens: `{ mfa: { required, enrolled, mfaToken } }` (5 min, un solo uso). */
export function startMfaChallenge(user: MockUser): MfaChallenge {
  const token = opaqueToken('mfa', user.id)
  bo().mfaTokens[token] = { userId: user.id, expiresAt: nowMs() + MFA_TOKEN_TTL_MS, secret: null }
  return { mfa: { required: true, enrolled: Boolean(mfaOf(user.id)?.enrolled), mfaToken: token } }
}

function takeMfaToken(token: string): { user: MockUser; entry: { userId: string; expiresAt: number; secret: string | null } } {
  const entry = bo().mfaTokens[token]
  const user = entry ? findUserById(entry.userId) : undefined
  if (!entry || !user || entry.expiresAt <= nowMs() || !user.isActive) {
    if (entry) delete bo().mfaTokens[token]
    throw domainError(401, 'AUTH_MFA_TOKEN_INVALID', 'El reto de segundo factor caducó o no es válido: inicia sesión de nuevo')
  }
  return { user, entry }
}

/** Un código fallido: 5 seguidos → 429 y aviso por correo; si no, 401. */
function mfaFailure(ctx: RouteContext, token: string, user: MockUser): never {
  const state = bo()
  const failures = (state.mfaFailures[user.id] ?? 0) + 1
  recordAudit(ctx, {
    action: 'MFA_FAILED',
    resource: { type: 'user', id: user.id },
    organizationId: PLATFORM_ORGANIZATION.id,
    after: { failures },
    actor: personActor(user, null, null),
  })
  if (failures >= MAX_MFA_FAILURES) {
    delete state.mfaTokens[token]
    state.mfaFailures[user.id] = 0
    sendMail(
      simpleMail(user.email, 'MFA_FAILED_ATTEMPTS', 'Intentos fallidos de segundo factor', [
        `Hubo ${MAX_MFA_FAILURES} códigos de verificación incorrectos seguidos en tu cuenta.`,
        'Si no fuiste tú, cambia tu contraseña y avisa al equipo de Drinks on Chain.',
      ]),
    )
    throw new ApiError(429, 'AUTH_TOO_MANY_ATTEMPTS', 'Demasiados códigos incorrectos: inicia sesión de nuevo en unos minutos', null, {
      'Retry-After': '300',
    })
  }
  state.mfaFailures[user.id] = failures
  throw domainError(401, 'AUTH_MFA_INVALID_CODE', 'El código no es válido')
}

/** ¿Es un código TOTP válido (hora real ± 30 s) o el atajo de los mocks `000000`? */
function totpOk(secret: string, code: string): boolean {
  return code === MOCK_TOTP_BYPASS_CODE || verifyTotp(secret, code)
}

/** Códigos de recuperación nuevos (10, `XXXX-XXXX`). */
function newRecoveryCodes(userId: string): string[] {
  const n = nextSeq('recovery-codes')
  return Array.from({ length: 10 }, (_, i) => {
    const h = sha256Hex(`recovery:${userId}:${n}:${i}`).slice(0, 8).toUpperCase()
    return `${h.slice(0, 4)}-${h.slice(4)}`
  })
}

function mfaSuccess(ctx: RouteContext, token: string, user: MockUser, extra: Record<string, unknown> = {}) {
  const state = bo()
  delete state.mfaTokens[token]
  state.mfaFailures[user.id] = 0
  recordLogin(ctx, user, true)
  return sessionResult(user, openSession(user, { mfa: true }), ctx.url, 200, extra)
}

// ---------------------------------------------------------------------------
// Bitácora de sesión y perfil (las usan las rutas de /v1/auth y /v1/users/me)
// ---------------------------------------------------------------------------

export function recordLogin(ctx: RouteContext, user: MockUser, mfa: boolean): void {
  recordAudit(ctx, {
    action: 'AUTH_LOGIN_SUCCEEDED',
    resource: { type: 'user', id: user.id },
    organizationId: mfa ? PLATFORM_ORGANIZATION.id : null,
    after: { mfa },
    actor: personActor(user, null, null),
  })
}

export function recordLoginFailure(ctx: RouteContext, user: MockUser): void {
  recordAudit(ctx, {
    action: 'AUTH_LOGIN_FAILED',
    resource: { type: 'user', id: user.id },
    organizationId: null,
    actor: { userId: user.id, fullName: user.fullName, role: null, organizationId: null, viaPlatform: false },
  })
}

export function updatePrefs(userId: string, prefs: Partial<NotificationPrefs> | undefined, promotionsConsent: boolean | undefined): void {
  if (prefs === undefined && promotionsConsent === undefined) return
  const current = prefsOf(userId)
  bo().prefs[userId] = {
    notificationPrefs: { ...current.notificationPrefs, ...prefs },
    promotionsConsent: promotionsConsent ?? current.promotionsConsent,
  }
}

export function recordProfileUpdate(ctx: RouteContext, before: Record<string, unknown>): void {
  const user = ctx.auth.user
  recordAudit(ctx, {
    action: 'USER_PROFILE_UPDATED',
    resource: { type: 'user', id: user.id },
    organizationId: null,
    before,
    after: { fullName: user.fullName, preferredLocale: user.preferredLocale, ...prefsOf(user.id) },
  })
}

/** App a la que lleva el enlace de recuperación: la que pidió el correo (`X-Client-App`). */
function mailAppFor(ctx: RouteContext): MailApp {
  const app = sourceApp(ctx)
  return app === 'BACKOFFICE' || app === 'MARKETPLACE' || app === 'POS' ? app : 'ERP'
}

/** Crea un enlace de recuperación y lo "envía" (también lo usa el back office). */
export function issuePasswordReset(ctx: RouteContext, user: MockUser, app: MailApp): void {
  const token = opaqueToken('rst', user.id)
  bo().resetTokens[token] = { userId: user.id, expiresAt: nowMs() + RESET_TOKEN_TTL_MS, usedAt: null }
  sendMail(passwordResetMail({ to: user.email, token, app }))
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

export const identityRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/auth/mfa/enroll',
    access: 'public',
    async handle({ request }) {
      const body = await parseBody(request, MfaTokenSchema)
      const { user, entry } = takeMfaToken(body.mfaToken)
      if (mfaOf(user.id)?.enrolled) throw domainError(409, 'AUTH_MFA_ALREADY_ENROLLED', 'El segundo factor ya está inscrito: usa /v1/auth/mfa/verify')
      // En los mocks el secreto es siempre el de demo, para que las e2e puedan generar códigos.
      entry.secret = DEMO_TOTP_SECRET
      return ok({ otpauthUrl: otpauthUrl(DEMO_TOTP_SECRET, user.email), secret: DEMO_TOTP_SECRET })
    },
  },
  {
    method: 'post',
    path: '/v1/auth/mfa/enroll/confirm',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, MfaCodeSchema)
      const { user, entry } = takeMfaToken(body.mfaToken)
      if (mfaOf(user.id)?.enrolled) throw domainError(409, 'AUTH_MFA_ALREADY_ENROLLED', 'El segundo factor ya está inscrito: usa /v1/auth/mfa/verify')
      if (!entry.secret) throw domainError(409, 'AUTH_MFA_ENROLLMENT_NOT_STARTED', 'Primero hay que pedir el secreto con /v1/auth/mfa/enroll')
      if (!totpOk(entry.secret, body.code)) mfaFailure(ctx, body.mfaToken, user)
      const recoveryCodes = newRecoveryCodes(user.id)
      const state = bo()
      const record: StaffMfa = { userId: user.id, enrolled: true, secret: entry.secret, enrolledAt: now(), recoveryCodes }
      state.mfa = [...state.mfa.filter((m) => m.userId !== user.id), record]
      recordAudit(ctx, {
        action: 'MFA_ENROLLED',
        resource: { type: 'user', id: user.id },
        organizationId: PLATFORM_ORGANIZATION.id,
        actor: personActor(user, null, null),
      })
      return mfaSuccess(ctx, body.mfaToken, user, { recoveryCodes })
    },
  },
  {
    method: 'post',
    path: '/v1/auth/mfa/verify',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, MfaCodeSchema)
      const { user } = takeMfaToken(body.mfaToken)
      const mfa = mfaOf(user.id)
      if (!mfa?.enrolled || !mfa.secret) throw domainError(409, 'AUTH_MFA_NOT_ENROLLED', 'El segundo factor no está inscrito: usa /v1/auth/mfa/enroll')
      const code = body.code.trim().toUpperCase()
      const recovery = mfa.recoveryCodes.indexOf(code)
      if (recovery >= 0) {
        mfa.recoveryCodes.splice(recovery, 1)
        recordAudit(ctx, {
          action: 'MFA_RECOVERY_CODE_USED',
          resource: { type: 'user', id: user.id },
          organizationId: PLATFORM_ORGANIZATION.id,
          after: { remaining: mfa.recoveryCodes.length },
          actor: personActor(user, null, null),
        })
      } else if (!totpOk(mfa.secret, code)) {
        mfaFailure(ctx, body.mfaToken, user)
      }
      return mfaSuccess(ctx, body.mfaToken, user)
    },
  },
  {
    method: 'post',
    path: '/v1/auth/forgot-password',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, ForgotPasswordSchema)
      checkCaptcha(body.captchaToken)
      if (body.website?.trim()) return accepted() // campo trampa relleno: 202 sin hacer nada
      const user = findUserByEmail(body.email)
      // 202 siempre: no se revela si el correo tiene cuenta.
      if (user?.isActive) {
        issuePasswordReset(ctx, user, mailAppFor(ctx))
        recordAudit(ctx, {
          action: 'USER_PASSWORD_RESET_REQUESTED',
          resource: { type: 'user', id: user.id },
          organizationId: null,
          actor: { userId: null, fullName: null, role: null, organizationId: null, viaPlatform: false },
        })
      }
      return accepted()
    },
  },
  {
    method: 'post',
    path: '/v1/auth/reset-password',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, ResetPasswordSchema)
      const entry = bo().resetTokens[body.token]
      const user = entry ? findUserById(entry.userId) : undefined
      if (!entry || !user || entry.usedAt || entry.expiresAt <= nowMs()) {
        throw domainError(422, 'AUTH_RESET_TOKEN_INVALID', 'El enlace de recuperación no es válido o caducó', 'token')
      }
      checkPassword(body.password)
      user._mock.password = body.password
      entry.usedAt = now()
      revokeAllSessions(user.id)
      sendMail(simpleMail(user.email, 'PASSWORD_CHANGED', 'Tu contraseña cambió', ['La contraseña de tu cuenta se cambió.', 'Si no fuiste tú, avisa al equipo de Drinks on Chain.']))
      recordAudit(ctx, { action: 'USER_PASSWORD_RESET', resource: { type: 'user', id: user.id }, organizationId: null, actor: personActor(user, null, null) })
      return noContent()
    },
  },
  {
    method: 'post',
    path: '/v1/auth/verify-email',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, VerifyEmailSchema)
      const entry = bo().emailTokens[body.token]
      const user = entry ? findUserById(entry.userId) : undefined
      if (!entry || !user || entry.usedAt) {
        throw domainError(422, 'AUTH_EMAIL_TOKEN_INVALID', 'El enlace de verificación no es válido o ya se usó', 'token')
      }
      entry.usedAt = now()
      // Alta del borrador de la Etapa 4: `GET /v1/me/consumer` pasa a `emailVerified: true`.
      if (bo().emailUnverified) delete bo().emailUnverified![user.id]
      recordAudit(ctx, { action: 'USER_EMAIL_VERIFIED', resource: { type: 'user', id: user.id }, organizationId: null, actor: personActor(user, null, null) })
      return noContent()
    },
  },
  {
    method: 'post',
    path: '/v1/auth/resend-verification',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, ResendVerificationSchema)
      checkCaptcha(body.captchaToken)
      if (body.website?.trim()) return accepted() // campo trampa relleno: 202 sin hacer nada
      const user = findUserByEmail(body.email)
      if (user?.isActive) {
        const token = opaqueToken('vfy', user.id)
        bo().emailTokens[token] = { userId: user.id, usedAt: null }
        sendMail(emailVerifyMail({ to: user.email, token, app: sourceApp(ctx) === 'MARKETPLACE' ? 'MARKETPLACE' : 'ERP' }))
      }
      return accepted()
    },
  },
  {
    method: 'post',
    path: '/v1/users/me/password',
    access: anyUser,
    async handle(ctx) {
      const body = await parseBody(ctx.request, ChangePasswordSchema)
      const user = ctx.auth.user
      if (user._mock.password !== body.currentPassword) {
        throw domainError(422, 'AUTH_INVALID_CURRENT_PASSWORD', 'La contraseña actual no es correcta', 'currentPassword')
      }
      checkPassword(body.newPassword, 'newPassword')
      user._mock.password = body.newPassword
      revokeAllSessions(user.id, ctx.auth.sid)
      sendMail(simpleMail(user.email, 'PASSWORD_CHANGED', 'Tu contraseña cambió', ['La contraseña de tu cuenta se cambió.', 'Si no fuiste tú, avisa al equipo de Drinks on Chain.']))
      recordAudit(ctx, { action: 'USER_PASSWORD_CHANGED', resource: { type: 'user', id: user.id }, organizationId: null })
      return noContent()
    },
  },
]
