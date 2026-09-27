import type { z } from 'zod'
import type { ApiErrorCode, ApiErrorDetail } from '../../shared/envelope'

// Errores que los handlers convierten en el envoltorio de error del backend. `details` es una
// lista de `{ field, message }` en los 422 (validación y reglas) y `null` en el resto
// (contrato de la Ola 0 §1).

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: ApiErrorDetail[] | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Detalle de un campo (`null` si el error no es de un campo concreto). */
export const fieldError = (field: string | null, message: string): ApiErrorDetail => ({ field, message })

export const badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message)
export const unauthorized = (message = 'Token de acceso inválido, ausente o expirado') =>
  new ApiError(401, 'UNAUTHORIZED', message)
export const sessionRevoked = (message = 'La sesión fue revocada') => new ApiError(401, 'AUTH_SESSION_REVOKED', message)
export const refreshReused = () =>
  new ApiError(401, 'AUTH_REFRESH_REUSED', 'El token de renovación ya se usó: la sesión se revocó por seguridad')
export const forbidden = (message = 'No tiene permisos para esta operación') => new ApiError(403, 'FORBIDDEN', message)
export const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message)
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message)
/** 422 de una regla de negocio, con el campo que la provoca. */
export const unprocessable = (message: string, details: ApiErrorDetail[] | null = null) =>
  new ApiError(422, 'UNPROCESSABLE_ENTITY', message, details)
/** 422 de validación con los campos inválidos. */
export const invalid = (details: ApiErrorDetail[], message = 'Validation failed') =>
  new ApiError(422, 'VALIDATION_ERROR', message, details)

/** 422 de validación a partir de los errores de zod (`field` con notación de puntos). */
export function validationError(issues: readonly z.core.$ZodIssue[]): ApiError {
  return invalid(issues.map((i) => fieldError(i.path.length ? i.path.map(String).join('.') : null, i.message)))
}
