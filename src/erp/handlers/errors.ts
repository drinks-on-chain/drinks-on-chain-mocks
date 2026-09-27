import type { z } from 'zod'
import type { ApiErrorCode, ApiErrorDetail } from '../../shared/envelope'

// Errores que los handlers convierten en el envoltorio de error del backend. `details` es una
// lista de `{ field, message }` en los 422 (validación y reglas) y `null` en el resto
// (contrato de la Ola 0 §1). Los mensajes van en español.

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: ApiErrorDetail[] | null = null,
    /** Cabeceras extra de la respuesta (p. ej. `Retry-After` en un 429). */
    readonly headers: Record<string, string> = {},
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
// 401 de sesión con los códigos del backend (contrato de la Ola 0 §8).
export const tokenInvalid = (message = 'Token de acceso inválido') => new ApiError(401, 'AUTH_TOKEN_INVALID', message)
export const tokenExpired = () => new ApiError(401, 'AUTH_TOKEN_EXPIRED', 'Token de acceso expirado')
export const invalidCredentials = () => new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Credenciales de acceso inválidas')
export const refreshInvalid = (message = 'Token de renovación ausente o inválido') => new ApiError(401, 'AUTH_REFRESH_INVALID', message)
export const sessionRevoked = (message = 'La sesión fue revocada') => new ApiError(401, 'AUTH_SESSION_REVOKED', message)
export const sessionExpired = () => new ApiError(401, 'AUTH_SESSION_EXPIRED', 'La sesión caducó; inicia sesión de nuevo')
export const refreshReused = () =>
  new ApiError(401, 'AUTH_REFRESH_REUSED', 'El token de renovación ya se había usado; la sesión se cerró por seguridad')
/** 429 con `Retry-After` (bloqueo progresivo del login). */
export const tooManyAttempts = (seconds: number) =>
  new ApiError(429, 'AUTH_TOO_MANY_ATTEMPTS', 'Demasiados intentos fallidos. Vuelve a intentarlo más tarde', null, {
    'Retry-After': String(seconds),
  })
/** 403 de audiencia, tipo de organización o rol insuficientes (`AUTH_INSUFFICIENT_PERMISSIONS`, como el backend). */
export const forbidden = (message = 'No tiene permisos para esta operación') => new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', message)
export const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message)
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message)
/** 422 de una regla de negocio, con el campo que la provoca. */
export const unprocessable = (message: string, details: ApiErrorDetail[] | null = null) =>
  new ApiError(422, 'UNPROCESSABLE_ENTITY', message, details)
/** 422 de validación con los campos inválidos. */
export const invalid = (details: ApiErrorDetail[], message = 'Los datos enviados no son válidos') =>
  new ApiError(422, 'VALIDATION_ERROR', message, details)
/** Error con código de dominio (`ORG_…`, `INVITATION_…`…). Los 422 llevan el campo en `details`. */
export const domainError = (status: number, code: ApiErrorCode, message: string, field?: string | null) =>
  new ApiError(status, code, message, field === undefined ? null : [fieldError(field, message)])

/** 422 de validación a partir de los errores de zod (`field` con notación de puntos). */
export function validationError(issues: readonly z.core.$ZodIssue[]): ApiError {
  return invalid(issues.map((i) => fieldError(i.path.length ? i.path.map(String).join('.') : null, i.message)))
}
