import { z } from 'zod'
import { SessionResponseSchema } from '../../erp/schemas/auth'
import { CaptchaTokenSchema } from './common'

// Cuenta e identidad (contrato de la Ola 1 §1): recuperación de contraseña, verificación del
// correo, cambio de contraseña, preferencias y segundo factor (TOTP) del personal de plataforma.

/** Contraseñas nuevas: mínimo 10 caracteres y fuera de la lista de comunes (422 `AUTH_WEAK_PASSWORD`). */
export const PASSWORD_MIN_LENGTH = 10

/** `POST /v1/auth/login` de una persona con membresía de plataforma: sin tokens, pide el TOTP. */
export const MfaChallengeSchema = z.object({
  mfa: z.object({
    required: z.literal(true),
    /** `false`: aún no inscribió su app de autenticación (`/v1/auth/mfa/enroll`). */
    enrolled: z.boolean(),
    /** Válido 5 minutos y de un solo uso. */
    mfaToken: z.string(),
  }),
})
export type MfaChallenge = z.infer<typeof MfaChallengeSchema>

/** Respuesta de `POST /v1/auth/login` (y de aceptar una invitación): sesión o reto TOTP. */
export const LoginResponseSchema = z.union([SessionResponseSchema, MfaChallengeSchema])
export type LoginResponse = z.infer<typeof LoginResponseSchema>

/** ¿Es un reto de segundo factor (y no una sesión)? */
export function isMfaChallenge(data: LoginResponse): data is MfaChallenge {
  return 'mfa' in data
}

/** `POST /v1/auth/mfa/enroll`. */
export const MfaTokenSchema = z.object({
  mfaToken: z.string().min(1),
})
export type MfaTokenDto = z.infer<typeof MfaTokenSchema>

/** `POST /v1/auth/mfa/verify` y `/mfa/enroll/confirm`: código TOTP de 6 dígitos o código de recuperación. */
export const MfaCodeSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().trim().min(6).max(20),
})
export type MfaCodeDto = z.infer<typeof MfaCodeSchema>

export const MfaEnrollResponseSchema = z.object({
  otpauthUrl: z.string(),
  /** Secreto base32 (para escribirlo a mano si no se puede leer el QR). */
  secret: z.string(),
})
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponseSchema>

/** `POST /v1/auth/mfa/enroll/confirm`: la forma del login + 10 códigos de recuperación (se muestran una vez). */
export const MfaEnrollConfirmResponseSchema = SessionResponseSchema.extend({
  recoveryCodes: z.array(z.string()).length(10),
})
export type MfaEnrollConfirmResponse = z.infer<typeof MfaEnrollConfirmResponseSchema>

/** `POST /v1/auth/forgot-password` → 202 siempre. */
export const ForgotPasswordSchema = z.object({
  email: z.email(),
  captchaToken: CaptchaTokenSchema,
})
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordSchema>

/** `POST /v1/auth/reset-password` → 204. */
export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
})
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>

/** `POST /v1/auth/verify-email` → 204. */
export const VerifyEmailSchema = z.object({
  token: z.string().min(1),
})
export type VerifyEmailDto = z.infer<typeof VerifyEmailSchema>

/** `POST /v1/auth/resend-verification` → 202. */
export const ResendVerificationSchema = z.object({
  email: z.email(),
  captchaToken: CaptchaTokenSchema,
})
export type ResendVerificationDto = z.infer<typeof ResendVerificationSchema>

/** `POST /v1/users/me/password` → 204 (revoca las demás sesiones). */
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
})
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>

