import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'
import { ReasonSchema, WineryCategorySchema, WineryStatusSchema } from './common'
import { InvitationSchema } from './invitations'

// Bodegas en el back office y perfil de la organización activa (contrato de la Ola 1 §4).

/** Prefijo del código de lote: 3–5 letras mayúsculas, único y definitivo (ORG-05). */
export const LotPrefixSchema = z.string().regex(/^[A-Z]{3,5}$/)

export const WinerySummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  legalName: z.string(),
  tradeName: z.string(),
  taxId: z.string(),
  category: WineryCategorySchema,
  region: z.string(),
  status: WineryStatusSchema,
  /** Asignado al activarse; `null` mientras la bodega está `INVITED`. */
  lotPrefix: LotPrefixSchema.nullable(),
  /** `userId: null` si el dueño aún no aceptó su invitación. */
  owner: z
    .object({
      userId: z.string().nullable(),
      fullName: z.string(),
      email: z.string(),
    })
    .nullable(),
  /** Membresías activas. */
  membersCount: z.number().int().min(0),
  createdAt: IsoDateTimeSchema,
  activatedAt: IsoDateTimeSchema.nullable(),
})
export type WinerySummary = z.infer<typeof WinerySummarySchema>

export const WineryStatusChangeSchema = z.object({
  status: WineryStatusSchema,
  at: IsoDateTimeSchema,
  /** Nombre de quien hizo el cambio (el dueño al activarse). */
  by: z.string(),
  reason: z.string().nullable(),
})
export type WineryStatusChange = z.infer<typeof WineryStatusChangeSchema>

export const WineryDetailSchema = WinerySummarySchema.extend({
  address: z.string().nullable(),
  senasagRegistration: z.string().nullable(),
  contactEmail: z.string(),
  contactPhone: z.string().nullable(),
  logoUrl: z.string().nullable(),
  publicStory: z.string().nullable(),
  website: z.string().nullable(),
  statusHistory: z.array(WineryStatusChangeSchema),
})
export type WineryDetail = z.infer<typeof WineryDetailSchema>

/** Campos del perfil que puede editar el dueño (`PATCH /v1/organizations/current`): sin NIT ni razón social. */
export const UpdateCurrentOrganizationSchema = z.object({
  tradeName: z.string().trim().min(2).max(120).optional(),
  address: z.string().trim().max(300).nullish(),
  senasagRegistration: z.string().trim().max(60).nullish(),
  contactEmail: z.email().optional(),
  contactPhone: z.string().trim().max(30).nullish(),
  logoUrl: z.string().max(500).nullish(),
  publicStory: z.string().trim().max(4000).nullish(),
  website: z.url().nullish(),
})
export type UpdateCurrentOrganizationDto = z.infer<typeof UpdateCurrentOrganizationSchema>

/** `PATCH /v1/platform/wineries/{id}`: todo el perfil, datos legales incluidos, con `reason`. */
export const UpdatePlatformWinerySchema = UpdateCurrentOrganizationSchema.extend({
  legalName: z.string().trim().min(2).max(200).optional(),
  taxId: z
    .string()
    .trim()
    .regex(/^\d{5,15}$/, 'El NIT debe tener entre 5 y 15 dígitos')
    .optional(),
  category: WineryCategorySchema.optional(),
  region: z.string().trim().min(2).max(120).optional(),
  reason: ReasonSchema,
})
export type UpdatePlatformWineryDto = z.infer<typeof UpdatePlatformWinerySchema>

/** `POST /v1/platform/wineries` (alta directa, camino B). */
export const CreatePlatformWinerySchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(2).max(120),
  taxId: z
    .string()
    .trim()
    .regex(/^\d{5,15}$/, 'El NIT debe tener entre 5 y 15 dígitos'),
  category: WineryCategorySchema,
  region: z.string().trim().min(2).max(120),
  address: z.string().trim().max(300).nullish(),
  senasagRegistration: z.string().trim().max(60).nullish(),
  contactEmail: z.email(),
  contactPhone: z.string().trim().max(30).nullish(),
  logoUrl: z.string().max(500).nullish(),
  publicStory: z.string().trim().max(4000).nullish(),
  website: z.url().nullish(),
  ownerEmail: z.email(),
  ownerFullName: z.string().trim().min(1).max(120),
  reason: ReasonSchema.nullish(),
})
export type CreatePlatformWineryDto = z.infer<typeof CreatePlatformWinerySchema>

/** Respuesta del alta directa y de la transferencia de titularidad. */
export const WineryWithInvitationSchema = z.object({
  winery: WineryDetailSchema,
  invitation: InvitationSchema,
})
export type WineryWithInvitation = z.infer<typeof WineryWithInvitationSchema>

/** `POST /v1/platform/wineries/{id}/suspend` · `/reactivate` · `/revoke`. */
export const WineryStatusActionSchema = z.object({
  reason: ReasonSchema,
})
export type WineryStatusActionDto = z.infer<typeof WineryStatusActionSchema>

/** `POST /v1/platform/wineries/{id}/transfer-ownership` (solo ADMIN). */
export const TransferOwnershipSchema = z.object({
  newOwnerEmail: z.email(),
  reason: ReasonSchema,
  /** Qué pasa con el dueño anterior al aceptar el nuevo. Por defecto `BLOCKED`. */
  keepPreviousOwnerAs: z.enum(['ENOLOGIST', 'BLOCKED']).default('BLOCKED'),
})
export type TransferOwnershipDto = z.infer<typeof TransferOwnershipSchema>

/** `GET /v1/public/wineries/{slug}` (solo bodegas `ACTIVE`). */
export const PublicWineryProfileSchema = z.object({
  slug: z.string(),
  tradeName: z.string(),
  region: z.string(),
  category: WineryCategorySchema,
  logoUrl: z.string().nullable(),
  publicStory: z.string().nullable(),
  website: z.string().nullable(),
})
export type PublicWineryProfile = z.infer<typeof PublicWineryProfileSchema>
