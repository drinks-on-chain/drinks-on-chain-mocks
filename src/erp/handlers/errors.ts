import type { z } from 'zod'
import type { ApiErrorCode } from '../../shared/envelope'

// Errores que los handlers convierten en el envoltorio de error del backend.

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const badRequest = (message: string, details: unknown = null) => new ApiError(400, 'BAD_REQUEST', message, details)
export const unauthorized = (message = 'Token de acceso inválido, ausente o expirado') =>
  new ApiError(401, 'UNAUTHORIZED', message)
export const forbidden = (message = 'No tiene permisos para esta operación') => new ApiError(403, 'FORBIDDEN', message)
export const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message)
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message)
export const unprocessable = (message: string, details: unknown = null) =>
  new ApiError(422, 'UNPROCESSABLE_ENTITY', message, details)

/** 400 de validación como el ValidationPipe del backend: `details` es un array de mensajes. */
export function validationError(issues: readonly z.core.$ZodIssue[]): ApiError {
  const details = issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
  return new ApiError(400, 'VALIDATION_ERROR', 'Validation failed', details)
}
