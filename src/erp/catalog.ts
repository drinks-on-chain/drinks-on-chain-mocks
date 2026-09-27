import type { PlatformRole } from './schemas/organizations'
import { uid } from '../shared/uuid'

// Catálogo fijo de la red de prueba que no forma parte de los DTO.

/** Código de bodega (por clave legible) para `internationalLotCode` = `{BODEGA}-{AÑO}-{TIPO}-{SEQ}`. */
export const WINERY_CODES: Record<string, string> = {
  altos: 'ALT',
  cintiviejo: 'CVJ',
  guadalquivir: 'VGQ',
  uriondo: 'CUR',
  valle: 'VES',
}

/** Mismo mapa indexado por id de bodega (UUID v5 de `winery:<clave>`). */
export const WINERY_CODES_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(WINERY_CODES).map(([key, code]) => [uid(`winery:${key}`), code]),
)

/** Organización de plataforma (la del seeder del backend). Sus miembros son el personal interno. */
export const PLATFORM_ORGANIZATION = {
  id: uid('organization:platform'),
  type: 'PLATFORM',
  name: 'Drinks on Chain',
  status: 'ACTIVE',
} as const

/**
 * Rol de plataforma del personal interno de los fixtures (`_mock.platformRole`, solo en los mocks).
 * El superusuario lo crea el seeder; el resto entró por invitación (contrato de la Ola 1 §5).
 */
export const PLATFORM_ROLE_BY_KEY: Record<string, PlatformRole> = {
  admin: 'SUPERADMIN',
  soporte: 'SUPPORT',
  bo_admin: 'ADMIN',
  operaciones: 'OPERATIONS',
  analista: 'OPERATIONS',
}
