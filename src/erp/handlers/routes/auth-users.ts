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
  RefreshTokenSchema,
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
import { ApiError, conflict, forbidden, notFound, refreshReused, sessionRevoked, unauthorized } from '../errors'
import { applyPatch, noContent, ok, parseBody, type RouteResult, type RouteSpec } from '../http'
import {
  clearRefreshCookie,
  createSession,
  getSession,
  readCookieJar,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
  refreshCookie,
  rememberOrganization,
  revokeAllSessions,
  revokeSession,
  rotateRefresh,
  sessionOfRefresh,
  setActiveOrganization,
  signAccessToken,
  tokensFor,
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

/** Crea usuario + billetera custodial (signup y alta de miembros). */
export function createUser(input: {
  email: string
  password: string
  fullName: string
  userRole: MockUser['userRole']
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
    userRole: input.userRole,
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
      email: user.email,
      userRole: user.userRole,
      wineryId: ctx.wineryId,
      memberRole: ctx.memberRole,
    },
    getErpDb().clock,
  )
}

/**
 * Respuesta de sesión con tokens nuevos y la cookie `doc_rt` (también en el almacén propio).
 * `extra` añade campos a `data` (p. ej. `recoveryCodes` al confirmar el TOTP).
 */
export function sessionResult(
  user: MockUser,
  session: MockSession,
  url: URL,
  status = 200,
  extra: Record<string, unknown> = {},
): RouteResult {
  const body: SessionResponse = buildSessionResponse(user, getErpDb().wineries, {
    activeOrganizationId: session.activeOrganizationId,
    tokens: tokensFor(accessTokenFor(user, session), session.refreshToken),
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
  return createSession(user.id, all.length > 0 ? 'STAFF' : 'CONSUMER', org, mfa)
}

/** ¿Corresponde el refresco a una persona o a una sesión conocida (vigente, rotada o revocada)? */
function isKnownRefresh(token: string): boolean {
  if (token.startsWith(REFRESH_TOKEN_PREFIX)) return Boolean(findUserByKey(token.slice(REFRESH_TOKEN_PREFIX.length)))
  return Boolean(sessionOfRefresh(token))
}

/**
 * Refresco presentado, por orden: cookie `doc_rt` (de la petición o del almacén de MSW), cuerpo
 * `{ refreshToken }` (*retirada* en H1) y el almacén propio de los mocks. Se usa el primero que
 * corresponde a una sesión conocida (una cookie de antes de `resetErpDb()` no tapa el cuerpo).
 */
async function presentedRefresh(request: Request, cookies: Record<string, string>): Promise<string | null> {
  const body = await parseBody(request, RefreshTokenSchema)
  const candidates = [cookies[REFRESH_COOKIE], body.refreshToken, readCookieJar()].filter((t): t is string => Boolean(t))
  return candidates.find(isKnownRefresh) ?? candidates[0] ?? null
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

/** Sesión del token de acceso o, si no hay, la del refresco (logout con el acceso caducado). */
function sessionForLogout(auth: AuthContext | null, refresh: string | null): MockSession | undefined {
  if (auth?.sid) return getSession(auth.sid)
  return refresh ? sessionOfRefresh(refresh) : undefined
}

export const authUserRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/auth/signup',
    access: 'public',
    async handle({ request, url }) {
      const body = await parseBody(request, SignupSchema)
      if (findUserByEmail(body.email)) throw conflict('El correo electrónico ya existe')
      const user = createUser({ ...body, userRole: body.userRole ?? 'CONSUMER' })
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
      const user = findUserByEmail(body.email)
      if (!user || !user.isActive || user._mock.password !== body.password) {
        if (user) recordLoginFailure(ctx, user)
        throw unauthorized('Credenciales inválidas')
      }
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
    async handle({ request, url, cookies }) {
      const token = await presentedRefresh(request, cookies)
      if (!token) throw unauthorized('Falta el token de renovación')
      // Refresco estático de los fixtures (`mock.refresh.<clave>`): abre una sesión nueva.
      if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
        const user = findUserByKey(token.slice(REFRESH_TOKEN_PREFIX.length))
        if (!user || !user.isActive) throw unauthorized('Token de renovación inválido o expirado')
        return sessionResult(user, openSession(user), url)
      }
      const session = sessionOfRefresh(token)
      if (!session) throw unauthorized('Token de renovación inválido o expirado')
      if (session.revoked) throw sessionRevoked()
      if (token !== session.refreshToken) {
        if (!session.rotated.includes(token)) throw unauthorized('Token de renovación inválido o expirado')
        // Reutilización de un refresco ya rotado: se revoca toda la familia.
        revokeSession(session)
        throw refreshReused()
      }
      const user = findUserById(session.userId)
      assertSessionUsable(user, session)
      rotateRefresh(session)
      return sessionResult(user, session, url)
    },
  },
  {
    method: 'post',
    path: '/v1/auth/switch-organization',
    access: anyUser,
    async handle({ request, url, auth }) {
      const body = await parseBody(request, SwitchOrganizationSchema)
      const membership = auth.memberships.find((m) => m.organizationId === body.organizationId)
      if (!membership) throw new ApiError(404, 'ORG_NOT_FOUND', 'Organización no encontrada')
      if (membership.status !== 'ACTIVE') throw forbidden('La membresía en esta organización está bloqueada')
      if (membership.organizationStatus === 'REVOKED') throw forbidden('La organización está revocada')
      // La organización de plataforma exige haber pasado el TOTP en esta sesión (Ola 1 §1).
      if (membership.organizationType === 'PLATFORM' && !auth.mfa) {
        throw new ApiError(403, 'AUTH_MFA_REQUIRED', 'Para entrar en la plataforma hay que verificar el segundo factor')
      }
      // Con un token estático no hay sesión: se abre una.
      let session = auth.sid ? getSession(auth.sid) : undefined
      if (!session || session.revoked) session = createSession(auth.user.id, auth.audience, body.organizationId, auth.mfa)
      else rotateRefresh(session)
      setActiveOrganization(session, body.organizationId)
      rememberOrganization(auth.user.id, body.organizationId)
      return sessionResult(auth.user, session, url)
    },
  },
  {
    method: 'post',
    path: '/v1/auth/logout',
    access: 'public',
    async handle({ request, url, cookies, optionalAuth }) {
      const refresh = await presentedRefresh(request, cookies)
      const session = sessionForLogout(optionalAuth, refresh)
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
    handle({ auth }) {
      const me: MeResponse = {
        user: { ...toProfile(auth.user), audience: auth.audience, ...prefsOf(auth.user.id) },
        memberships: auth.memberships,
        activeOrganizationId: auth.organizationId,
      }
      return ok(me)
    },
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
      // La respuesta sigue siendo el perfil (docs/CONTRATO.md §6: el contrato de la Ola 1 la cambia).
      return ok(toProfile(auth.user))
    },
  },
  {
    method: 'get',
    path: '/v1/users/me/wallet',
    access: anyUser,
    handle({ auth }) {
      const wallet = getErpDb().wallets.find((w) => w.userId === auth.user.id && w.isPrimary)
      if (!wallet) throw notFound('Billetera no encontrada')
      return ok(wallet)
    },
  },
]
