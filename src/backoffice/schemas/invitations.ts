import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'
import {
  MembershipRoleSchema,
  OrganizationTypeSchema,
  WineryRoleSchema,
} from '../../erp/schemas/organizations'
import { OptionalReasonSchema } from './common'

// Invitaciones (contrato de la Ola 1 §2): dueño, colaboradores y usuarios internos.

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'] as const
export const InvitationStatusSchema = z.enum(INVITATION_STATUSES)
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>

export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  organizationId: z.string(),
  organizationType: OrganizationTypeSchema,
  organizationName: z.string(),
  role: MembershipRoleSchema,
  status: InvitationStatusSchema,
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  invitedBy: z.object({
    userId: z.string(),
    fullName: z.string(),
    /** `true` si invitó el back office en nombre de la organización. */
    viaPlatform: z.boolean(),
  }),
})
export type Invitation = z.infer<typeof InvitationSchema>

/** `GET /v1/invitations/{token}` (público). */
export const InvitationPreviewSchema = z.object({
  email: z.string(),
  organizationName: z.string(),
  organizationType: OrganizationTypeSchema,
  role: MembershipRoleSchema,
  invitedByName: z.string(),
  expiresAt: IsoDateTimeSchema,
  status: InvitationStatusSchema,
  /** `true`: iniciar sesión con ese correo y aceptar con `{}`; `false`: crear la cuenta. */
  accountExists: z.boolean(),
})
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>

/**
 * `POST /v1/invitations/{token}/accept`. Cuenta nueva: `{ fullName, password }` sin sesión.
 * Cuenta existente: `{}` con la sesión de la persona invitada (mismo correo).
 */
export const AcceptInvitationSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(1).optional(),
})
export type AcceptInvitationDto = z.infer<typeof AcceptInvitationSchema>

/** `POST /v1/organizations/current/invitations` (dueño): cualquier rol de bodega salvo `OWNER`. */
export const CreateInvitationSchema = z.object({
  email: z.email(),
  role: WineryRoleSchema,
})
export type CreateInvitationDto = z.infer<typeof CreateInvitationSchema>

/** `POST /v1/platform/organizations/{organizationId}/invitations` (back office). */
export const PlatformCreateInvitationSchema = CreateInvitationSchema.extend({
  reason: OptionalReasonSchema,
})
export type PlatformCreateInvitationDto = z.infer<typeof PlatformCreateInvitationSchema>

/** `POST /v1/platform/users`: invita a un usuario interno (`SUPERADMIN` no se asigna). */
export const INTERNAL_ROLES = ['ADMIN', 'OPERATIONS', 'SUPPORT'] as const
export const InternalRoleSchema = z.enum(INTERNAL_ROLES)
export type InternalRole = z.infer<typeof InternalRoleSchema>
export const CreatePlatformUserSchema = z.object({
  email: z.email(),
  role: InternalRoleSchema,
  reason: OptionalReasonSchema,
})
export type CreatePlatformUserDto = z.infer<typeof CreatePlatformUserSchema>

/** `POST /v1/invitations/{id}/resend` y `/revoke`. */
export const InvitationActionSchema = z.object({
  reason: OptionalReasonSchema,
})
export type InvitationActionDto = z.infer<typeof InvitationActionSchema>
