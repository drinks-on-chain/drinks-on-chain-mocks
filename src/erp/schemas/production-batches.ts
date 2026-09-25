import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema, JsonObjectSchema } from './common'
import { ProcessTypeSchema, RestStatusSchema } from './enums'

// /v1/production-batches · destilación de singani y reposo obligatorio

/** Cortes del alambique en `additionalParams` (cabezas, corazón y colas). */
export const DistillationCutsSchema = z.looseObject({
  headDiscardLiters: z.number().nullish(),
  heartYieldLiters: z.number().nullish(),
  tailDiscardLiters: z.number().nullish(),
})
export type DistillationCuts = z.infer<typeof DistillationCutsSchema>

export const ProductionBatchResponseSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  fermentationTankId: z.string(),
  processType: ProcessTypeSchema,
  equipmentIdentifier: z.string(),
  processStartDate: IsoDateTimeSchema,
  processEndDate: IsoDateTimeSchema.nullish(),
  inputVolumeLiters: z.number().nullish(),
  outputVolumeLiters: z.number().nullish(),
  wasteVolumeLiters: z.number().nullish(),
  initialAlcoholPercentage: z.number().nullish(),
  isDoEligible: z.boolean(),
  mandatoryRestUntil: IsoDateTimeSchema.nullish(),
  restStatus: RestStatusSchema,
  additionalParams: DistillationCutsSchema.nullish(),
  notes: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
})
export type ProductionBatchResponse = z.infer<typeof ProductionBatchResponseSchema>

export const CreateDistillationBatchSchema = z.object({
  fermentationTankId: z.string().min(1),
  equipmentIdentifier: z.string().min(1),
  processStartDate: DateInputSchema,
  processEndDate: DateInputSchema.nullish(),
  inputVolumeLiters: z.number().min(0).nullish(),
  outputVolumeLiters: z.number().min(0).nullish(),
  wasteVolumeLiters: z.number().min(0).nullish(),
  initialAlcoholPercentage: z.number().min(0).max(100).nullish(),
  isDoEligible: z.boolean().nullish(),
  additionalParams: JsonObjectSchema.nullish(),
  notes: z.string().nullish(),
})
export type CreateDistillationBatchDto = z.infer<typeof CreateDistillationBatchSchema>

/**
 * Respuesta de `GET /v1/production-batches/:id/rest-status`. Sin esquema en el OpenAPI:
 * forma tomada de la guía de pruebas del backend, más `mandatoryRestUntil`.
 */
export const RestStatusResponseSchema = z.object({
  id: z.string(),
  restStatus: RestStatusSchema,
  daysElapsed: z.number().int(),
  daysRemaining: z.number().int(),
  isRestCompleted: z.boolean(),
  mandatoryRestUntil: IsoDateTimeSchema.nullish(),
})
export type RestStatusResponse = z.infer<typeof RestStatusResponseSchema>
