import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { MemberRoleSchema, UserRoleSchema } from './enums'
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

export const UpdateUserSchema = z.object({
  fullName: z.string().min(1).nullish(),
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string().nullish(),
})
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>

/** Metadatos solo de los mocks: clave legible y contraseña de demo. No existen en el backend. */
export const MockUserMetaSchema = z.object({
  key: z.string(),
  password: z.string(),
})

/** Fila de `users.json`: el DTO real más `_mock`. */
export const MockUserSchema = UserProfileResponseSchema.extend({
  _mock: MockUserMetaSchema,
})
export type MockUser = z.infer<typeof MockUserSchema>
