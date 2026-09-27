import { z } from 'zod'

// Envoltorio de respuesta del backend (doc 09 §1 y contrato de la Ola 0 §1):
//   éxito  { success: true,  statusCode, timestamp, path, data }
//   error  { success: false, statusCode, timestamp, path, error: { code, message, details } }
// `path` incluye la query (`/v1/terroirs?limit=5`). `details` es una lista de
// `{ field, message }` en los errores de validación y de reglas (422) y `null` en el resto.

/**
 * Códigos de error. Verificados contra el servidor: VALIDATION_ERROR, BAD_REQUEST, UNAUTHORIZED,
 * NOT_FOUND. Los genéricos siguen el nombre del HttpStatus de NestJS; los de dominio
 * (`AUTH_…`, `ORG_…`) vienen del contrato de la Ola 0 (plan/contratos/o0-sesiones-y-estandares.md).
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'INTERNAL_SERVER_ERROR',
  'AUTH_REFRESH_REUSED',
  'AUTH_SESSION_REVOKED',
  'ORG_NOT_FOUND',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

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
