import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema } from './common'
import { DestinationTypeSchema, TankStatusSchema, TreatmentTypeSchema } from './enums'

// /v1/fermentation-tanks · tanque, lecturas (logs) y tratamientos enológicos

export const FermentationTankResponseSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  harvestBatchId: z.string(),
  tankCode: z.string(),
  capacityLiters: z.number().nullish(),
  material: z.string().nullish(),
  volumeFilledLiters: z.number().nullish(),
  destinationType: DestinationTypeSchema.nullish(),
  status: TankStatusSchema,
  startDate: IsoDateTimeSchema,
  endDate: IsoDateTimeSchema.nullish(),
  createdAt: IsoDateTimeSchema,
})
export type FermentationTankResponse = z.infer<typeof FermentationTankResponseSchema>

export const CreateFermentationTankSchema = z.object({
  harvestBatchId: z.string().min(1),
  tankCode: z.string().min(1),
  capacityLiters: z.number().positive().nullish(),
  material: z.string().nullish(),
  volumeFilledLiters: z.number().min(0).nullish(),
  destinationType: DestinationTypeSchema.nullish(),
  status: TankStatusSchema.nullish(),
  startDate: DateInputSchema,
})
export type CreateFermentationTankDto = z.infer<typeof CreateFermentationTankSchema>

export const CreateFermentationLogSchema = z.object({
  temperatureCelsius: z.number(),
  specificGravity: z.number().nullish(),
  phValue: z.number().min(0).max(14).nullish(),
  co2Observations: z.string().nullish(),
  recordedAt: DateInputSchema,
  notes: z.string().nullish(),
})
export type CreateFermentationLogDto = z.infer<typeof CreateFermentationLogSchema>

/**
 * Lectura guardada (`fermentation-logs.json`, respuesta de `POST …/:id/logs`).
 * El OpenAPI no declara el esquema de respuesta: es el DTO de alta más id, tanque y autor.
 */
export const FermentationLogSchema = z.object({
  id: z.string(),
  fermentationTankId: z.string(),
  temperatureCelsius: z.number(),
  specificGravity: z.number().nullish(),
  phValue: z.number().nullish(),
  co2Observations: z.string().nullish(),
  recordedAt: IsoDateTimeSchema,
  notes: z.string().nullish(),
  recordedByMemberId: z.string().nullish(),
})
export type FermentationLog = z.infer<typeof FermentationLogSchema>

export const CreateEnologicalTreatmentSchema = z.object({
  treatmentType: TreatmentTypeSchema,
  additiveName: z.string().min(1),
  additiveSupplier: z.string().nullish(),
  dosageAppliedGPerHl: z.number().min(0),
  totalAppliedG: z.number().min(0).nullish(),
  regulatoryAuthCode: z.string().min(1),
  appliedAt: DateInputSchema,
  notes: z.string().nullish(),
})
export type CreateEnologicalTreatmentDto = z.infer<typeof CreateEnologicalTreatmentSchema>

/**
 * Tratamiento guardado (`enological-treatments.json`, respuesta de `POST …/:id/treatments`).
 * Sin esquema de respuesta en el OpenAPI: DTO de alta más id y tanque.
 */
export const EnologicalTreatmentSchema = z.object({
  id: z.string(),
  fermentationTankId: z.string(),
  treatmentType: TreatmentTypeSchema,
  additiveName: z.string(),
  additiveSupplier: z.string().nullish(),
  dosageAppliedGPerHl: z.number(),
  totalAppliedG: z.number().nullish(),
  regulatoryAuthCode: z.string(),
  appliedAt: IsoDateTimeSchema,
  notes: z.string().nullish(),
})
export type EnologicalTreatment = z.infer<typeof EnologicalTreatmentSchema>
