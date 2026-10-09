import { PLATFORM_ROLES, type MembershipRole, type PlatformRole } from '../erp/schemas/organizations'
import type { PermissionLevel, PermissionMatrix } from './schemas/dashboard'

// Matriz de permisos de la Ola 1 (`GET /v1/platform/permissions`, PLT-04): contrato §9 y
// docs-back/05 §3, más la capacidad `waitlist` del contrato O1b (backend v0.1.1). El superusuario
// tiene lo mismo que administración y no se puede bloquear.

type Row = [key: string, label: string, levels: Partial<Record<MembershipRole, PermissionLevel>>]

const WINERY_OTHERS = ['ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT'] as const
const others = (level: PermissionLevel) => Object.fromEntries(WINERY_OTHERS.map((r) => [r, level]))

const ROWS: Row[] = [
  ['platform.users', 'Usuarios internos', { SUPERADMIN: 'FULL', ADMIN: 'FULL' }],
  ['settings', 'Configuración', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'READ', SUPPORT: 'READ', OWNER: 'READ', ...others('READ') }],
  ['applications', 'Solicitudes y alta de bodegas', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL', SUPPORT: 'READ' }],
  ['waitlist', 'Lista de espera', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL', SUPPORT: 'READ' }],
  ['wineries.suspend', 'Suspender y reactivar bodegas', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL' }],
  [
    'wineries.revoke',
    'Revocar bodega, transferir titularidad, bloquear cuenta completa',
    { SUPERADMIN: 'FULL', ADMIN: 'FULL' },
  ],
  ['team', 'Equipo de una bodega', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL', SUPPORT: 'FULL', OWNER: 'OWN', ...others('READ') }],
  ['audit', 'Bitácora', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL', SUPPORT: 'FULL', OWNER: 'OWN' }],
  // Ola 3 (contrato O3 §10; `permissions.ts` del backend en la apertura)
  ['tokenization', 'Tokenización: bandeja, colecciones y cierre con faltante', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL', SUPPORT: 'READ', OWNER: 'OWN', ENOLOGIST: 'READ', ACCOUNTANT: 'READ' }],
  ['chain', 'Cadena: transacciones, identidad de las bodegas, conciliación y alertas', { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL', SUPPORT: 'READ', OWNER: 'READ', ...others('READ') }],
  ['chain.admin', 'Abandonar transacciones, pausar o reanudar un contrato en la red y quemar NFT sin vender', { SUPERADMIN: 'FULL', ADMIN: 'FULL' }],
]

const ALL_ROLES: readonly MembershipRole[] = [
  'SUPERADMIN',
  'ADMIN',
  'OPERATIONS',
  'SUPPORT',
  'OWNER',
  'ENOLOGIST',
  'AGRONOMIST',
  'OPERATOR',
  'ACCOUNTANT',
  'MANAGER',
  'CASHIER',
]

export const PERMISSION_MATRIX: PermissionMatrix = {
  capabilities: ROWS.map(([key, label, levels]) => ({
    key,
    label,
    roles: Object.fromEntries(ALL_ROLES.map((r) => [r, levels[r] ?? 'NONE'])) as Record<MembershipRole, PermissionLevel>,
  })),
}

/**
 * Roles de plataforma con alguno de los niveles en una capacidad (como `platformRolesWith` del
 * backend, de donde salen los `@Roles(...)` de las rutas): p. ej. `platformRolesWith('waitlist', 'FULL')`.
 */
export function platformRolesWith(key: string, ...levels: PermissionLevel[]): PlatformRole[] {
  const capability = PERMISSION_MATRIX.capabilities.find((c) => c.key === key)
  if (!capability) throw new Error(`Capacidad desconocida: ${key}`)
  return PLATFORM_ROLES.filter((role) => levels.includes(capability.roles[role]))
}
