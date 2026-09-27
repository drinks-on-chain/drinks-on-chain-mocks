import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'
import { CaptchaTokenSchema, OptionalReasonSchema, PersonRefSchema, ReasonSchema, WineryCategorySchema } from './common'
import { InvitationSchema } from './invitations'
import { WineryDetailSchema } from './wineries'

// Solicitudes de alta de bodega (contrato de la Ola 1 §3; proceso en docs-back/07 §1.2).

export const APPLICATION_STATUSES = ['UNVERIFIED', 'RECEIVED', 'IN_REVIEW', 'MEETING_SCHEDULED', 'APPROVED', 'REJECTED'] as const
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES)
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>

/** Transiciones permitidas; cualquier otra → 409 `APPLICATION_INVALID_TRANSITION`. */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  UNVERIFIED: ['RECEIVED'],
  RECEIVED: ['IN_REVIEW'],
  IN_REVIEW: ['MEETING_SCHEDULED', 'APPROVED', 'REJECTED'],
  MEETING_SCHEDULED: ['IN_REVIEW'],
  APPROVED: [],
  REJECTED: [],
}

/** Solicitudes abiertas (cuentan para `ORG_TAX_ID_TAKEN`). */
export const OPEN_APPLICATION_STATUSES: readonly ApplicationStatus[] = ['UNVERIFIED', 'RECEIVED', 'IN_REVIEW', 'MEETING_SCHEDULED']

export const MEETING_CHANNELS = ['CALL', 'VIDEO', 'IN_PERSON'] as const
export const MeetingChannelSchema = z.enum(MEETING_CHANNELS)
export type MeetingChannel = z.infer<typeof MeetingChannelSchema>

export const ApplicationNoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** Nombre de quien la escribió. */
  by: z.string(),
  at: IsoDateTimeSchema,
})
export type ApplicationNote = z.infer<typeof ApplicationNoteSchema>

/** Elemento de la bandeja (`GET /v1/platform/winery-applications`): sin `notes`. */
export const WineryApplicationSummarySchema = z.object({
  id: z.string(),
  status: ApplicationStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  legalName: z.string(),
  tradeName: z.string(),
  /** NIT. */
  taxId: z.string(),
  category: WineryCategorySchema,
  region: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string().nullable(),
  message: z.string().nullable(),
  assignee: PersonRefSchema.nullable(),
  meeting: z
    .object({
      scheduledAt: IsoDateTimeSchema,
      channel: MeetingChannelSchema,
      notes: z.string().nullable(),
    })
    .nullable(),
  decision: z
    .object({
      /** Nombre de quien aprobó o rechazó. */
      by: z.string(),
      at: IsoDateTimeSchema,
      reason: z.string().nullable(),
    })
    .nullable(),
  wineryId: z.string().nullable(),
})
export type WineryApplicationSummary = z.infer<typeof WineryApplicationSummarySchema>

/** Detalle (`GET /v1/platform/winery-applications/{id}`): con `notes`. */
export const WineryApplicationSchema = WineryApplicationSummarySchema.extend({
  notes: z.array(ApplicationNoteSchema),
})
export type WineryApplication = z.infer<typeof WineryApplicationSchema>

/** NIT boliviano: solo dígitos (5 a 15). */
export const TaxIdSchema = z.string().trim().regex(/^\d{5,15}$/, 'El NIT debe tener entre 5 y 15 dígitos')

/** `POST /v1/public/winery-applications` (sitio de bodegas `/unirse`). */
export const CreateWineryApplicationSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(2).max(120),
  taxId: TaxIdSchema,
  category: WineryCategorySchema,
  region: z.string().trim().min(2).max(120),
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.email(),
  contactPhone: z.string().trim().max(30).nullish(),
  message: z.string().trim().max(2000).nullish(),
  captchaToken: CaptchaTokenSchema,
  /** Campo trampa: debe llegar vacío; si no, 202 silencioso sin crear nada. */
  website: z.string().nullish(),
})
export type CreateWineryApplicationDto = z.infer<typeof CreateWineryApplicationSchema>

export const CreateWineryApplicationResponseSchema = z.object({
  id: z.string(),
  status: z.literal('UNVERIFIED'),
})
export type CreateWineryApplicationResponse = z.infer<typeof CreateWineryApplicationResponseSchema>

/** `POST /v1/public/winery-applications/verify` → 204. */
export const VerifyWineryApplicationSchema = z.object({
  token: z.string().min(1),
})
export type VerifyWineryApplicationDto = z.infer<typeof VerifyWineryApplicationSchema>

export const AddApplicationNoteSchema = z.object({
  text: z.string().trim().min(1).max(2000),
})
export type AddApplicationNoteDto = z.infer<typeof AddApplicationNoteSchema>

export const ScheduleMeetingSchema = z.object({
  scheduledAt: z.iso.datetime({ offset: true }),
  channel: MeetingChannelSchema,
  notes: z.string().trim().max(2000).nullish(),
})
export type ScheduleMeetingDto = z.infer<typeof ScheduleMeetingSchema>

export const MeetingDoneSchema = z.object({
  notes: z.string().trim().min(1).max(2000),
})
export type MeetingDoneDto = z.infer<typeof MeetingDoneSchema>

/** `POST …/{id}/approve`: por defecto el dueño es el contacto de la solicitud. */
export const ApproveApplicationSchema = z.object({
  ownerEmail: z.email().nullish(),
  ownerFullName: z.string().trim().min(1).max(120).nullish(),
  reason: OptionalReasonSchema,
})
export type ApproveApplicationDto = z.infer<typeof ApproveApplicationSchema>

export const RejectApplicationSchema = z.object({
  reason: ReasonSchema,
})
export type RejectApplicationDto = z.infer<typeof RejectApplicationSchema>

/** Respuesta de `POST …/{id}/approve`: crea la bodega `INVITED` e invita al dueño. */
export const ApproveApplicationResponseSchema = z.object({
  application: WineryApplicationSchema,
  winery: WineryDetailSchema,
  invitation: InvitationSchema,
})
export type ApproveApplicationResponse = z.infer<typeof ApproveApplicationResponseSchema>
