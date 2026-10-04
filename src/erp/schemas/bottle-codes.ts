import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { TraceActorSchema } from './lots'

// Códigos de botella (contrato de la Ola 2 §7, A-26): BottleUnitDto, VoidBottleCodeDto y las
// exportaciones para la imprenta (CSV directo y ZIP con los QR, generado aparte).

export const BOTTLE_UNIT_STATUSES = ['ACTIVE', 'VOIDED'] as const
export const BottleUnitStatusSchema = z.enum(BOTTLE_UNIT_STATUSES)
/** `DELIVERED` llega en la Ola 5 (canje). */
export type BottleUnitStatus = z.infer<typeof BottleUnitStatusSchema>

/** Código de una botella (`BottleUnitDto`): 8 caracteres Crockford (7 + 1 de control). */
export const BottleUnitSchema = z.object({
  code: z.string(),
  /** `XXXX-XXXX`, como se imprime. */
  codeFormatted: z.string(),
  serial: z.number().int().min(1),
  lotId: z.string(),
  lotCode: z.string(),
  status: BottleUnitStatusSchema,
  /** `{PASSPORT_BASE_URL}/b/{código}`. */
  qrUrl: z.string(),
  voided: z
    .object({
      at: IsoDateTimeSchema,
      /** `null` = no registrado (membresía que ya no existe; lote descartado por el sistema). */
      by: TraceActorSchema.nullable(),
      reason: z.string(),
      /** Código que lo sustituye (misma serie). */
      replacedBy: z.string().nullable(),
    })
    .nullable(),
  /** Código anulado al que sustituye. */
  replaces: z.string().nullable(),
  exportsCount: z.number().int().min(0),
  firstExportedAt: IsoDateTimeSchema.nullable(),
})
export type BottleUnit = z.infer<typeof BottleUnitSchema>

/**
 * `POST /v1/bottle-codes/{code}/void`. `replace: true` emite un código nuevo con la misma serie
 * (etiqueta dañada); con el expediente cerrado solo se anula sin sustituto (S-14).
 */
export const VoidBottleCodeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  replace: z.boolean().optional(),
})
export type VoidBottleCodeDto = z.infer<typeof VoidBottleCodeSchema>

/** Código de botella anulado, con o sin sustituto (fila de `bottle-lots.json`). */
export const VoidedBottleCodeSchema = z.object({
  serial: z.number().int().min(1),
  code: z.string(),
  /** Generación del código dentro de su serie (0 = el original). */
  generation: z.number().int().min(0),
  at: IsoDateTimeSchema,
  by: TraceActorSchema,
  reason: z.string(),
  replacedBy: z.string().nullable(),
})
export type VoidedBottleCode = z.infer<typeof VoidedBottleCodeSchema>

/**
 * Códigos de botella de un lote en los mocks (`bottle-lots.json`). No hay un registro por botella:
 * el código de la serie `n` es `mockBottleCode(lotId, n, generación)`; solo se guardan las series
 * sustituidas, los códigos anulados y los rangos exportados.
 */
export const BottleLotSchema = z.object({
  lotId: z.string(),
  bottlingBatchId: z.string(),
  /** Botellas embotelladas (series `1…total`). */
  total: z.number().int().min(0),
  /** Generación vigente de las series cuyo código se sustituyó (las demás, 0). */
  generations: z.record(z.string(), z.number().int().min(1)),
  voided: z.array(VoidedBottleCodeSchema),
  /** Todos los códigos activos anulados de una vez (lote descartado). */
  allVoided: z.object({ at: IsoDateTimeSchema, by: TraceActorSchema.nullable(), reason: z.string() }).nullable(),
  /** Rangos exportados (CSV o ZIP) con su fecha. */
  exports: z.array(z.object({ fromSerial: z.number().int().min(1), toSerial: z.number().int().min(1), at: IsoDateTimeSchema })),
})
export type BottleLot = z.infer<typeof BottleLotSchema>

/** Cabecera del CSV de `GET /v1/lots/{id}/bottle-codes/export`. */
export const BOTTLE_CODES_CSV_COLUMNS = ['serial', 'code', 'codeFormatted', 'qrUrl', 'lotCode', 'lotName', 'productType', 'bottlingDate'] as const

/** `POST /v1/lots/{id}/bottle-codes/exports`: ZIP con el CSV y una imagen de QR por botella. */
export const CreateBottleCodeExportSchema = z.object({
  format: z.literal('ZIP'),
  fromSerial: z.number().int().min(1).optional(),
  toSerial: z.number().int().min(1).optional(),
  qr: z.object({
    imageFormat: z.enum(['SVG', 'PNG']),
    sizePx: z.number().int().min(64).max(4096).optional(),
    /** Margen en módulos del QR. */
    margin: z.number().int().min(0).max(16).optional(),
  }),
})
export type CreateBottleCodeExportDto = z.infer<typeof CreateBottleCodeExportSchema>

/** Respuesta 202 de la solicitud de exportación. */
export const BottleCodeExportAcceptedSchema = z.object({ exportId: z.string(), status: z.literal('PENDING') })
export type BottleCodeExportAccepted = z.infer<typeof BottleCodeExportAcceptedSchema>

/** Máximo de códigos de una exportación ZIP; un lote mayor se exporta por rangos de serie (422). */
export const BOTTLE_ZIP_MAX_CODES = 20_000

/** Estado de una exportación (`BottleCodeExportDto`): la ZIP y, también, cada descarga CSV. */
export const BottleCodeExportSchema = z.object({
  exportId: z.string(),
  status: z.enum(['PENDING', 'READY', 'FAILED']),
  format: z.enum(['CSV', 'ZIP']),
  fromSerial: z.number().int().min(1),
  toSerial: z.number().int().min(1),
  /** Códigos activos del rango. */
  rows: z.number().int().min(0),
  createdAt: IsoDateTimeSchema,
  /** `null` = no registrado (membresía que ya no existe). */
  createdBy: TraceActorSchema.nullable(),
  /** URL firmada de 15 min del ZIP (solo `READY` y sin caducar; una exportación CSV se descarga al pedirla). */
  downloadUrl: z.string().nullable(),
  /** Caducidad del ZIP (7 días). */
  expiresAt: IsoDateTimeSchema,
})
export type BottleCodeExport = z.infer<typeof BottleCodeExportSchema>
