import { PLATFORM_ORGANIZATION } from './catalog'
import type { AuthTokens, Membership, MockUser, SessionResponse, WineryResponse } from './schemas'
import { uid } from '../shared/uuid'

// Respuestas compuestas que comparten el generador y los handlers MSW (funciones puras).

/** Vida del token de acceso en segundos (15 min, contrato de la Ola 0 §5). */
export const ACCESS_TOKEN_TTL_SECONDS = 900

/**
 * Membresías de una persona (contrato de la Ola 0 §4), en orden: plataforma antes que bodegas.
 * - `_mock.platformRole` → membresía de la organización de plataforma con ese rol.
 * - Cada `wineryMemberships[i]` → membresía `WINERY` con su rol; el id es el del miembro de la
 *   bodega; `isActive: false` → `BLOCKED`.
 * - Consumidores (y el cajero de demo) → ninguna (el POS llega en la Ola 5).
 */
export function deriveMemberships(user: MockUser, wineries: readonly WineryResponse[]): Membership[] {
  const out: Membership[] = []
  if (user._mock.platformRole) {
    out.push({
      id: uid(`membership:platform:${user.id}`),
      organizationId: PLATFORM_ORGANIZATION.id,
      organizationType: 'PLATFORM',
      organizationName: PLATFORM_ORGANIZATION.name,
      organizationStatus: PLATFORM_ORGANIZATION.status,
      role: user._mock.platformRole,
      status: user.isActive ? 'ACTIVE' : 'BLOCKED',
    })
  }
  for (const m of user.wineryMemberships) {
    const winery = wineries.find((w) => w.id === m.wineryId)
    if (!winery) continue
    const member = winery.members?.find((x) => x.userId === user.id)
    out.push({
      id: member?.id ?? uid(`membership:${winery.id}:${user.id}`),
      organizationId: winery.id,
      organizationType: 'WINERY',
      organizationName: winery.commercialName,
      organizationStatus: winery.certificationStatus,
      role: m.memberRole,
      status: m.isActive ? 'ACTIVE' : 'BLOCKED',
    })
  }
  return out
}

/** ¿Se puede activar esta membresía? (membresía `ACTIVE` y organización no `REVOKED`). */
export function isUsableMembership(m: Membership): boolean {
  return m.status === 'ACTIVE' && m.organizationStatus !== 'REVOKED'
}

/**
 * Organización activa: la preferida (la última usada) si sigue siendo utilizable; si no, la
 * primera membresía utilizable (plataforma antes que bodega); `null` si no hay.
 */
export function pickActiveOrganizationId(memberships: readonly Membership[], preferred?: string | null): string | null {
  const usable = memberships.filter(isUsableMembership)
  if (preferred && usable.some((m) => m.organizationId === preferred)) return preferred
  return usable[0]?.organizationId ?? null
}

/** Tokens estáticos de un usuario de demo (`mock.access.<clave>`): los de `auth-login.json`. */
export function staticTokens(user: MockUser): AuthTokens {
  return {
    accessToken: `mock.access.${user._mock.key}`,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  }
}

/**
 * Respuesta de sesión (login, signup, refresh, switch-organization) para una persona
 * (`auth_response` de `generate.py`). Sin `activeOrganizationId` usa la organización por defecto.
 */
export function buildSessionResponse(
  user: MockUser,
  wineries: readonly WineryResponse[],
  options: { activeOrganizationId?: string | null; tokens?: AuthTokens; memberships?: Membership[] } = {},
): SessionResponse {
  const memberships = options.memberships ?? deriveMemberships(user, wineries)
  const activeOrganizationId =
    options.activeOrganizationId === undefined ? pickActiveOrganizationId(memberships) : options.activeOrganizationId
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      preferredLocale: 'es',
      audience: memberships.length > 0 ? 'STAFF' : 'CONSUMER',
    },
    memberships,
    activeOrganizationId,
    tokens: options.tokens ?? staticTokens(user),
  }
}

/** Nombre de 0.1. */
export function buildAuthResponse(user: MockUser, wineries: readonly WineryResponse[]): SessionResponse {
  return buildSessionResponse(user, wineries)
}
