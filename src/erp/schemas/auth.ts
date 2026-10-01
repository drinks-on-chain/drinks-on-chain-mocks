import { z } from 'zod'
import { AudienceSchema, MembershipSchema } from './organizations'

// POST /v1/auth/signup · /login · /refresh · /switch-organization (contrato de la Ola 0 §5)

/** `POST /v1/auth/signup`: solo consumidores (el `userRole` de personal se retiró en H1; enviarlo → 422). */
export const SignupSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  fullName: z.string().min(1),
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
 * Persona en la respuesta de sesión. El rol y la bodega van en `memberships` y
 * `activeOrganizationId` (`userRole`, `wineryId` y `memberRole` se retiraron en H1).
 */
export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string(),
  audience: AudienceSchema,
})
export type AuthUser = z.infer<typeof AuthUserSchema>

/** Acceso de 15 min (`expiresIn: 900`). El refresco viaja solo en la cookie `doc_rt` (`HttpOnly`). */
export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  expiresIn: z.number(),
  /**
   * @deprecated Retirado del cuerpo en H1 (contrato de la Ola 1 §11 y §11 bis): ni el backend ni los
   * mocks lo envían desde 0.4.0-rc.2; queda opcional en el tipo para no romper a quien lo lea y se
   * borra en 0.5. El refresco viaja solo en la cookie `doc_rt`.
   */
  refreshToken: z.string().optional(),
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
