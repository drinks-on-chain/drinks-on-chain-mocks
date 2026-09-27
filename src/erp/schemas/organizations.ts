import { z } from 'zod'
import { CERTIFICATION_STATUSES, MEMBER_ROLES } from './enums'

// Organizaciones y membresías (contrato de la Ola 0 §4,
// plan/contratos/o0-sesiones-y-estandares.md). Una persona puede tener varias membresías;
// un consumidor no tiene ninguna.

export const ORGANIZATION_TYPES = ['PLATFORM', 'WINERY', 'PICKUP_POINT'] as const
export const OrganizationTypeSchema = z.enum(ORGANIZATION_TYPES)
export type OrganizationType = z.infer<typeof OrganizationTypeSchema>

/** Estado de la organización: el de certificación de la bodega (`PENDING`…`REVOKED`). */
export const ORGANIZATION_STATUSES = CERTIFICATION_STATUSES
export const OrganizationStatusSchema = z.enum(ORGANIZATION_STATUSES)
export type OrganizationStatus = z.infer<typeof OrganizationStatusSchema>

export const PLATFORM_ROLES = ['SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT'] as const
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES)
export type PlatformRole = z.infer<typeof PlatformRoleSchema>

/** Roles en una bodega: los mismos que `memberRole`. */
export const WINERY_ROLES = MEMBER_ROLES
export const WineryRoleSchema = z.enum(WINERY_ROLES)
export type WineryRole = z.infer<typeof WineryRoleSchema>

export const PICKUP_POINT_ROLES = ['MANAGER', 'CASHIER'] as const
export const PickupPointRoleSchema = z.enum(PICKUP_POINT_ROLES)
export type PickupPointRole = z.infer<typeof PickupPointRoleSchema>

export const MEMBERSHIP_ROLES = [...PLATFORM_ROLES, ...WINERY_ROLES, ...PICKUP_POINT_ROLES] as const
export const MembershipRoleSchema = z.enum(MEMBERSHIP_ROLES)
export type MembershipRole = PlatformRole | WineryRole | PickupPointRole

/** `INVITED` llega en la Ola 1. */
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'BLOCKED'] as const
export const MembershipStatusSchema = z.enum(MEMBERSHIP_STATUSES)
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>

/** `STAFF`: tiene al menos una membresía. `CONSUMER`: ninguna. */
export const AUDIENCES = ['STAFF', 'CONSUMER'] as const
export const AudienceSchema = z.enum(AUDIENCES)
export type Audience = z.infer<typeof AudienceSchema>

export const MembershipSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationType: OrganizationTypeSchema,
  organizationName: z.string(),
  organizationStatus: OrganizationStatusSchema,
  role: MembershipRoleSchema,
  status: MembershipStatusSchema,
})
export type Membership = z.infer<typeof MembershipSchema>

/** `POST /v1/auth/switch-organization`. */
export const SwitchOrganizationSchema = z.object({
  organizationId: z.string().min(1),
})
export type SwitchOrganizationDto = z.infer<typeof SwitchOrganizationSchema>

/**
 * Claims del token de acceso (contrato §5). `email`, `userRole`, `wineryId` y `memberRole` se
 * mantienen por compatibilidad hasta H1. Los tokens de los mocks tienen forma de JWT con
 * firma `mock` (no se verifican criptográficamente).
 */
export const AccessTokenClaimsSchema = z.object({
  sub: z.string(),
  aud: AudienceSchema,
  org: z.string().nullable(),
  orgType: OrganizationTypeSchema.nullable(),
  role: MembershipRoleSchema.nullable(),
  sid: z.string(),
  jti: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  email: z.string(),
  userRole: z.string(),
  wineryId: z.string().nullable(),
  memberRole: z.string().nullable(),
})
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>
