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
  processEndDate: DateInputSchema.optional(),
  inputVolumeLiters: z.number().min(0).optional(),
  outputVolumeLiters: z.number().min(0).optional(),
  wasteVolumeLiters: z.number().min(0).optional(),
  initialAlcoholPercentage: z.number().min(0).max(100).optional(),
  isDoEligible: z.boolean().optional(),
  additionalParams: JsonObjectSchema.optional(),
  notes: z.string().optional(),
})
export type CreateDistillationBatchDto = z.infer<typeof CreateDistillationBatchSchema>

/**
 * Respuesta de `GET /v1/production-batches/:id/rest-status` (`RestStatusResponseDto`). Los mocks
 * cuentan los días desde `processEndDate` (o el inicio si no hay fin) con su reloj.
 */
export const RestStatusResponseSchema = z.object({
  id: z.string(),
  restStatus: RestStatusSchema,
  processEndDate: IsoDateTimeSchema.nullable(),
  mandatoryRestUntil: IsoDateTimeSchema.nullable(),
  daysElapsed: z.number().int().min(0),
  daysRemaining: z.number().int().min(0),
  isRestCompleted: z.boolean(),
})
export type RestStatusResponse = z.infer<typeof RestStatusResponseSchema>
