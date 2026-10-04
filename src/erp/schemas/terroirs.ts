import { z } from 'zod'
import { CorrectionMarksShape, GeoJsonGeometrySchema, IsoDateTimeSchema } from './common'
import { DoEvaluationSchema } from './lots'

// /v1/terroirs · TerroirResponseDto, CreateTerroirDto, UpdateTerroirDto

export const TerroirResponseSchema = z.object({
  ...CorrectionMarksShape,
  id: z.string(),
  wineryId: z.string(),
  parcelName: z.string(),
  cadastreCode: z.string().nullish(),
  surfaceHectares: z.number(),
  altitudeMasl: z.number(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  geographicPolygonGeojson: GeoJsonGeometrySchema.nullish(),
  rawMaterialType: z.string(),
  varietyName: z.string(),
  soilType: z.string().nullish(),
  irrigationSystem: z.string().nullish(),
  /**
   * Aptitud D.O. Singani **calculada** por el servidor con los valores vigentes de la bodega
   * (altitud y cepa; EA-03, contrato de la Ola 2 §3.1). En la entrada se ignora.
   */
  isDoEligible: z.boolean(),
  /** Detalle de la evaluación (`rulesSource: EFFECTIVE_SETTINGS`); solo en las rutas de parcelas. */
  doEvaluation: DoEvaluationSchema.optional(),
  doType: z.string().nullish(),
  doCertificateUrl: z.string().nullish(),
  isActive: z.boolean(),
  createdAt: IsoDateTimeSchema,
})
export type TerroirResponse = z.infer<typeof TerroirResponseSchema>

export const CreateTerroirSchema = z.object({
  parcelName: z.string().min(1),
  cadastreCode: z.string().optional(),
  surfaceHectares: z.number().positive(),
  altitudeMasl: z.number(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geographicPolygonGeojson: GeoJsonGeometrySchema.optional(),
  rawMaterialType: z.string().min(1),
  varietyName: z.string().min(1),
  soilType: z.string().optional(),
  irrigationSystem: z.string().optional(),
  doType: z.string().optional(),
  doCertificateUrl: z.string().optional(),
})
export type CreateTerroirDto = z.infer<typeof CreateTerroirSchema>

export const UpdateTerroirSchema = CreateTerroirSchema.partial().extend({
  isActive: z.boolean().optional(),
})
export type UpdateTerroirDto = z.infer<typeof UpdateTerroirSchema>

/** Campos de una parcela con efecto normativo: con pesajes solo cambian por corrección (§3.1). */
export const TERROIR_NORMATIVE_FIELDS = ['altitudeMasl', 'varietyName', 'rawMaterialType'] as const

/** `POST /v1/terroirs/{id}/corrections` (`CreateTerroirCorrectionDto`). */
export const CreateTerroirCorrectionSchema = z.object({
  /** Campo → valor nuevo: `altitudeMasl`, `varietyName`, `rawMaterialType`. */
  changes: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(10).max(500),
})
export type CreateTerroirCorrectionDto = z.infer<typeof CreateTerroirCorrectionSchema>
