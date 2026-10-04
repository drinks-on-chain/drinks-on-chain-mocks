import { z } from 'zod'

/** Fecha y hora ISO 8601 tal como la devuelve el backend (`2026-09-25T12:00:00Z` o con milisegundos). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true })

/** Fecha de entrada en los DTO de creación: el backend acepta `YYYY-MM-DD` o fecha y hora ISO. */
export const DateInputSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })])

/**
 * Marcas de corrección de un registro de la trazabilidad (contrato de la Ola 2 §9;
 * `CorrectableResponseDto`): el recurso devuelve siempre el **valor vigente** y dice qué campos se
 * corrigieron, si está anulado y con qué correcciones (el valor original, en `changes[].before` de
 * `GET /v1/lots/{id}/corrections`). Las llevan los registros que responde su propia ruta; los
 * anidados dentro de otro recurso pueden no traerlas.
 */
export const CorrectionMarksShape = {
  /** Campos con el valor corregido (vacío si nunca se corrigió). */
  correctedFields: z.array(z.string()).optional(),
  /** Anulado por una corrección `VOID`: el registro ya no cuenta. */
  voided: z.boolean().optional(),
  /** Correcciones del registro, de la más antigua a la más nueva. */
  correctionIds: z.array(z.string()).optional(),
}
export const CorrectionMarksSchema = z.object(CorrectionMarksShape)
export type CorrectionMarks = Required<z.infer<typeof CorrectionMarksSchema>>

/**
 * Campos de entrada retirados en el cierre H2 de la Ola 2 (contrato §16.2), por DTO. Como el
 * backend (`forbidNonWhitelisted`), enviar uno responde 422 `VALIDATION_ERROR` en ese campo
 * («property … should not exist»); `phytosanitaryStatus` del pesaje responde 422 `TRC_PHYTO_IN_CREATE`.
 */
export const RETIRED_INPUT_FIELDS = {
  CreateHarvestBatchDto: ['brixDegrees', 'initialPh', 'initialAcidityGl'],
  CreateTerroirDto: ['isDoEligible'],
  UpdateTerroirDto: ['isDoEligible'],
  CreateFermentationTankDto: ['harvestBatchId'],
  CreateDistillationBatchDto: ['processEndDate', 'outputVolumeLiters', 'wasteVolumeLiters', 'additionalParams', 'isDoEligible'],
  CreateLotBottlingDto: ['labelDesignUrl'],
  CreateLotLabAnalysisDto: ['laboratoryReportPdfUrl'],
} as const satisfies Record<string, readonly string[]>

/** Objeto libre (`additionalParams`, polígonos GeoJSON…). */
export const JsonObjectSchema = z.record(z.string(), z.unknown())

/** Polígono GeoJSON de una parcela. */
export const GeoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
})
export type GeoJsonPolygon = z.infer<typeof GeoJsonPolygonSchema>

/** Geometría GeoJSON genérica tal como la guarda el backend (`type: object` en el OpenAPI). */
export const GeoJsonGeometrySchema = z.looseObject({
  type: z.string(),
  coordinates: z.array(z.unknown()),
})
export type GeoJsonGeometry = z.infer<typeof GeoJsonGeometrySchema>
