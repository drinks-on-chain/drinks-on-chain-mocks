import { deriveMemberships, isUsableMembership, pickActiveOrganizationId, USER_ROLE_FOR_MEMBER } from '../derive'
import type { Audience, MemberRole, Membership, MembershipRole, MockUser, OrganizationType, UserRole } from '../schemas'
import { getErpDb } from './db'
import { forbidden, sessionRevoked, unauthorized } from './errors'
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
// Los roles de las rutas se evalúan con el `userRole` equivalente a la membresía activa
// (contrato de la Ola 0 §6), así los usuarios de una sola bodega se comportan como en 0.1.

export interface AuthContext {
  user: MockUser
  key: string
  /** `userRole` efectivo en la organización activa (el de la persona si no hay organización). */
  role: UserRole
  isPlatformAdmin: boolean
  /** Bodega activa; `null` para la plataforma, consumidores y cajeros. */
  wineryId: string | null
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

export function membershipsOf(user: MockUser): Membership[] {
  return deriveMemberships(user, getErpDb().wineries)
}

/** Organización activa por defecto: la última usada si sigue siendo válida o la primera utilizable. */
export function defaultOrganizationId(user: MockUser, memberships = membershipsOf(user)): string | null {
  return pickActiveOrganizationId(memberships, lastOrganizationOf(user.id))
}

/** Contexto de una persona en una organización (`undefined` → la de por defecto). */
export function contextFor(user: MockUser, organizationId?: string | null, sid: string | null = null): AuthContext {
  const memberships = membershipsOf(user)
  const orgId = organizationId === undefined ? defaultOrganizationId(user, memberships) : organizationId
  const active = orgId ? memberships.find((m) => m.organizationId === orgId) : undefined
  const winery = active?.organizationType === 'WINERY' ? active : undefined
  let role: UserRole = user.userRole
  if (active?.organizationType === 'PLATFORM') role = 'PLATFORM_ADMIN'
  else if (winery) role = USER_ROLE_FOR_MEMBER[winery.role as MemberRole]
  return {
    user,
    key: user._mock.key,
    role,
    isPlatformAdmin: role === 'PLATFORM_ADMIN',
    wineryId: winery?.organizationId ?? null,
    memberRole: (winery?.role as MemberRole | undefined) ?? null,
    memberId: winery?.id ?? null,
    audience: memberships.length > 0 ? 'STAFF' : 'CONSUMER',
    memberships,
    organizationId: active?.organizationId ?? null,
    organizationType: active?.organizationType ?? null,
    membershipRole: active?.role ?? null,
    sid,
  }
}

/** Lee el Bearer; devuelve `null` si no hay cabecera y lanza 401 si el token no es válido. */
export function readAuth(request: Request): AuthContext | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1] ?? ''
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    const user = findUserByKey(token.slice(ACCESS_TOKEN_PREFIX.length))
    if (!user || !user.isActive) throw unauthorized()
    return contextFor(user)
  }
  const claims = decodeAccessToken(token)
  if (!claims) throw unauthorized()
  if (isExpired(claims)) throw unauthorized('Token de acceso expirado')
  const user = findUserById(claims.sub)
  if (!user) throw unauthorized()
  // Una sesión desconocida (p. ej. almacenamiento borrado) se acepta con los datos del token.
  const session = getSession(claims.sid)
  if (session?.revoked) throw sessionRevoked()
  const ctx = contextFor(user, claims.org, claims.sid)
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
  if (!ctx) throw unauthorized()
  return ctx
}

// ---------------------------------------------------------------------------
// Reglas de acceso por ruta (doc 09 §3 y catálogo del backend)
// ---------------------------------------------------------------------------

/**
 * - `authenticated`: cualquier usuario con sesión.
 * - `member`: usuario con bodega activa (el "miembros" del doc 09 §3); el gestor también lee.
 * - `roles`: lista de `userRole` efectivos; con `adminReads` el PLATFORM_ADMIN también pasa (lecturas).
 */
export type AccessRule =
  | { kind: 'authenticated' }
  | { kind: 'member' }
  | { kind: 'roles'; roles: readonly UserRole[]; adminReads?: boolean }

export const anyUser: AccessRule = { kind: 'authenticated' }
export const members: AccessRule = { kind: 'member' }
export const roles = (list: readonly UserRole[], opts: { adminReads?: boolean } = {}): AccessRule => ({
  kind: 'roles',
  roles: list,
  adminReads: opts.adminReads ?? false,
})

export function checkAccess(ctx: AuthContext, rule: AccessRule): void {
  switch (rule.kind) {
    case 'authenticated':
      return
    case 'member':
      if (ctx.isPlatformAdmin || ctx.wineryId) return
      throw forbidden('Requiere ser miembro de una bodega')
    case 'roles':
      if (rule.roles.includes(ctx.role)) return
      if (rule.adminReads && ctx.isPlatformAdmin) return
      throw forbidden(`Requiere rol ${rule.roles.join(' o ')}`)
  }
}

/** ¿Puede el usuario ver una entidad de esta bodega? (el gestor ve todo). */
export function canSee(ctx: AuthContext, wineryId: string): boolean {
  return ctx.isPlatformAdmin || ctx.wineryId === wineryId
}

/** Filtro multi-tenant de las listas. */
export function scoped<T extends { wineryId: string }>(ctx: AuthContext, items: readonly T[]): T[] {
  return ctx.isPlatformAdmin ? [...items] : items.filter((i) => i.wineryId === ctx.wineryId)
}
