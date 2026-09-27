import { z } from 'zod'

// Envoltorio de respuesta del backend (doc 09 §1 y contrato de la Ola 0 §1):
//   éxito  { success: true,  statusCode, timestamp, path, data }
//   error  { success: false, statusCode, timestamp, path, error: { code, message, details } }
// `path` incluye la query (`/v1/terroirs?limit=5`). `details` es una lista de
// `{ field, message }` en los errores de validación y de reglas (422) y `null` en el resto.

/**
 * Códigos de error que devuelven los mocks. Los genéricos son los del backend
 * (`src/shared/exceptions/error-codes.ts`: el nombre del estado HTTP, `INTERNAL_ERROR` para el
 * 500); los de dominio (`AUTH_…`, `ORG_…`, `INVITATION_…`…) vienen de los contratos de ola
 * (plan/contratos/o0-… y o1-…). El backend puede añadir otros: trata `code` como texto abierto.
 */
export const API_ERROR_CODES = [
  // Genéricos
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'TOO_MANY_REQUESTS',
  'INTERNAL_ERROR',
  // Ola 0: sesión e idempotencia
  'AUTH_REFRESH_REUSED',
  'AUTH_SESSION_REVOKED',
  'ORG_NOT_FOUND',
  'IDEMPOTENCY_KEY_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  // ERP (backend O0-BE-2)
  'WINERY_NOT_PENDING',
  'FERMENTATION_TANK_ALREADY_TRANSFERRED',
  // Ola 1: cuenta, segundo factor y captcha
  'AUTH_MFA_REQUIRED',
  'AUTH_MFA_INVALID_CODE',
  'AUTH_MFA_TOKEN_INVALID',
  'AUTH_TOO_MANY_ATTEMPTS',
  'AUTH_RESET_TOKEN_INVALID',
  'AUTH_EMAIL_TOKEN_INVALID',
  'AUTH_WEAK_PASSWORD',
  'AUTH_INVALID_CURRENT_PASSWORD',
  'CAPTCHA_INVALID',
  // Ola 1: invitaciones, bodegas y equipo
  'INVITATION_NOT_FOUND',
  'INVITATION_EXPIRED',
  'INVITATION_EMAIL_MISMATCH',
  'INVITATION_ALREADY_PENDING',
  'INVITATION_NOT_PENDING',
  'ORG_NOT_ACTIVE',
  'ORG_OWNER_ROLE_RESERVED',
  'ORG_MEMBER_LIMIT_REACHED',
  'ORG_ALREADY_MEMBER',
  'ORG_BLOCKED_BY_PLATFORM',
  'ORG_CANNOT_MODIFY_SELF',
  'ORG_TAX_ID_TAKEN',
  'ORG_INVALID_TRANSITION',
  'APPLICATION_INVALID_TRANSITION',
  'APPLICATION_TOKEN_INVALID',
  'PLATFORM_SUPERADMIN_PROTECTED',
  // Ola 1: configuración y bitácora
  'SETTING_NOT_FOUND',
  'SETTING_BELOW_LEGAL_MINIMUM',
  'SETTING_LEVEL_NOT_ALLOWED',
  'AUDIT_EXPORT_TOO_LARGE',
] as const
/** Código de error: uno de `API_ERROR_CODES` o cualquier otro que añada el backend. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | (string & {})

/** Detalle de un error: campo (notación de puntos, `items.0.quantity`) o `null` si no es de un campo. */
export const ApiErrorDetailSchema = z.object({
  field: z.string().nullable(),
  message: z.string(),
})
export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>

export const ApiErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.array(ApiErrorDetailSchema).nullish(),
})
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>

export const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  statusCode: z.number().int(),
  timestamp: z.string(),
  path: z.string(),
  error: ApiErrorBodySchema,
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    success: z.literal(true),
    statusCode: z.number().int(),
    timestamp: z.string(),
    path: z.string(),
    data,
  })
}

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('success', [successEnvelopeSchema(data), ErrorEnvelopeSchema])
}

export interface SuccessEnvelope<T> {
  success: true
  statusCode: number
  timestamp: string
  path: string
  data: T
}
export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope
