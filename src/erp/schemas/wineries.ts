import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { BeverageCategorySchema, CertificationStatusSchema, MemberRoleSchema } from './enums'

// /v1/wineries · WineryResponseDto y DTO de alta, edición y miembros

export const WineryMemberItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  fullName: z.string(),
  email: z.string(),
  memberRole: MemberRoleSchema,
  professionalLicenseNumber: z.string().nullish(),
  isActive: z.boolean(),
  joinedAt: IsoDateTimeSchema,
})
export type WineryMemberItem = z.infer<typeof WineryMemberItemSchema>

export const WineryResponseSchema = z.object({
  id: z.string(),
  legalName: z.string(),
  commercialName: z.string(),
  beverageCategory: BeverageCategorySchema,
  taxIdNit: z.string(),
  senasagSanitaryReg: z.string().nullish(),
  geographicRegion: z.string(),
  countryCode: z.string(),
  address: z.string().nullish(),
  contactEmail: z.string(),
  contactPhone: z.string().nullish(),
  logoUrl: z.string().nullish(),
  stellarPublicKey: z.string().nullish(),
  onchainProducerId: z.string().nullish(),
  onchainRegisterTxHash: z.string().nullish(),
  isExportCertified: z.boolean(),
  certificationStatus: CertificationStatusSchema,
  approvedAt: IsoDateTimeSchema.nullish(),
  createdAt: IsoDateTimeSchema,
  members: z.array(WineryMemberItemSchema).nullish(),
})
export type WineryResponse = z.infer<typeof WineryResponseSchema>

export const UpdateWinerySchema = z.object({
  commercialName: z.string().min(1).optional(),
  address: z.string().nullish(),
  contactEmail: z.email().optional(),
  contactPhone: z.string().nullish(),
  logoUrl: z.string().nullish(),
})
export type UpdateWineryDto = z.infer<typeof UpdateWinerySchema>
