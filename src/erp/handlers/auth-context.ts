import type { MemberRole, MockUser, UserRole } from '../schemas'
import { getErpDb } from './db'
import { forbidden, unauthorized } from './errors'

// Sesión simulada: el token `mock.access.<clave>` identifica al usuario de users.json (o a uno
// creado en la sesión); su bodega activa es la de su primera membresía (como el login real).

export interface AuthContext {
  user: MockUser
  key: string
  role: UserRole
  isPlatformAdmin: boolean
  /** Bodega activa del token; `null` para gestores, consumidores y cajeros. */
  wineryId: string | null
  memberRole: MemberRole | null
  /** Id de miembro en la bodega activa (autor de lecturas, dictámenes, embotellados…). */
  memberId: string | null
}

export const ACCESS_TOKEN_PREFIX = 'mock.access.'
export const REFRESH_TOKEN_PREFIX = 'mock.refresh.'

/** Token Bearer de prueba para un usuario (`_mock.key`). */
export function mockAccessToken(key: string): string {
  return `${ACCESS_TOKEN_PREFIX}${key}`
}

export function findUserByKey(key: string): MockUser | undefined {
  return getErpDb().users.find((u) => u._mock.key === key)
}

export function contextFor(user: MockUser): AuthContext {
  const membership = user.wineryMemberships.find((m) => m.isActive) ?? null
  const wineryId = membership?.wineryId ?? null
  const winery = wineryId ? getErpDb().wineries.find((w) => w.id === wineryId) : undefined
  const member = winery?.members?.find((m) => m.userId === user.id)
  return {
    user,
    key: user._mock.key,
    role: user.userRole,
    isPlatformAdmin: user.userRole === 'PLATFORM_ADMIN',
    wineryId,
    memberRole: membership?.memberRole ?? null,
    memberId: member?.id ?? null,
  }
}

/** Lee el Bearer; devuelve `null` si no hay cabecera y lanza 401 si el token no es válido. */
export function readAuth(request: Request): AuthContext | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1]
  if (!token?.startsWith(ACCESS_TOKEN_PREFIX)) throw unauthorized()
  const user = findUserByKey(token.slice(ACCESS_TOKEN_PREFIX.length))
  if (!user || !user.isActive) throw unauthorized()
  return contextFor(user)
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
 * - `roles`: lista de `userRole`; con `adminReads` el PLATFORM_ADMIN también pasa (lecturas).
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
