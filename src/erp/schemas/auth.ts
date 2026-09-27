import { z } from 'zod'
import { MemberRoleSchema, SignupRoleSchema, UserRoleSchema } from './enums'
import { AudienceSchema, MembershipSchema } from './organizations'

// POST /v1/auth/signup · /login · /refresh · /switch-organization (contrato de la Ola 0 §5)

export const SignupSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  fullName: z.string().min(1),
  userRole: SignupRoleSchema.nullish(),
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string().nullish(),
})
export type SignupDto = z.infer<typeof SignupSchema>

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})
export type LoginDto = z.infer<typeof LoginSchema>

/**
 * Cuerpo de `POST /v1/auth/refresh`. El refresco viaja en la cookie `doc_rt`; el cuerpo
 * `{ refreshToken }` se acepta por compatibilidad (*retirada* en H1).
 */
export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1).optional(),
})
export type RefreshTokenDto = z.infer<typeof RefreshTokenSchema>

/**
 * Persona en la respuesta de sesión. `userRole`, `wineryId` y `memberRole` se mantienen por
 * compatibilidad (*retirada* en H1): `wineryId`/`memberRole` reflejan la organización activa
 * si es una bodega.
 */
export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string(),
  audience: AudienceSchema,
  userRole: UserRoleSchema,
  wineryId: z.string().nullish(),
  memberRole: MemberRoleSchema.nullish(),
})
export type AuthUser = z.infer<typeof AuthUserSchema>

/** Acceso de 15 min (`expiresIn: 900`); `refreshToken` en el cuerpo por compatibilidad (*retirada* en H1). */
export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string(),
})
export type AuthTokens = z.infer<typeof AuthTokensSchema>

/** Respuesta de login, signup, refresh y switch-organization. */
export const SessionResponseSchema = z.object({
  user: AuthUserSchema,
  memberships: z.array(MembershipSchema),
  activeOrganizationId: z.string().nullable(),
  tokens: AuthTokensSchema,
})
export type SessionResponse = z.infer<typeof SessionResponseSchema>

/** Nombre de 0.1: es la misma respuesta de sesión. */
export const AuthResponseSchema = SessionResponseSchema
export type AuthResponse = SessionResponse
