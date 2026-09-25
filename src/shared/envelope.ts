import { z } from 'zod'

// Envoltorio de respuesta del backend (doc 09 §1), verificado contra el servidor de desarrollo:
//   éxito  { success: true,  statusCode, timestamp, path, data }
//   error  { success: false, statusCode, timestamp, path, error: { code, message, details } }
// `path` incluye la query (`/v1/terroirs?limit=5`). En los 400 de validación `details` es un
// array de mensajes; en el resto suele ser `null`.

/** Códigos de error. Verificados: VALIDATION_ERROR, BAD_REQUEST, UNAUTHORIZED, NOT_FOUND. El resto sigue el mismo patrón (nombre del HttpStatus de NestJS). */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'INTERNAL_SERVER_ERROR',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export const ApiErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().nullish(),
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
