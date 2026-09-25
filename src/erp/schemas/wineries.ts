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

export const CreateWinerySchema = z.object({
  legalName: z.string().min(1),
  commercialName: z.string().min(1),
  beverageCategory: BeverageCategorySchema,
  taxIdNit: z.string().min(1),
  senasagSanitaryReg: z.string().nullish(),
  geographicRegion: z.string().min(1),
  countryCode: z.string().nullish(),
  address: z.string().nullish(),
  contactEmail: z.email(),
  contactPhone: z.string().nullish(),
  logoUrl: z.string().nullish(),
})
export type CreateWineryDto = z.infer<typeof CreateWinerySchema>

export const UpdateWinerySchema = z.object({
  commercialName: z.string().min(1).nullish(),
  address: z.string().nullish(),
  contactEmail: z.email().nullish(),
  contactPhone: z.string().nullish(),
  logoUrl: z.string().nullish(),
})
export type UpdateWineryDto = z.infer<typeof UpdateWinerySchema>

export const AddMemberSchema = z.object({
  userId: z.string().min(1),
  memberRole: MemberRoleSchema,
  professionalLicenseNumber: z.string().nullish(),
  professionalLicensePdfUrl: z.string().nullish(),
})
export type AddMemberDto = z.infer<typeof AddMemberSchema>

export const CreateMemberSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  fullName: z.string().min(1),
  memberRole: MemberRoleSchema,
  phoneNumber: z.string().nullish(),
  professionalLicenseNumber: z.string().nullish(),
  professionalLicensePdfUrl: z.string().nullish(),
})
export type CreateMemberDto = z.infer<typeof CreateMemberSchema>

export const ApproveWinerySchema = z.object({
  approvalNotes: z.string().nullish(),
})
export type ApproveWineryDto = z.infer<typeof ApproveWinerySchema>

export const RejectWinerySchema = z.object({
  rejectionReason: z.string().min(1),
})
export type RejectWineryDto = z.infer<typeof RejectWinerySchema>
