import { z } from 'zod'
import { CERTIFICATION_STATUSES } from '../../erp/schemas/enums'

// Piezas comunes del contrato de la Ola 1 (plan/contratos/o1-backoffice-y-bodegas.md §0).

/** Estado de la bodega y de su organización (§0): `INVITED` sustituye a `PENDING`. */
export const WINERY_STATUSES = CERTIFICATION_STATUSES
export const WineryStatusSchema = z.enum(WINERY_STATUSES)
export type WineryStatus = z.infer<typeof WineryStatusSchema>

/** Categoría de la bodega en solicitudes y fichas (misma lista que `beverageCategory`). */
export const WINERY_CATEGORIES = ['WINERY', 'DISTILLERY', 'BREWERY', 'OTHER'] as const
export const WineryCategorySchema = z.enum(WINERY_CATEGORIES)
export type WineryCategory = z.infer<typeof WineryCategorySchema>

/** Motivo de una acción del back office sobre terceros (AUD-05): texto de 3 a 500 caracteres. */
export const ReasonSchema = z.string().trim().min(3, 'El motivo debe tener al menos 3 caracteres').max(500)
/** Motivo opcional (mismas reglas si llega). */
export const OptionalReasonSchema = ReasonSchema.nullish()

/**
 * Token de Cloudflare Turnstile. En los mocks vale cualquier texto no vacío salvo el que contenga
 * `fail` (simula un captcha rechazado → 422 `CAPTCHA_INVALID`).
 */
export const CaptchaTokenSchema = z.string().min(1, 'Falta el captcha')

/** Persona que hizo algo (asignada, autor de una nota…). */
export const PersonRefSchema = z.object({
  userId: z.string(),
  fullName: z.string(),
})
export type PersonRef = z.infer<typeof PersonRefSchema>
