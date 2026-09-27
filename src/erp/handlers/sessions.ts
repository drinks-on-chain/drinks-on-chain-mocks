import { ACCESS_TOKEN_TTL_SECONDS } from '../derive'
import type { AccessTokenClaims, Audience, AuthTokens } from '../schemas'
import { AccessTokenClaimsSchema } from '../schemas'

// Sesiones simuladas (contrato de la Ola 0 §5): acceso de 15 min con forma de JWT, renovación
// rotativa con detección de reutilización, organización activa por sesión y cookie `doc_rt`.
//
// En el navegador el estado se guarda en localStorage (`doc-mocks:sessions`) para que una
// recarga de la página no cierre la sesión; en Node vive en memoria. `resetSessions()` (y
// `resetErpDb()`) lo borra.

export const REFRESH_COOKIE = 'doc_rt'
export const ACCESS_TOKEN_PREFIX = 'mock.access.'
/** Prefijo del refresco estático de los fixtures (`mock.refresh.<clave>`). */
export const STATIC_REFRESH_PREFIX = 'mock.refresh.'
/** Prefijo del refresco rotativo que emiten los handlers (`mock.rt.<sid>.<generación>`). */
export const ROTATING_REFRESH_PREFIX = 'mock.rt.'
/** Renovación: 7 días para personal, 30 para consumidores. */
export const REFRESH_TTL_SECONDS: Record<Audience, number> = { STAFF: 7 * 86_400, CONSUMER: 30 * 86_400 }

const STORAGE_KEY = 'doc-mocks:sessions'

export interface MockSession {
  sid: string
  userId: string
  audience: Audience
  activeOrganizationId: string | null
  /** Refresco vigente de la familia. */
  refreshToken: string
  /** Refrescos ya rotados: presentarlos de nuevo revoca la sesión (AUTH_REFRESH_REUSED). */
  rotated: string[]
  /** Generación del refresco (sube en cada rotación). */
  generation: number
  revoked: boolean
}

interface SessionState {
  /** Prefijo aleatorio de los `sid`: una cookie de antes de `resetSessions()` no apunta a una sesión nueva. */
  nonce: string
  seq: number
  jti: number
  /** Los accesos con `jti` ≤ este número están caducados (`expireAccessTokens()`). */
  expiredUpTo: number
  sessions: Record<string, MockSession>
  /** Última organización usada por persona (organización activa por defecto al iniciar sesión). */
  lastOrganization: Record<string, string>
  /**
   * Almacén de cookies propio de los mocks: último `doc_rt` emitido. MSW 2 también guarda la
   * cookie (`Set-Cookie`) en su almacén y la adjunta a las peticiones siguientes; este respaldo
   * cubre las versiones o entornos donde no lo hace (una cookie `HttpOnly` no se puede escribir
   * en `document.cookie`).
   */
  cookieJar: string | null
}

const emptyState = (): SessionState => ({
  nonce: Math.random().toString(36).slice(2, 7),
  seq: 0,
  jti: 0,
  expiredUpTo: 0,
  sessions: {},
  lastOrganization: {},
  cookieJar: null,
})

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' || typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function load(): SessionState {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (raw) return { ...emptyState(), ...(JSON.parse(raw) as Partial<SessionState>) }
  } catch {
    // almacenamiento bloqueado o dañado: empezamos de cero
  }
  return emptyState()
}

let state: SessionState | null = null

function current(): SessionState {
  state ??= load()
  return state
}

function persist(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(current()))
  } catch {
    // sin almacenamiento: basta con la memoria
  }
}

/** Borra todas las sesiones, la última organización usada y la cookie simulada. */
export function resetSessions(): void {
  state = emptyState()
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    // sin almacenamiento
  }
}

/** Simula que pasaron 15 minutos: todos los accesos emitidos hasta ahora caducan (401). */
export function expireAccessTokens(): void {
  const s = current()
  s.expiredUpTo = s.jti
  persist()
}

export function getSession(sid: string): MockSession | undefined {
  return current().sessions[sid]
}

export function sessionsOf(userId: string): MockSession[] {
  return Object.values(current().sessions).filter((x) => x.userId === userId)
}

export function lastOrganizationOf(userId: string): string | null {
  return current().lastOrganization[userId] ?? null
}

export function rememberOrganization(userId: string, organizationId: string | null): void {
  const s = current()
  if (organizationId) s.lastOrganization[userId] = organizationId
  else delete s.lastOrganization[userId]
  persist()
}

/** Crea una sesión nueva (login, signup o renovación con un refresco estático). */
export function createSession(userId: string, audience: Audience, activeOrganizationId: string | null): MockSession {
  const s = current()
  s.seq += 1
  const sid = `${s.nonce}s${s.seq}`
  const session: MockSession = {
    sid,
    userId,
    audience,
    activeOrganizationId,
    refreshToken: `${ROTATING_REFRESH_PREFIX}${sid}.1`,
    rotated: [],
    generation: 1,
    revoked: false,
  }
  s.sessions[sid] = session
  persist()
  return session
}

/** Rota el refresco de la sesión y devuelve el nuevo. */
export function rotateRefresh(session: MockSession): string {
  session.rotated.push(session.refreshToken)
  session.generation += 1
  session.refreshToken = `${ROTATING_REFRESH_PREFIX}${session.sid}.${session.generation}`
  persist()
  return session.refreshToken
}

export function setActiveOrganization(session: MockSession, organizationId: string | null): void {
  session.activeOrganizationId = organizationId
  persist()
}

export function revokeSession(session: MockSession): void {
  session.revoked = true
  persist()
}

export function revokeAllSessions(userId: string): void {
  for (const session of sessionsOf(userId)) session.revoked = true
  persist()
}

/** Sesión a la que pertenece un refresco rotativo (vigente o ya rotado). */
export function sessionOfRefresh(token: string): MockSession | undefined {
  if (!token.startsWith(ROTATING_REFRESH_PREFIX)) return undefined
  const sid = token.slice(ROTATING_REFRESH_PREFIX.length).split('.')[0] ?? ''
  return current().sessions[sid]
}

// ---------------------------------------------------------------------------
// Cookie de renovación
// ---------------------------------------------------------------------------

export function readCookieJar(): string | null {
  return current().cookieJar
}

export function writeCookieJar(token: string | null): void {
  current().cookieJar = token
  persist()
}

/**
 * `Set-Cookie` de la renovación. Sin HTTPS (desarrollo local) se omite `Secure`, como hace el
 * backend con `NODE_ENV=development` en `localhost`.
 */
export function refreshCookie(token: string, maxAgeSeconds: number, url: URL): string {
  const secure = url.protocol === 'https:' ? '; Secure' : ''
  return `${REFRESH_COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
}

export function clearRefreshCookie(url: URL): string {
  return refreshCookie('', 0, url)
}

// ---------------------------------------------------------------------------
// Token de acceso con forma de JWT (`header.payload.mock`)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64url(text: string): string {
  let binary = ''
  for (const b of encoder.encode(text)) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return decoder.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

const JWT_HEADER = base64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'drinks-on-chain-mocks' }))

/** Emite un acceso para la sesión (el reloj es el de los mocks, en segundos). */
export function signAccessToken(claims: Omit<AccessTokenClaims, 'jti' | 'iat' | 'exp'>, nowMs: number): string {
  const s = current()
  s.jti += 1
  persist()
  const iat = Math.floor(nowMs / 1000)
  const payload: AccessTokenClaims = { ...claims, jti: String(s.jti), iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS }
  return `${JWT_HEADER}.${base64url(JSON.stringify(payload))}.mock`
}

/** Decodifica un acceso emitido por los handlers; `null` si no tiene la forma esperada. */
export function decodeAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== JWT_HEADER || parts[2] !== 'mock') return null
  try {
    const parsed = AccessTokenClaimsSchema.safeParse(JSON.parse(fromBase64url(parts[1]!)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** ¿Caducó este acceso por `expireAccessTokens()`? */
export function isExpired(claims: AccessTokenClaims): boolean {
  return Number(claims.jti) <= current().expiredUpTo
}

/** Tokens de la respuesta de sesión. */
export function tokensFor(accessToken: string, refreshToken: string): AuthTokens {
  return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS, refreshToken }
}
