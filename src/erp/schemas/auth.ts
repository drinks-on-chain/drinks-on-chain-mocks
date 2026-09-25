import { z } from 'zod'
import { MemberRoleSchema, SignupRoleSchema, UserRoleSchema } from './enums'

// POST /v1/auth/signup · /login · /refresh

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

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
})
export type RefreshTokenDto = z.infer<typeof RefreshTokenSchema>

export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  userRole: UserRoleSchema,
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string(),
  wineryId: z.string().nullish(),
  memberRole: MemberRoleSchema.nullish(),
})
export type AuthUser = z.infer<typeof AuthUserSchema>

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.string(),
  expiresIn: z.number(),
})
export type AuthTokens = z.infer<typeof AuthTokensSchema>

export const AuthResponseSchema = z.object({
  user: AuthUserSchema,
  tokens: AuthTokensSchema,
})
export type AuthResponse = z.infer<typeof AuthResponseSchema>
