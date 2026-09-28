import { deriveMemberships, isUsableMembership, pickActiveOrganizationId } from '../derive'
import type {
  Audience,
  CertificationStatus,
  MemberRole,
  Membership,
  MembershipRole,
  MockUser,
  OrganizationType,
  PlatformRole,
  WineryRole,
} from '../schemas'
import { getErpDb } from './db'
import { ApiError, fieldError, forbidden, invalid, sessionRevoked, tokenExpired, tokenInvalid } from './errors'
import {
  ACCESS_TOKEN_PREFIX,
  decodeAccessToken,
  getSession,
  isExpired,
  lastOrganizationOf,
  revokeSession,
} from './sessions'

// Sesión simulada. Dos clases de token de acceso:
// - Emitido por login/refresh/switch (forma de JWT con `sid` y `org`): pertenece a una sesión
//   revocable y lleva la organización activa.
// - Estático `mock.access.<clave>` (fixtures, paneles de desarrollo y pruebas): sin sesión; su
//   organización activa es la última usada por la persona o la de por defecto.
// Los permisos salen de la membresía activa (contrato de la Ola 0 §6 y §8), como los guards del
// backend: `@OrgType('WINERY') @Roles(...)` en el ERP y la plataforma con `?wineryId=`.

export interface AuthContext {
  user: MockUser
  key: string
  /** ¿La organización activa es la de plataforma? */
  isPlatformAdmin: boolean
  /** Bodega activa; `null` para la plataforma, consumidores y cajeros. */
  wineryId: string | null
  /**
   * Bodega sobre la que trabaja la petición (el `TenantGuard` del backend): la activa o, para el
   * personal de plataforma, la de `?wineryId=`; `null` = todas (lecturas de plataforma).
   */
  tenantId: string | null
  memberRole: MemberRole | null
  /** Id de miembro en la bodega activa (autor de lecturas, dictámenes, embotellados…). */
  memberId: string | null
  audience: Audience
  memberships: Membership[]
  organizationId: string | null
  organizationType: OrganizationType | null
  /** Rol en la organización activa (claim `role`). */
  membershipRole: MembershipRole | null
  /** Sesión del token; `null` con un token estático. */
  sid: string | null
  /** Estado de la organización activa (`INVITED` | `ACTIVE` | `SUSPENDED` | `REVOKED`). */
  organizationStatus: CertificationStatus | null
  /** Rol de plataforma si la organización activa es la de plataforma. */
  platformRole: PlatformRole | null
  /** ¿Pasó el segundo factor en esta sesión? (los tokens estáticos cuentan como sí). */
  mfa: boolean
}

export { ACCESS_TOKEN_PREFIX } from './sessions'
export const REFRESH_TOKEN_PREFIX = 'mock.refresh.'

/** Token Bearer estático de prueba para un usuario (`_mock.key`). */
export function mockAccessToken(key: string): string {
  return `${ACCESS_TOKEN_PREFIX}${key}`
}

export function findUserByKey(key: string): MockUser | undefined {
  return getErpDb().users.find((u) => u._mock.key === key)
}

export function findUserById(id: string): MockUser | undefined {
  return getErpDb().users.find((u) => u.id === id)
}

/**
 * Membresías de la persona: las derivadas de los datos del ERP con los bloqueos de la plataforma
 * aplicados a la membresía de plataforma (contrato de la Ola 1 §5).
 */
export function membershipsOf(user: MockUser): Membership[] {
  const db = getErpDb()
  return deriveMemberships(user, db.wineries).map((m) =>
    m.organizationType === 'PLATFORM' && db.backoffice.blocks.some((b) => b.membershipId === m.id) ? { ...m, status: 'BLOCKED' } : m,
  )
}

/** Organización activa por defecto: la última usada si sigue siendo válida o la primera utilizable. */
export function defaultOrganizationId(user: MockUser, memberships = membershipsOf(user)): string | null {
  return pickActiveOrganizationId(memberships, lastOrganizationOf(user.id))
}

/** Contexto de una persona en una organización (`undefined` → la de por defecto). */
export function contextFor(
  user: MockUser,
  organizationId?: string | null,
  sid: string | null = null,
  mfa = sid === null,
): AuthContext {
  const memberships = membershipsOf(user)
  const orgId = organizationId === undefined ? defaultOrganizationId(user, memberships) : organizationId
  const active = orgId ? memberships.find((m) => m.organizationId === orgId) : undefined
  const winery = active?.organizationType === 'WINERY' ? active : undefined
  return {
    user,
    key: user._mock.key,
    isPlatformAdmin: active?.organizationType === 'PLATFORM',
    wineryId: winery?.organizationId ?? null,
    tenantId: winery?.organizationId ?? null,
    memberRole: (winery?.role as MemberRole | undefined) ?? null,
    memberId: winery?.id ?? null,
    audience: memberships.length > 0 ? 'STAFF' : 'CONSUMER',
    memberships,
    organizationId: active?.organizationId ?? null,
    organizationType: active?.organizationType ?? null,
    membershipRole: active?.role ?? null,
    sid,
    organizationStatus: active?.organizationStatus ?? null,
    platformRole: active?.organizationType === 'PLATFORM' ? (active.role as PlatformRole) : null,
    mfa,
  }
}

/** Lee el Bearer; devuelve `null` si no hay cabecera y lanza 401 si el token no es válido. */
export function readAuth(request: Request): AuthContext | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1] ?? ''
  if (!token) throw tokenInvalid('Token de acceso ausente')
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    const user = findUserByKey(token.slice(ACCESS_TOKEN_PREFIX.length))
    if (!user) throw tokenInvalid()
    if (!user.isActive) throw sessionRevoked()
    return contextFor(user)
  }
  const claims = decodeAccessToken(token)
  if (!claims) throw tokenInvalid()
  if (isExpired(claims)) throw tokenExpired()
  const user = findUserById(claims.sub)
  if (!user) throw tokenInvalid()
  // Una sesión desconocida (p. ej. almacenamiento borrado) se acepta con los datos del token.
  const session = getSession(claims.sid)
  if (session?.revoked) throw sessionRevoked()
  // Sesión desconocida: se confía en el token (solo lleva `org` de plataforma si pasó el TOTP).
  const ctx = contextFor(user, claims.org, claims.sid, session ? session.mfa : claims.orgType === 'PLATFORM')
  // Revocación inmediata (IAM-13): persona o membresía activa bloqueada.
  const active = ctx.memberships.find((m) => m.organizationId === claims.org)
  if (!user.isActive || (claims.org && (!active || !isUsableMembership(active)))) {
    if (session) revokeSession(session)
    throw sessionRevoked()
  }
  return ctx
}

export function requireAuth(request: Request): AuthContext {
  const ctx = readAuth(request)
  if (!ctx) throw tokenInvalid('Token de acceso ausente')
  return ctx
}

// ---------------------------------------------------------------------------
// Reglas de acceso por ruta (doc 09 §3 y catálogo del backend)
// ---------------------------------------------------------------------------

/**
 * - `authenticated`: cualquier usuario con sesión.
 * - `winery`: ruta de bodega del backend (`@OrgType('WINERY') @Roles(...)`): rol en la bodega
 *   activa (`null` = cualquiera) o personal de plataforma sobre la bodega de `?wineryId=`
 *   (`SUPERADMIN`, `ADMIN` y `OPERATIONS` leen y escriben; `SUPPORT` solo lee).
 * - `platform`: personal de plataforma con la organización de plataforma activa.
 * - `org`: miembro de la bodega activa (rutas `/v1/organizations/current/*` de la Ola 1).
 */
export type AccessRule =
  | { kind: 'authenticated' }
  | { kind: 'winery'; roles: readonly WineryRole[] | null }
  | { kind: 'platform'; roles: readonly PlatformRole[] }
  | { kind: 'org'; roles: readonly MembershipRole[] | null }

export const anyUser: AccessRule = { kind: 'authenticated' }

/**
 * Personal de plataforma con la organización de plataforma activa (contrato de la Ola 1 §0).
 * `ADMIN` incluye siempre al `SUPERADMIN`.
 */
export const platform = (list: readonly PlatformRole[]): AccessRule => ({
  kind: 'platform',
  roles: list.includes('ADMIN') && !list.includes('SUPERADMIN') ? ['SUPERADMIN', ...list] : list,
})
/** Todo el personal de plataforma. */
export const anyStaff = platform(['SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT'])

/** Ruta de bodega del ERP (`@OrgType('WINERY') @Roles(...)` del backend); `null` = cualquier rol de bodega. */
export const winery = (list: readonly WineryRole[] | null = null): AccessRule => ({ kind: 'winery', roles: list })

/** Personal de plataforma que opera sobre una bodega (OP-07): lectura y escritura; `SUPPORT` solo lee. */
export const PLATFORM_WINERY_OPERATORS: readonly PlatformRole[] = ['SUPERADMIN', 'ADMIN', 'OPERATIONS']
export const PLATFORM_WINERY_READERS: readonly PlatformRole[] = [...PLATFORM_WINERY_OPERATORS, 'SUPPORT']

export function isReadMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

/** Miembro de la bodega activa (`null` = cualquier rol). */
export const orgMember = (list: readonly MembershipRole[] | null = null): AccessRule => ({ kind: 'org', roles: list })

export function checkAccess(ctx: AuthContext, rule: AccessRule, method = 'GET'): void {
  switch (rule.kind) {
    case 'authenticated':
      return
    case 'platform':
      if (ctx.organizationType !== 'PLATFORM' || !ctx.platformRole) throw forbidden('Requiere la organización de plataforma activa')
      if (!ctx.mfa) throw new ApiError(403, 'AUTH_MFA_REQUIRED', 'Falta el segundo factor en esta sesión')
      if (!rule.roles.includes(ctx.platformRole)) throw forbidden(`Requiere rol ${rule.roles.join(' o ')}`)
      return
    case 'winery': {
      if (ctx.organizationType === 'WINERY' && ctx.wineryId && ctx.membershipRole) {
        if (rule.roles && !(rule.roles as readonly string[]).includes(ctx.membershipRole)) {
          throw forbidden(`Acceso denegado: el rol '${ctx.membershipRole}' no tiene los permisos necesarios`)
        }
        return
      }
      const allowed = isReadMethod(method) ? PLATFORM_WINERY_READERS : PLATFORM_WINERY_OPERATORS
      if (ctx.organizationType === 'PLATFORM' && ctx.platformRole && allowed.includes(ctx.platformRole)) {
        if (!ctx.mfa) throw new ApiError(403, 'AUTH_MFA_REQUIRED', 'Falta el segundo factor en esta sesión')
        return
      }
      throw forbidden(
        ctx.organizationType === 'PLATFORM'
          ? 'Requiere una organización activa de tipo WINERY (o un rol de plataforma que pueda operar sobre bodegas)'
          : 'Requiere una organización activa de tipo WINERY',
      )
    }
    case 'org':
      if (ctx.organizationType !== 'WINERY' || !ctx.wineryId || !ctx.membershipRole) throw forbidden('Requiere una bodega activa')
      if (rule.roles && !rule.roles.includes(ctx.membershipRole)) throw forbidden(`Requiere rol ${rule.roles.join(' o ')}`)
      return
  }
}

/**
 * Bodega no activa en el ERP (SE-05, contrato de la Ola 1 §4): con la organización activa en un
 * estado distinto de `ACTIVE` → 403 `ORG_NOT_ACTIVE` con el estado en `details`, salvo en las rutas
 * que lo permiten (`allowInactiveOrg`: lectura del perfil y de la bitácora propia en `SUSPENDED`).
 */
export function checkOrgActive(ctx: AuthContext, rule: AccessRule, allow: readonly CertificationStatus[] = []): void {
  if (rule.kind !== 'org' && rule.kind !== 'winery') return
  if (!ctx.wineryId || !ctx.organizationStatus || ctx.organizationStatus === 'ACTIVE') return
  if (allow.includes(ctx.organizationStatus)) return
  throw new ApiError(403, 'ORG_NOT_ACTIVE', 'La bodega no está activa', [fieldError(null, ctx.organizationStatus)])
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Bodega sobre la que trabaja una ruta `winery` (el `TenantGuard` del backend):
 * - Bodega activa: esa. Si la petición apunta a otra (`wineryId` en la query o el cuerpo) → 404.
 * - Plataforma: la de `?wineryId=`. Las lecturas pueden ir sin ella (todas las bodegas); las
 *   escrituras la exigen → 422 en `wineryId` (OP-07). Bodega inexistente → 404 `ORG_NOT_FOUND`.
 */
export function resolveTenant(ctx: AuthContext, method: string, query: URLSearchParams, body: unknown): AuthContext {
  const fromQuery = query.get('wineryId') || null
  if (ctx.organizationType === 'WINERY') {
    const fromBody = body && typeof body === 'object' ? (body as Record<string, unknown>).wineryId : undefined
    const target = fromQuery ?? (typeof fromBody === 'string' && fromBody ? fromBody : null)
    if (target && target !== ctx.wineryId) throw new ApiError(404, 'NOT_FOUND', 'Recurso no encontrado')
    return { ...ctx, tenantId: ctx.wineryId }
  }
  if (ctx.organizationType === 'PLATFORM') {
    if (!fromQuery) {
      if (!isReadMethod(method)) {
        throw invalid([fieldError('wineryId', 'El personal de plataforma debe indicar la bodega (?wineryId=) en las escrituras')])
      }
      return { ...ctx, tenantId: null }
    }
    if (!UUID_RE.test(fromQuery)) throw invalid([fieldError('wineryId', 'wineryId debe ser un UUID')])
    if (!getErpDb().wineries.some((w) => w.id === fromQuery)) throw new ApiError(404, 'ORG_NOT_FOUND', 'Bodega no encontrada')
    return { ...ctx, tenantId: fromQuery }
  }
  return { ...ctx, tenantId: null }
}

/** ¿Puede el usuario ver una entidad de esta bodega? (la plataforma sin `?wineryId=` ve todas). */
export function canSee(ctx: AuthContext, wineryId: string): boolean {
  if (ctx.tenantId) return ctx.tenantId === wineryId
  return ctx.isPlatformAdmin
}

/** Filtro multi-tenant de las listas (la bodega de la petición o, para la plataforma sin ella, todas). */
export function scoped<T extends { wineryId: string }>(ctx: AuthContext, items: readonly T[]): T[] {
  if (ctx.tenantId) return items.filter((i) => i.wineryId === ctx.tenantId)
  return ctx.isPlatformAdmin ? [...items] : []
}
