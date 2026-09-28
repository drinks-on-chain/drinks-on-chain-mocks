import { sha256 } from '../../shared/crypto'
import { ACCESS_TOKEN_TTL_SECONDS } from '../derive'
import type { AccessTokenClaims, Audience, AuthTokens } from '../schemas'
import { AccessTokenClaimsSchema } from '../schemas'

// Sesiones simuladas (contrato de la Ola 0 §5 y §8, como el backend O0-BE-4): acceso de 15 min
// con forma de JWT, renovación rotativa `<sid>.<generación>.<secreto>` con periodo de gracia de
// 20 s y detección de reutilización, caducidad deslizante, organización activa por sesión, cookie
// `doc_rt` y bloqueo progresivo del login.
//
// En el navegador el estado se guarda en localStorage (`doc-mocks:sessions`) para que una
// recarga de la página no cierre la sesión; en Node vive en memoria. `resetSessions()` (y
// `resetErpDb()`) lo borra.

export const REFRESH_COOKIE = 'doc_rt'
export const ACCESS_TOKEN_PREFIX = 'mock.access.'
/** Prefijo del refresco estático de los fixtures (`mock.refresh.<clave>`). */
export const STATIC_REFRESH_PREFIX = 'mock.refresh.'
/** Renovación (deslizante): 7 días para personal, 30 para consumidores. */
export const REFRESH_TTL_SECONDS: Record<Audience, number> = { STAFF: 7 * 86_400, CONSUMER: 30 * 86_400 }
/** Periodo de gracia del refresco inmediatamente anterior (dos pestañas renovando a la vez). */
export const REFRESH_GRACE_SECONDS = 20
/** Bloqueo progresivo del login (IAM-07): fallos por correo, primer bloqueo, tope y ventana. */
export const LOGIN_LOCK_POLICY = { emailThreshold: 5, baseLockSeconds: 60, maxLockSeconds: 3600, windowSeconds: 3600 } as const

const STORAGE_KEY = 'doc-mocks:sessions'

export interface MockSession {
  sid: string
  userId: string
  audience: Audience
  activeOrganizationId: string | null
  /** Semilla de los secretos de la cadena de refrescos (el de la generación n se deriva de ella). */
  seed: string
  /** Refresco vigente de la familia (`<sid>.<generación>.<secreto>`). */
  refreshToken: string
  /** Generación del refresco vigente (sube en cada rotación; empieza en 0). */
  generation: number
  /** Hora real (ms) de la última rotación: marca el periodo de gracia; `null` si no rotó. */
  rotatedAt: number | null
  /** Acceso emitido en la última rotación: el periodo de gracia devuelve el mismo par. */
  lastAccessToken: string | null
  /** Caducidad deslizante en el reloj de los mocks (ms); cada rotación la renueva. */
  expiresAt: number
  revoked: boolean
  /** ¿Pasó el segundo factor (TOTP)? Necesario para activar la organización de plataforma. */
  mfa: boolean
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
  /** Fallos de login por correo (hora real): bloqueo progresivo. */
  loginFailures: Record<string, { count: number; firstAt: number; lockedUntil: number }>
}

const emptyState = (): SessionState => ({
  nonce: Math.random().toString(36).slice(2, 7),
  seq: 0,
  jti: 0,
  expiredUpTo: 0,
  sessions: {},
  lastOrganization: {},
  cookieJar: null,
  loginFailures: {},
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
    if (raw) {
      const saved = { ...emptyState(), ...(JSON.parse(raw) as Partial<SessionState>) }
      // Las sesiones de los mocks 0.3.0-rc.1 (refresco `mock.rt.…`) no tienen semilla: se descartan.
      saved.sessions = Object.fromEntries(Object.entries(saved.sessions).filter(([, x]) => typeof x.seed === 'string'))
      return saved
    }
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

/**
 * Simula que pasaron 15 minutos: todos los accesos emitidos hasta ahora caducan (401
 * `AUTH_TOKEN_EXPIRED`) y termina el periodo de gracia de los refrescos rotados.
 */
export function expireAccessTokens(): void {
  const s = current()
  s.expiredUpTo = s.jti
  persist()
  expireRefreshGrace()
}

/** Simula que pasaron más de 20 s desde la última rotación (fin del periodo de gracia). */
export function expireRefreshGrace(): void {
  for (const session of Object.values(current().sessions)) if (session.rotatedAt !== null) session.rotatedAt = 0
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

/** UUID v4 aleatorio (el `sid` de la sesión). */
function randomUuid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16))
  hex[12] = '4'
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const h = hex.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function base64urlBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Secreto de la generación `gen` (43 caracteres base64url, como el HMAC del backend). */
function secretFor(session: Pick<MockSession, 'sid' | 'seed'>, gen: number): string {
  return base64urlBytes(sha256(new TextEncoder().encode(`${session.seed}.${session.sid}.${gen}`)))
}

function refreshFor(session: Pick<MockSession, 'sid' | 'seed'>, gen: number): string {
  return `${session.sid}.${gen}.${secretFor(session, gen)}`
}

/** Crea una sesión nueva (login, signup, invitación o renovación con un refresco estático). */
export function createSession(
  userId: string,
  audience: Audience,
  activeOrganizationId: string | null,
  mfa = false,
  nowMs = 0,
): MockSession {
  const s = current()
  s.seq += 1
  const sid = randomUuid()
  const seed = `${s.nonce}.${s.seq}.${Math.random().toString(36).slice(2)}`
  const session: MockSession = {
    sid,
    userId,
    audience,
    activeOrganizationId,
    seed,
    refreshToken: refreshFor({ sid, seed }, 0),
    generation: 0,
    rotatedAt: null,
    lastAccessToken: null,
    expiresAt: nowMs + REFRESH_TTL_SECONDS[audience] * 1000,
    revoked: false,
    mfa,
  }
  s.sessions[sid] = session
  persist()
  return session
}

/** Rota el refresco de la sesión (generación + 1), renueva la caducidad y devuelve el nuevo. */
export function rotateRefresh(session: MockSession, nowMs: number): string {
  session.generation += 1
  session.refreshToken = refreshFor(session, session.generation)
  session.rotatedAt = Date.now()
  session.expiresAt = nowMs + REFRESH_TTL_SECONDS[session.audience] * 1000
  persist()
  return session.refreshToken
}

/** Guarda el acceso emitido con la última rotación (lo devuelve el periodo de gracia). */
export function rememberAccessToken(session: MockSession, accessToken: string): void {
  session.lastAccessToken = accessToken
  persist()
}

/** ¿Sigue abierto el periodo de gracia de la última rotación? */
export function withinGrace(session: MockSession): boolean {
  return session.rotatedAt !== null && Date.now() - session.rotatedAt <= REFRESH_GRACE_SECONDS * 1000
}

export function setActiveOrganization(session: MockSession, organizationId: string | null): void {
  session.activeOrganizationId = organizationId
  persist()
}

export function revokeSession(session: MockSession): void {
  session.revoked = true
  persist()
}

export function revokeAllSessions(userId: string, except: string | null = null): void {
  for (const session of sessionsOf(userId)) if (session.sid !== except) session.revoked = true
  persist()
}

/** Revoca las sesiones con esta organización activa (suspender o revocar una bodega, bloquear). */
export function revokeSessionsOfOrganization(organizationId: string, userId: string | null = null): void {
  for (const session of Object.values(current().sessions)) {
    if (session.activeOrganizationId === organizationId && (userId === null || session.userId === userId)) session.revoked = true
  }
  persist()
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/

/** `<sid>.<generación>.<secreto>` o `null` si no tiene esa forma. */
export function parseRefreshToken(raw: string | null | undefined): { sid: string; generation: number; secret: string } | null {
  if (typeof raw !== 'string' || raw.length > 200) return null
  const parts = raw.trim().split('.')
  if (parts.length !== 3) return null
  const [sid, gen, secret] = parts as [string, string, string]
  if (!UUID_RE.test(sid) || !/^\d{1,9}$/.test(gen) || !SECRET_RE.test(secret)) return null
  return { sid: sid.toLowerCase(), generation: Number(gen), secret }
}

/**
 * Lugar de un refresco en la cadena de su sesión (como `matchRefreshToken` del backend):
 * - `current`: el vigente; `previous`: el inmediatamente anterior (candidato a la gracia);
 * - `reused`: uno más antiguo de la misma sesión; `invalid`: no es de ninguna cadena conocida.
 */
export type RefreshMatch =
  | { kind: 'current' | 'previous' | 'reused'; session: MockSession }
  | { kind: 'invalid'; session?: undefined }

export function matchRefresh(raw: string | null | undefined): RefreshMatch {
  const parsed = parseRefreshToken(raw)
  if (!parsed) return { kind: 'invalid' }
  const session = current().sessions[parsed.sid]
  if (!session || parsed.generation > session.generation) return { kind: 'invalid' }
  if (secretFor(session, parsed.generation) !== parsed.secret) return { kind: 'invalid' }
  if (parsed.generation === session.generation) return { kind: 'current', session }
  return { kind: parsed.generation === session.generation - 1 ? 'previous' : 'reused', session }
}

/** Sesión a la que pertenece un refresco auténtico (vigente o ya rotado). */
export function sessionOfRefresh(token: string): MockSession | undefined {
  return matchRefresh(token).session
}

// ---------------------------------------------------------------------------
// Bloqueo progresivo del login (IAM-07; hora real, por correo)
// ---------------------------------------------------------------------------

function lockSecondsFor(failures: number): number {
  const p = LOGIN_LOCK_POLICY
  if (failures < p.emailThreshold) return 0
  return Math.min(p.baseLockSeconds * 2 ** Math.min(failures - p.emailThreshold, 16), p.maxLockSeconds)
}

/** Segundos que quedan de bloqueo para este correo (0 = puede intentarlo). */
export function loginLockedFor(email: string): number {
  const entry = current().loginFailures[email.trim().toLowerCase()]
  const left = entry ? entry.lockedUntil - Date.now() : 0
  return left > 0 ? Math.ceil(left / 1000) : 0
}

/** Anota un fallo; devuelve los segundos de bloqueo que empiezan (0 si ninguno). */
export function recordLoginFailureAttempt(email: string): number {
  const s = current()
  const key = email.trim().toLowerCase()
  const now = Date.now()
  let entry = s.loginFailures[key]
  if (!entry || now - entry.firstAt > LOGIN_LOCK_POLICY.windowSeconds * 1000) entry = { count: 0, firstAt: now, lockedUntil: 0 }
  entry.count += 1
  const lock = lockSecondsFor(entry.count)
  if (lock > 0) entry.lockedUntil = now + lock * 1000
  s.loginFailures[key] = entry
  persist()
  return lock
}

/** Login correcto: se olvidan los fallos del correo. */
export function recordLoginSuccessAttempt(email: string): void {
  delete current().loginFailures[email.trim().toLowerCase()]
  persist()
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

/** Tokens de la respuesta de sesión (el refresco va solo en la cookie `doc_rt` desde H1). */
export function tokensFor(accessToken: string): AuthTokens {
  return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS }
}
