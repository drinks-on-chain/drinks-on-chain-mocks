import { z } from 'zod'

// Enumeraciones del backend del ERP, copiadas tal cual del OpenAPI (doc 09 §4).

export const USER_ROLES = ['PLATFORM_ADMIN', 'WINERY_ADMIN', 'ENOLOGIST', 'AGRONOMIST', 'CONSUMER', 'POS_OPERATOR'] as const
export const UserRoleSchema = z.enum(USER_ROLES)
export type UserRole = z.infer<typeof UserRoleSchema>

/** Roles admitidos en `POST /v1/auth/signup`. */
export const SIGNUP_ROLES = ['CONSUMER', 'WINERY_ADMIN'] as const
export const SignupRoleSchema = z.enum(SIGNUP_ROLES)
export type SignupRole = z.infer<typeof SignupRoleSchema>

export const MEMBER_ROLES = ['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT'] as const
export const MemberRoleSchema = z.enum(MEMBER_ROLES)
export type MemberRole = z.infer<typeof MemberRoleSchema>

export const BEVERAGE_CATEGORIES = ['WINERY', 'BREWERY', 'DISTILLERY', 'OTHER'] as const
export const BeverageCategorySchema = z.enum(BEVERAGE_CATEGORIES)
export type BeverageCategory = z.infer<typeof BeverageCategorySchema>

export const CERTIFICATION_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const
export const CertificationStatusSchema = z.enum(CERTIFICATION_STATUSES)
export type CertificationStatus = z.infer<typeof CertificationStatusSchema>

export const WALLET_TYPES = ['CUSTODIAL', 'SELF_CUSTODY'] as const
export const WalletTypeSchema = z.enum(WALLET_TYPES)
export type WalletType = z.infer<typeof WalletTypeSchema>

export const WALLET_PURPOSES = ['CONSUMER_NFT', 'PRODUCER_SIGNING'] as const
export const WalletPurposeSchema = z.enum(WALLET_PURPOSES)
export type WalletPurpose = z.infer<typeof WalletPurposeSchema>

export const PHYTOSANITARY_STATUSES = ['PENDING_INSPECTION', 'APPROVED', 'REJECTED', 'QUARANTINE'] as const
export const PhytosanitaryStatusSchema = z.enum(PHYTOSANITARY_STATUSES)
export type PhytosanitaryStatus = z.infer<typeof PhytosanitaryStatusSchema>

export const DESTINATION_TYPES = ['WINE_AGING', 'SINGANI_DIST', 'BEER_MATURATION', 'SPIRITS_DIST', 'OTHER'] as const
export const DestinationTypeSchema = z.enum(DESTINATION_TYPES)
export type DestinationType = z.infer<typeof DestinationTypeSchema>

export const TANK_STATUSES = ['FILLING', 'FERMENTING', 'COMPLETED', 'TRANSFERRED', 'CLEANED'] as const
export const TankStatusSchema = z.enum(TANK_STATUSES)
export type TankStatus = z.infer<typeof TankStatusSchema>

export const TREATMENT_TYPES = [
  'ACIDITY_CORRECTION',
  'SO2_ADDITION',
  'CLARIFICATION',
  'FILTRATION_AID',
  'NUTRIENT_ADDITION',
  'ENZYME_ADDITION',
  'OAK_CHIPS',
  'FINING_AGENT',
  'STABILIZATION',
  'OTHER',
] as const
export const TreatmentTypeSchema = z.enum(TREATMENT_TYPES)
export type TreatmentType = z.infer<typeof TreatmentTypeSchema>

export const AGING_STATUSES = ['AGING', 'READY', 'BOTTLED', 'DISCARDED'] as const
export const AgingStatusSchema = z.enum(AGING_STATUSES)
export type AgingStatus = z.infer<typeof AgingStatusSchema>

export const PROCESS_TYPES = [
  'SINGANI_DISTILLATION',
  'SPIRITS_DISTILLATION',
  'BEER_MATURATION',
  'SECONDARY_FERMENTATION',
  'OTHER',
] as const
export const ProcessTypeSchema = z.enum(PROCESS_TYPES)
export type ProcessType = z.infer<typeof ProcessTypeSchema>

export const REST_STATUSES = ['NOT_REQUIRED', 'RESTING', 'READY', 'BOTTLED', 'DISCARDED'] as const
export const RestStatusSchema = z.enum(REST_STATUSES)
export type RestStatus = z.infer<typeof RestStatusSchema>

export const PRODUCT_TYPES = ['WINE', 'SINGANI', 'BEER', 'SPIRITS', 'CIDER', 'MEAD', 'OTHER'] as const
export const ProductTypeSchema = z.enum(PRODUCT_TYPES)
export type ProductType = z.infer<typeof ProductTypeSchema>
