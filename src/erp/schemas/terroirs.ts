import { z } from 'zod'
import { GeoJsonGeometrySchema, IsoDateTimeSchema } from './common'

// /v1/terroirs · TerroirResponseDto, CreateTerroirDto, UpdateTerroirDto

export const TerroirResponseSchema = z.object({
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
  isDoEligible: z.boolean(),
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
  isDoEligible: z.boolean().optional(),
  doType: z.string().optional(),
  doCertificateUrl: z.string().optional(),
})
export type CreateTerroirDto = z.infer<typeof CreateTerroirSchema>

export const UpdateTerroirSchema = CreateTerroirSchema.partial().extend({
  isActive: z.boolean().optional(),
})
export type UpdateTerroirDto = z.infer<typeof UpdateTerroirSchema>
