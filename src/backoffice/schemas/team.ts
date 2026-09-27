import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'
import {
  MembershipRoleSchema,
  OrganizationStatusSchema,
  OrganizationTypeSchema,
  PlatformRoleSchema,
  WineryRoleSchema,
} from '../../erp/schemas/organizations'
import { OptionalReasonSchema, ReasonSchema } from './common'
import { InternalRoleSchema } from './invitations'

// Equipo de una organización y usuarios internos (contrato de la Ola 1 §5).

export const MEMBER_STATUSES = ['ACTIVE', 'BLOCKED'] as const
export const MemberStatusSchema = z.enum(MEMBER_STATUSES)
export type MemberStatus = z.infer<typeof MemberStatusSchema>

/** Quién bloqueó: el dueño no puede desbloquear lo que bloqueó la plataforma (`ORG_BLOCKED_BY_PLATFORM`). */
export const BLOCKED_BY = ['OWNER', 'PLATFORM'] as const
export const BlockedBySchema = z.enum(BLOCKED_BY)
export type BlockedBy = z.infer<typeof BlockedBySchema>

/** Estado de la cuenta completa de una persona (`users.is_active`; la bloquea la plataforma). */
export const AccountStatusSchema = z.enum(['ACTIVE', 'BLOCKED'])
export type AccountStatus = z.infer<typeof AccountStatusSchema>

/**
 * `MemberDto`. El dueño ve todo; el resto de roles, solo los miembros activos con
 * `lastLoginAt: null`. `accountStatus` y `accountBlockedReason` solo en las rutas del back office
 * (`/v1/platform/organizations/{id}/members*`, contrato de la Ola 1 §11 bis).
 */
export const MemberSchema = z.object({
  membershipId: z.string(),
  userId: z.string(),
  fullName: z.string(),
  email: z.string(),
  role: MembershipRoleSchema,
  status: MemberStatusSchema,
  blockedBy: BlockedBySchema.nullable(),
  blockedReason: z.string().nullable(),
  joinedAt: IsoDateTimeSchema,
  lastLoginAt: IsoDateTimeSchema.nullable(),
  accountStatus: AccountStatusSchema.optional(),
  accountBlockedReason: z.string().nullable().optional(),
})
export type Member = z.infer<typeof MemberSchema>

/**
 * Usuario interno (`PlatformUserDto`, `GET /v1/platform/users`): miembro de la organización de
 * plataforma o invitación pendiente (`status: 'INVITED'`, `membershipId: null`, `userId` si el correo
 * ya tiene cuenta, `fullName` = nombre de la cuenta o el correo). `invitationId` permite reenviar o
 * anular la invitación. `accountStatus` es `null` en una invitación sin cuenta.
 */
export const PlatformUserSchema = MemberSchema.omit({ accountStatus: true, accountBlockedReason: true }).extend({
  membershipId: z.string().nullable(),
  userId: z.string().nullable(),
  role: PlatformRoleSchema,
  status: z.enum(['ACTIVE', 'BLOCKED', 'INVITED']),
  joinedAt: IsoDateTimeSchema.nullable(),
  mfaEnabled: z.boolean(),
  invitationId: z.string().nullable(),
  accountStatus: AccountStatusSchema.nullable(),
  accountBlockedReason: z.string().nullable(),
})
export type PlatformUser = z.infer<typeof PlatformUserSchema>

/** `PATCH /v1/organizations/current/members/{membershipId}` (dueño): nunca `OWNER`. */
export const UpdateMemberRoleSchema = z.object({
  role: WineryRoleSchema,
})
export type UpdateMemberRoleDto = z.infer<typeof UpdateMemberRoleSchema>

/** Igual, desde el back office (motivo obligatorio). */
export const PlatformUpdateMemberRoleSchema = UpdateMemberRoleSchema.extend({
  reason: ReasonSchema,
})
export type PlatformUpdateMemberRoleDto = z.infer<typeof PlatformUpdateMemberRoleSchema>

/** `POST …/block` · `/unblock` del dueño (motivo opcional). */
export const MemberBlockSchema = z.object({
  reason: OptionalReasonSchema,
})
export type MemberBlockDto = z.infer<typeof MemberBlockSchema>

/** `POST …/block` · `/unblock` del back office y bloqueos de cuenta (motivo obligatorio). */
export const PlatformActionSchema = z.object({
  reason: ReasonSchema,
})
export type PlatformActionDto = z.infer<typeof PlatformActionSchema>

/** `PATCH /v1/platform/users/{membershipId}`. */
export const UpdatePlatformUserSchema = z.object({
  role: InternalRoleSchema.optional(),
  reason: ReasonSchema,
})
export type UpdatePlatformUserDto = z.infer<typeof UpdatePlatformUserSchema>

/** `POST /v1/platform/users/{userId}/send-password-reset`. */
export const SendPasswordResetSchema = z.object({
  reason: OptionalReasonSchema,
})
export type SendPasswordResetDto = z.infer<typeof SendPasswordResetSchema>

/** Respuesta del bloqueo o desbloqueo de la cuenta completa (`POST /v1/platform/accounts/{userId}/block`). */
export const UserAccountStatusSchema = z.object({
  userId: z.string(),
  email: z.string(),
  fullName: z.string(),
  status: AccountStatusSchema,
  blockedReason: z.string().nullable(),
})
export type UserAccountStatus = z.infer<typeof UserAccountStatusSchema>

/** Membresía en la ficha de una cuenta (`AccountMembershipDto`). */
export const AccountMembershipSchema = z.object({
  membershipId: z.string(),
  organizationId: z.string(),
  organizationType: OrganizationTypeSchema,
  organizationName: z.string(),
  organizationStatus: OrganizationStatusSchema,
  role: MembershipRoleSchema,
  status: MemberStatusSchema,
  blockedBy: BlockedBySchema.nullable(),
  blockedReason: z.string().nullable(),
})
export type AccountMembership = z.infer<typeof AccountMembershipSchema>

/** `GET /v1/platform/accounts/{userId}` (`AccountDetailDto`, ampliación del contrato de la Ola 1 §11 bis). */
export const AccountDetailSchema = z.object({
  userId: z.string(),
  fullName: z.string(),
  email: z.string(),
  status: AccountStatusSchema,
  blockedReason: z.string().nullable(),
  blockedAt: IsoDateTimeSchema.nullable(),
  memberships: z.array(AccountMembershipSchema),
})
export type AccountDetail = z.infer<typeof AccountDetailSchema>
