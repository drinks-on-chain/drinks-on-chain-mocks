import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { MemberRoleSchema, UserRoleSchema } from './enums'
import { AudienceSchema, MembershipSchema, PlatformRoleSchema } from './organizations'
import { WalletResponseSchema } from './wallets'

// GET/PATCH /v1/users/me · UserProfileResponseDto

export const WineryMembershipSchema = z.object({
  wineryId: z.string(),
  wineryName: z.string(),
  memberRole: MemberRoleSchema,
  professionalLicenseNumber: z.string().nullish(),
  isActive: z.boolean(),
  joinedAt: IsoDateTimeSchema,
})
export type WineryMembership = z.infer<typeof WineryMembershipSchema>

export const UserProfileResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  userRole: UserRoleSchema,
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string(),
  isActive: z.boolean(),
  lastLoginAt: IsoDateTimeSchema.nullish(),
  createdAt: IsoDateTimeSchema,
  wineryMemberships: z.array(WineryMembershipSchema),
  primaryWallet: WalletResponseSchema.nullish(),
})
export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>

/** Preferencias de notificación (contrato de la Ola 1 §1, IAM-09). */
export const NotificationPrefsSchema = z.object({
  lotProgress: z.boolean(),
  redemptionReminders: z.boolean(),
})
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>

/** Preferencias de una persona que aún no las cambió. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { lotProgress: true, redemptionReminders: true }

/**
 * `GET /v1/users/me` (contrato de la Ola 0 §5): `{ user, memberships, activeOrganizationId }`.
 * `user` es el perfil de 0.1 más `audience` y, desde la Ola 1, `notificationPrefs` y
 * `promotionsConsent` (IAM-09).
 */
export const MeUserSchema = UserProfileResponseSchema.extend({
  audience: AudienceSchema,
  notificationPrefs: NotificationPrefsSchema.optional(),
  promotionsConsent: z.boolean().optional(),
})
export type MeUser = z.infer<typeof MeUserSchema>

export const MeResponseSchema = z.object({
  user: MeUserSchema,
  memberships: z.array(MembershipSchema),
  activeOrganizationId: z.string().nullable(),
})
export type MeResponse = z.infer<typeof MeResponseSchema>

/**
 * `PATCH /v1/users/me`. `notificationPrefs` y `promotionsConsent` llegan con la Ola 1 (IAM-09);
 * `notificationPrefs` admite cambios parciales.
 */
export const UpdateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string().optional(),
  notificationPrefs: NotificationPrefsSchema.partial().optional(),
  promotionsConsent: z.boolean().optional(),
})
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>

/** Metadatos solo de los mocks: clave legible y contraseña de demo. No existen en el backend. */
export const MockUserMetaSchema = z.object({
  key: z.string(),
  password: z.string(),
  /** Rol en la organización de plataforma (personal interno, contrato de la Ola 1 §5). */
  platformRole: PlatformRoleSchema.optional(),
})

/** Fila de `users.json`: el DTO real más `_mock`. */
export const MockUserSchema = UserProfileResponseSchema.extend({
  _mock: MockUserMetaSchema,
})
export type MockUser = z.infer<typeof MockUserSchema>
