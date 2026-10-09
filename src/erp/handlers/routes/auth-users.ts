import { consumerAddressOf } from '../../../marketplace/handlers'
import {
  needsMfa,
  recordLogin,
  recordLoginFailure,
  recordProfileUpdate,
  startMfaChallenge,
  updatePrefs,
} from '../../../backoffice/handlers/identity'
import { prefsOf } from '../../../backoffice/handlers/support'
import { fakeStellarAddress } from '../../../shared/uuid'
import { buildSessionResponse, isUsableMembership } from '../../derive'
import {
  LoginSchema,
  SignupSchema,
  SwitchOrganizationSchema,
  UpdateUserSchema,
  type MeResponse,
  type MockUser,
  type SessionResponse,
  type UserProfileResponse,
  type WalletResponse,
} from '../../schemas'
import {
  anyUser,
  contextFor,
  defaultOrganizationId,
  findUserById,
  findUserByKey,
  membershipsOf,
  REFRESH_TOKEN_PREFIX,
  type AuthContext,
} from '../auth-context'
import { getErpDb, newId, nextSeq, tick } from '../db'
import {
  ApiError,
  conflict,
  fieldError,
  invalid,
  invalidCredentials,
  refreshInvalid,
  refreshReused,
  sessionExpired,
  sessionRevoked,
  tooManyAttempts,
} from '../errors'
import { applyPatch, noContent, ok, parseBody, readJson, validate, type RouteResult, type RouteSpec } from '../http'
import {
  clearRefreshCookie,
  createSession,
  decodeAccessToken,
  getSession,
  loginLockedFor,
  matchRefresh,
  parseRefreshToken,
  readCookieJar,
  recordLoginFailureAttempt,
  recordLoginSuccessAttempt,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
  refreshCookie,
  rememberAccessToken,
  rememberOrganization,
  revokeAllSessions,
  revokeSession,
  rotateRefresh,
  sessionOfRefresh,
  setActiveOrganization,
  signAccessToken,
  tokensFor,
  withinGrace,
  writeCookieJar,
  type MockSession,
} from '../sessions'

// /v1/auth/* y /v1/users/me* (contrato de la Ola 0 §5)

/** Perfil sin los metadatos `_mock`. */
export function toProfile(user: MockUser): UserProfileResponse {
  const profile: Partial<MockUser> = { ...user }
  delete profile._mock
  return profile as UserProfileResponse
}

export function findUserByEmail(email: string): MockUser | undefined {
  const needle = email.trim().toLowerCase()
  return getErpDb().users.find((u) => u.email.toLowerCase() === needle)
}

/** Crea usuario + billetera custodial (signup de consumidores e invitación aceptada con cuenta nueva). */
export function createUser(input: {
  email: string
  password: string
  fullName: string
  phoneNumber?: string | null
  preferredLocale?: string | null
  wineryId?: string | null
}): MockUser {
  const db = getErpDb()
  const at = tick()
  const key = `user_${nextSeq('user-key')}`
  const id = newId('user')
  const wallet: WalletResponse = {
    id: newId('wallet'),
    userId: id,
    wineryId: input.wineryId ?? null,
    stellarPublicAddress: fakeStellarAddress(`user-wallet:${id}`),
    walletType: 'CUSTODIAL',
    walletPurpose: input.wineryId ? 'PRODUCER_SIGNING' : 'CONSUMER_NFT',
    isPrimary: true,
    createdAt: at,
  }
  const user: MockUser = {
    id,
    email: input.email.trim().toLowerCase(),
    fullName: input.fullName,
    phoneNumber: input.phoneNumber ?? null,
    preferredLocale: input.preferredLocale ?? 'es',
    isActive: true,
    lastLoginAt: null,
    createdAt: at,
    wineryMemberships: [],
    primaryWallet: wallet,
    _mock: { key, password: input.password },
  }
  db.wallets.push(wallet)
  db.users.push(user)
  return user
}

/** Emite un acceso para la sesión con la organización activa de la sesión. */
function accessTokenFor(user: MockUser, session: MockSession): string {
  const ctx = contextFor(user, session.activeOrganizationId, session.sid)
  return signAccessToken(
    {
      sub: user.id,
      aud: ctx.audience,
      org: ctx.organizationId,
      orgType: ctx.organizationType,
      role: ctx.membershipRole,
      sid: session.sid,
    },
    getErpDb().clock,
  )
}

/**
 * Respuesta de sesión con tokens nuevos y la cookie `doc_rt` (también en el almacén propio).
 * `extra` añade campos a `data` (p. ej. `recoveryCodes` al confirmar el TOTP). Con `reuseAccess`
 * (periodo de gracia de la renovación) devuelve el mismo par que la última rotación.
 */
export function sessionResult(
  user: MockUser,
  session: MockSession,
  url: URL,
  status = 200,
  extra: Record<string, unknown> = {},
  opts: { reuseAccess?: boolean } = {},
): RouteResult {
  const accessToken = (opts.reuseAccess ? session.lastAccessToken : null) ?? accessTokenFor(user, session)
  rememberAccessToken(session, accessToken)
  const body: SessionResponse = buildSessionResponse(user, getErpDb().wineries, {
    activeOrganizationId: session.activeOrganizationId,
    tokens: tokensFor(accessToken),
    memberships: membershipsOf(user),
  })
  writeCookieJar(session.refreshToken)
  return {
    status,
    data: { ...body, ...extra },
    headers: { 'Set-Cookie': refreshCookie(session.refreshToken, REFRESH_TTL_SECONDS[session.audience], url) },
  }
}

/**
 * Abre una sesión en la organización indicada o en la de por defecto (la última usada o la
 * primera utilizable). Sin segundo factor (`mfa: false`) nunca activa la de plataforma.
 */
export function openSession(user: MockUser, opts: { mfa?: boolean; organizationId?: string | null } = {}): MockSession {
  const mfa = opts.mfa ?? false
  const all = membershipsOf(user)
  const memberships = mfa ? all : all.filter((m) => m.organizationType !== 'PLATFORM')
  let org = opts.organizationId !== undefined ? opts.organizationId : defaultOrganizationId(user, memberships)
  if (!mfa && org && !memberships.some((m) => m.organizationId === org)) org = defaultOrganizationId(user, memberships)
  rememberOrganization(user.id, org)
  return createSession(user.id, all.length > 0 ? 'STAFF' : 'CONSUMER', org, mfa, getErpDb().clock)
}

/** ¿Corresponde el refresco a una persona o a una sesión conocida (vigente, rotada o revocada)? */
function isKnownRefresh(token: string): boolean {
  if (token.startsWith(REFRESH_TOKEN_PREFIX)) return Boolean(findUserByKey(token.slice(REFRESH_TOKEN_PREFIX.length)))
  return Boolean(sessionOfRefresh(token))
}

/**
 * Refresco presentado: la cookie `doc_rt` de la petición o, si no llega, la del almacén propio de
 * los mocks (MSW en el navegador). El cuerpo `{ refreshToken }` no se lee desde H1.
 */
function refreshCandidates(cookies: Record<string, string>): string[] {
  const fromCookie = cookies[REFRESH_COOKIE]
  if (fromCookie) return [fromCookie]
  const jar = readCookieJar()
  return jar ? [jar] : []
}

/**
 * Sesión de la petición con el refresco rotado, como `switch-organization` del backend (contrato de
 * la Ola 0 §8): hace falta el refresco de ESTA sesión en la cookie `doc_rt`; un acceso robado no
 * basta (401 `AUTH_REFRESH_INVALID`). Con un token estático (solo en los mocks) no hay sesión: se
 * abre una con `organizationId` activa.
 */
export function rotatedSessionOf(auth: AuthContext, cookies: Record<string, string>, organizationId: string | null): MockSession {
  if (!auth.sid) return createSession(auth.user.id, auth.audience, organizationId, auth.mfa, getErpDb().clock)
  const token = refreshCandidates(cookies).find((t) => parseRefreshToken(t)?.sid === auth.sid)
  if (!token) throw refreshInvalid('Falta el token de renovación de esta sesión')
  const validated = validateRefresh(token)
  if (!validated.grace) rotateRefresh(validated.session, getErpDb().clock)
  return validated.session
}

/** El refresco de la cookie (el primero que corresponde a una sesión conocida). */
function presentedRefresh(cookies: Record<string, string>): string | null {
  const candidates = refreshCandidates(cookies)
  return candidates.find(isKnownRefresh) ?? candidates[0] ?? null
}

/**
 * Campos retirados en H1 que el backend rechaza (`forbidNonWhitelisted` de class-validator): 422
 * `VALIDATION_ERROR` con `details[{ field, message: 'property … should not exist' }]`.
 */
function rejectRetiredFields(raw: unknown, fields: readonly string[]): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const present = fields.filter((f) => f in raw)
  if (present.length) throw invalid(present.map((f) => fieldError(f, `property ${f} should not exist`)))
}

/**
 * Valida un refresco como `SessionsService.validateRefresh` del backend: fuera de la cadena →
 * 401 `AUTH_REFRESH_INVALID` sin revocar; sesión revocada → `AUTH_SESSION_REVOKED`; caducada →
 * `AUTH_SESSION_EXPIRED`; el anterior dentro de la gracia (20 s) vale (`grace`); uno antiguo fuera
 * de ella → revoca la sesión y 401 `AUTH_REFRESH_REUSED`.
 */
function validateRefresh(token: string | null): { session: MockSession; grace: boolean } {
  const match = matchRefresh(token)
  if (match.kind === 'invalid') throw refreshInvalid()
  const { session } = match
  if (session.revoked) throw sessionRevoked()
  if (getErpDb().clock >= session.expiresAt) throw sessionExpired()
  if (match.kind === 'current') return { session, grace: false }
  if (match.kind === 'previous' && withinGrace(session)) return { session, grace: true }
  revokeSession(session)
  throw refreshReused()
}

/** Comprueba que la persona y su organización activa siguen siendo válidas; si no, revoca. */
function assertSessionUsable(user: MockUser | undefined, session: MockSession): asserts user is MockUser {
  if (!user || !user.isActive) {
    revokeSession(session)
    throw sessionRevoked()
  }
  if (session.activeOrganizationId) {
    const active = membershipsOf(user).find((m) => m.organizationId === session.activeOrganizationId)
    if (!active || !isUsableMembership(active)) {
      revokeSession(session)
      throw sessionRevoked('La membresía de la organización activa ya no está vigente')
    }
  }
}

/** `{ user, memberships, activeOrganizationId }` de GET y PATCH /v1/users/me. */
function meOf(auth: AuthContext): MeResponse {
  return {
    user: { ...toProfile(auth.user), audience: auth.audience, ...prefsOf(auth.user.id) },
    memberships: auth.memberships,
    activeOrganizationId: auth.organizationId,
  }
}

/** Sesión del token de acceso o, si no hay, la del refresco (logout con el acceso caducado). */
function sessionForLogout(auth: AuthContext | null, request: Request, refresh: string | null): MockSession | undefined {
  if (auth?.sid) return getSession(auth.sid)
  // Acceso caducado: la sesión sale de sus claims (el backend no comprueba la caducidad aquí).
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1]
  const claims = bearer ? decodeAccessToken(bearer) : null
  if (claims) return getSession(claims.sid)
  return refresh ? sessionOfRefresh(refresh) : undefined
}

/** Organización activa por defecto de una sesión (la de plataforma solo con el segundo factor). */
function defaultOrganizationForSession(user: MockUser, session: MockSession): string | null {
  const all = membershipsOf(user)
  return defaultOrganizationId(user, session.mfa ? all : all.filter((m) => m.organizationType !== 'PLATFORM'))
}

export const authUserRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/auth/signup',
    access: 'public',
    async handle({ request, url }) {
      // Solo consumidores: el registro de personal (`userRole`) se retiró en H1.
      const raw = await readJson(request)
      rejectRetiredFields(raw, ['userRole'])
      const body = validate(raw, SignupSchema)
      if (findUserByEmail(body.email)) throw conflict('El correo electrónico ya existe')
      const user = createUser(body)
      return sessionResult(user, openSession(user), url, 201)
    },
  },
  {
    method: 'post',
    path: '/v1/auth/login',
    access: 'public',
    async handle(ctx) {
      const { request, url } = ctx
      const body = await parseBody(request, LoginSchema)
      // Bloqueo progresivo (IAM-07): 5 fallos por correo → 60 s que se duplican (tope 1 h).
      const locked = loginLockedFor(body.email)
      if (locked > 0) throw tooManyAttempts(locked)
      const user = findUserByEmail(body.email)
      // Mismo 401 para correo inexistente, contraseña mala o cuenta bloqueada.
      if (!user || !user.isActive || user._mock.password !== body.password) {
        if (user) recordLoginFailure(ctx, user)
        const lock = recordLoginFailureAttempt(body.email)
        if (lock > 0) throw tooManyAttempts(lock)
        throw invalidCredentials()
      }
      recordLoginSuccessAttempt(body.email)
      // Personal de plataforma: sin tokens hasta pasar el TOTP (contrato de la Ola 1 §1).
      if (needsMfa(user)) return ok(startMfaChallenge(user))
      recordLogin(ctx, user, false)
      return sessionResult(user, openSession(user), url)
    },
  },
  {
    method: 'post',
    path: '/v1/auth/refresh',
    access: 'public',
    handle({ url, cookies }) {
      const token = presentedRefresh(cookies)
      // Refresco estático de los fixtures (`mock.refresh.<clave>`, solo en los mocks): abre una sesión nueva.
      if (token?.startsWith(REFRESH_TOKEN_PREFIX)) {
        const user = findUserByKey(token.slice(REFRESH_TOKEN_PREFIX.length))
        if (!user || !user.isActive) throw refreshInvalid()
        return sessionResult(user, openSession(user), url)
      }
      const { session, grace } = validateRefresh(token)
      const user = findUserById(session.userId)
      assertSessionUsable(user, session)
      // Dos pestañas renovando a la vez: el anterior dentro de la gracia devuelve el mismo par nuevo.
      if (grace) return sessionResult(user, session, url, 200, {}, { reuseAccess: true })
      rotateRefresh(session, getErpDb().clock)
      // Sin organización activa (p. ej. el dueño acaba de registrar su bodega): la de por defecto.
      if (!session.activeOrganizationId) setActiveOrganization(session, defaultOrganizationForSession(user, session))
      return sessionResult(user, session, url)
    },
  },
  {
    method: 'post',
    path: '/v1/auth/switch-organization',
    access: anyUser,
    async handle({ request, url, auth, cookies }) {
      const raw = await readJson(request)
      rejectRetiredFields(raw, ['refreshToken'])
      const body = validate(raw, SwitchOrganizationSchema)
      const membership = auth.memberships.find((m) => m.organizationId === body.organizationId)
      if (!membership) throw new ApiError(404, 'ORG_NOT_FOUND', 'Organización no encontrada')
      if (membership.status !== 'ACTIVE') throw new ApiError(403, 'ORG_MEMBERSHIP_BLOCKED', 'Tu membresía en esta organización está bloqueada')
      if (membership.organizationStatus === 'REVOKED') throw new ApiError(403, 'ORG_REVOKED', 'La organización está revocada')
      // La organización de plataforma exige haber pasado el TOTP en esta sesión (Ola 1 §1).
      if (membership.organizationType === 'PLATFORM' && !auth.mfa) {
        throw new ApiError(403, 'AUTH_MFA_REQUIRED', 'Para entrar en la plataforma hay que verificar el segundo factor')
      }
      const session = rotatedSessionOf(auth, cookies, body.organizationId)
      setActiveOrganization(session, body.organizationId)
      rememberOrganization(auth.user.id, body.organizationId)
      return sessionResult(auth.user, session, url)
    },
  },
  {
    method: 'post',
    path: '/v1/auth/logout',
    access: 'public',
    handle({ request, url, cookies, optionalAuth }) {
      const refresh = presentedRefresh(cookies)
      const session = sessionForLogout(optionalAuth, request, refresh)
      if (session) revokeSession(session)
      writeCookieJar(null)
      return noContent({ 'Set-Cookie': clearRefreshCookie(url) })
    },
  },
  {
    method: 'post',
    path: '/v1/auth/logout-all',
    access: anyUser,
    handle({ url, auth }) {
      revokeAllSessions(auth.user.id)
      writeCookieJar(null)
      return noContent({ 'Set-Cookie': clearRefreshCookie(url) })
    },
  },
  {
    method: 'get',
    path: '/v1/users/me',
    access: anyUser,
    handle: ({ auth }) => ok(meOf(auth)),
  },
  {
    method: 'patch',
    path: '/v1/users/me',
    access: anyUser,
    async handle(ctx) {
      const { request, auth } = ctx
      const { notificationPrefs, promotionsConsent, ...profile } = await parseBody(request, UpdateUserSchema)
      const before = { fullName: auth.user.fullName, preferredLocale: auth.user.preferredLocale, ...prefsOf(auth.user.id) }
      applyPatch(auth.user, profile)
      // Preferencias de la Ola 1 (IAM-09): se guardan aparte y se leen en GET /v1/users/me.
      updatePrefs(auth.user.id, notificationPrefs, promotionsConsent)
      recordProfileUpdate(ctx, before)
      // Contrato de la Ola 1 §1 y §11 bis: la misma forma que GET /v1/users/me.
      return ok(meOf(auth))
    },
  },
  {
    method: 'get',
    path: '/v1/users/me/wallet',
    access: anyUser,
    handle({ auth }) {
      // Ola 3 §3.3 (SE-02): ya no hay billeteras simuladas. El personal → 404; el consumidor recibe su
      // dirección custodial derivada con la forma legada (se sustituye en la Ola 4).
      const wallet = getErpDb().wallets.find((w) => w.userId === auth.user.id && w.isPrimary)
      if (auth.audience !== 'CONSUMER' || !wallet) throw new ApiError(404, 'CHN_WALLET_NOT_AVAILABLE', 'Esta cuenta no tiene una dirección en la red')
      return ok({ ...wallet, stellarPublicAddress: consumerAddressOf(auth.user.id) })
    },
  },
]
