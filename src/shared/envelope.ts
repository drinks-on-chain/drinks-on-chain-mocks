import { z } from 'zod'

// Envoltorio de respuesta del backend (doc 09 §1 y contrato de la Ola 0 §1):
//   éxito  { success: true,  statusCode, timestamp, path, data }
//   error  { success: false, statusCode, timestamp, path, error: { code, message, details } }
// `path` incluye la query (`/v1/terroirs?limit=5`). `details` es una lista de
// `{ field, message }` en los errores de validación y de reglas (422) y `null` en el resto.

/**
 * Códigos de las reglas de la trazabilidad y del pasaporte público (contrato de la Ola 2 §13).
 * Estado del recurso → 409; regla de negocio incumplida → 422; plataforma escribiendo → 403.
 */
export const TRACE_ERROR_CODES = [
  'TRC_LOT_NOT_FOUND',
  'TRC_INVALID_STAGE',
  'TRC_LOT_TERMINAL',
  'TRC_PRODUCT_NOT_SUPPORTED',
  'TRC_HARVEST_YEAR_MISMATCH',
  'TRC_DO_TERROIR_NOT_ELIGIBLE',
  'TRC_DO_NOT_ELIGIBLE',
  'TRC_TERROIR_IN_USE',
  'TRC_PHYTO_IN_CREATE',
  'TRC_PHYTO_NOT_APPROVED',
  'TRC_PHYTO_DECISION_FINAL',
  'TRC_MIXED_LOTS',
  'TRC_TANK_CODE_IN_USE',
  'TRC_TANK_CAPACITY_EXCEEDED',
  'TRC_TANK_INVALID_TRANSITION',
  'TRC_TANK_NOT_ACTIVE',
  'TRC_TANK_NOT_COMPLETED',
  'TRC_DESTINATION_MISMATCH',
  'TRC_VOLUME_EXCEEDS_AVAILABLE',
  'TRC_VOLUME_MISSING',
  'TRC_AGING_BELOW_MINIMUM',
  'TRC_MASS_BALANCE_EXCEEDED',
  'TRC_DISTILLATION_ALREADY_CLOSED',
  'TRC_LOCK_NOT_RELEASED',
  'TRC_BOTTLING_SOURCE_INVALID',
  'TRC_BOTTLING_SOURCES_PENDING',
  'TRC_LOT_ALREADY_BOTTLED',
  'TRC_BOTTLING_EXCEEDS_VOLUME',
  'TRC_BOTTLING_LOSS_ABOVE_TOLERANCE',
  'TRC_ALCOHOL_BALANCE_EXCEEDED',
  'TRC_DILUTION_NOT_ALLOWED',
  'TRC_COMPLIANCE_ISSUES_OPEN',
  'TRC_LOT_NOT_BOTTLED',
  'TRC_BOTTLE_CODE_NOT_FOUND',
  'TRC_BOTTLE_CODE_ALREADY_VOIDED',
  'TRC_EXPORT_NOT_READY',
  'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
  'TRC_CORRECTION_BREAKS_RULES',
  'TRC_DOSSIER_NOT_READY',
  'TRC_DOSSIER_CLOSED',
  'TRC_DATE_IN_FUTURE',
  'TRC_DATE_BEFORE_PREVIOUS_STAGE',
  'TRC_FILE_NOT_FOUND',
  'TRC_REPORT_TOO_LARGE',
  'TRC_PLATFORM_READ_ONLY',
  'PUB_CODE_NOT_FOUND',
  'PUB_CODE_MALFORMED',
  'PUB_TOO_MANY_LOOKUPS',
] as const
export type TraceErrorCode = (typeof TRACE_ERROR_CODES)[number]

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
  // Ola 0: sesión, permisos e idempotencia (backend O0-BE-4, contrato de la Ola 0 §8)
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_TOKEN_INVALID',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_REFRESH_INVALID',
  'AUTH_REFRESH_REUSED',
  'AUTH_SESSION_REVOKED',
  'AUTH_SESSION_EXPIRED',
  'AUTH_INSUFFICIENT_PERMISSIONS',
  'ORG_NOT_FOUND',
  'ORG_MEMBERSHIP_BLOCKED',
  'ORG_REVOKED',
  'IDEMPOTENCY_KEY_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  // ERP (backend O0-BE-2)
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
  // Ola 1 completa (backend `error-codes.ts`, mocks 0.4)
  'AUTH_LOGIN_REQUIRED',
  'AUTH_MFA_NOT_ENROLLED',
  'AUTH_MFA_ALREADY_ENROLLED',
  'AUTH_MFA_ENROLLMENT_NOT_STARTED',
  'USER_NOT_FOUND',
  'FILE_TYPE_NOT_ALLOWED',
  'FILE_TOO_LARGE',
  'FILE_NOT_FOUND',
  // Lista de espera (contrato O1b, backend v0.1.1)
  'WAITLIST_EXPORT_TOO_LARGE',
  // Ola 2: reglas de la trazabilidad (contrato O2 §13) y pasaporte público
  ...TRACE_ERROR_CODES,
  // Ola 3: tokenización y cadena (contrato O3 §9)
  'TOK_REQUEST_NOT_FOUND',
  'TOK_COLLECTION_NOT_FOUND',
  'TOK_LOT_NOT_TOKENIZABLE',
  'TOK_LOT_PRODUCT_UNDEFINED',
  'TOK_LOT_ESTIMATE_MISSING',
  'TOK_QUOTA_INVALID',
  'TOK_QUOTA_EXCEEDS_ESTIMATE',
  'TOK_QUOTA_EXCEEDS_BOTTLES',
  'TOK_ESTIMATE_BELOW_MINTED',
  'TOK_REQUEST_ALREADY_OPEN',
  'TOK_REQUEST_INVALID_TRANSITION',
  'TOK_WINERY_NOT_ACTIVE',
  'TOK_WINERY_CHAIN_NOT_READY',
  'TOK_COMMERCIAL_DATA_INCOMPLETE',
  'TOK_PRICE_INVALID',
  'TOK_PRICE_LOCKED',
  'TOK_SLUG_TAKEN',
  'TOK_MINT_NOT_CONFIRMED',
  'TOK_COLLECTION_INVALID_TRANSITION',
  'TOK_CLOSURE_PENDING',
  'TOK_CLOSURE_NOT_APPLICABLE',
  'CHN_TX_NOT_FOUND',
  'CHN_TX_NOT_RETRYABLE',
  'CHN_TX_NOT_ABANDONABLE',
  'CHN_CONTRACT_PAUSED',
  'CHN_CONTRACT_ALREADY_PAUSED',
  'CHN_CONTRACT_NOT_PAUSED',
  'CHN_IDENTITY_ALREADY_ACTIVE',
  // 0.6.0-rc.2: cadena sin configurar en el entorno (provision, pause y unpause).
  'CHN_DISABLED',
  'CHN_RECONCILIATION_RUNNING',
  'CHN_ALERT_ALREADY_RESOLVED',
  'CHN_WALLET_NOT_AVAILABLE',
  'PUB_TOKEN_NOT_FOUND',
  'IDEMPOTENCY_KEY_REQUIRED',
  // Del backend; los mocks no los emiten
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'UNKNOWN_ERROR',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_STORE_UNAVAILABLE',
  'CAPTCHA_UNAVAILABLE',
  'TRACEABILITY_STRATEGY_NOT_FOUND',
  'NOT_IMPLEMENTED',
] as const
/** Código de error: uno de `API_ERROR_CODES` o cualquier otro que añada el backend. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | (string & {})

/**
 * Detalle de un error: campo (notación de puntos, `items.0.quantity`) o `null` si no es de un campo.
 * Las reglas de la trazabilidad (contrato de la Ola 2 §0) lo amplían de forma aditiva: `code`
 * (`TRC_…` de esa violación; una respuesta puede traer varias), `rule` (clave del parámetro de la
 * instantánea), `expected`, `actual` y `meta` (datos para que la UI arme su explicación).
 */
export const ApiErrorDetailSchema = z.object({
  field: z.string().nullable(),
  message: z.string(),
  code: z.string().optional(),
  rule: z.string().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
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
