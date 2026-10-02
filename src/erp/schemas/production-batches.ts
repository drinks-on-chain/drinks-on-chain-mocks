import { z } from 'zod'
import { CorrectionMarksShape, DateInputSchema, IsoDateTimeSchema, JsonObjectSchema } from './common'
import { ProcessTypeSchema, RestStatusSchema } from './enums'
import { LotLockInfoSchema } from './lots'

// /v1/production-batches · destilación de singani y reposo obligatorio

/** Cortes del alambique en `additionalParams` (cabezas, corazón y colas). */
export const DistillationCutsSchema = z.looseObject({
  headDiscardLiters: z.number().nullish(),
  heartYieldLiters: z.number().nullish(),
  tailDiscardLiters: z.number().nullish(),
})
export type DistillationCuts = z.infer<typeof DistillationCutsSchema>

export const ProductionBatchResponseSchema = z.object({
  ...CorrectionMarksShape,
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
  /** Lote (Ola 2). */
  lotId: z.string().nullable(),
  /** Cortes de la destilación (L); `null` mientras sigue abierta o en registros sin ese dato. */
  headsLiters: z.number().nullable(),
  heartLiters: z.number().nullable(),
  tailsLiters: z.number().nullable(),
  vinasseLiters: z.number().nullable(),
  /** Grado del corazón (% v/v). */
  heartAbvPercent: z.number().nullable(),
  // Solo en las rutas de destilación:
  /** Candado de reposo con la instantánea del lote. */
  lock: LotLockInfoSchema.nullish(),
  /** Alcohol puro del corazón: litros × grado. */
  pureAlcoholLiters: z.number().nullish(),
  /** Corazón aún sin embotellar. */
  availableLiters: z.number().nullish(),
})
export type ProductionBatchResponse = z.infer<typeof ProductionBatchResponseSchema>

export const CreateDistillationBatchSchema = z.object({
  fermentationTankId: z.string().min(1),
  equipmentIdentifier: z.string().min(1),
  processStartDate: DateInputSchema,
  processEndDate: DateInputSchema.optional(),
  inputVolumeLiters: z.number().min(0).optional(),
  /**
   * Última destilación del tanque: pasa a `TRANSFERRED` aunque le quede volumen (queda como merma
   * de trasiego). Sin él, el tanque se transfiere solo al agotarse su volumen (§4.2).
   */
  closeTank: z.boolean().optional(),
  outputVolumeLiters: z.number().min(0).optional(),
  wasteVolumeLiters: z.number().min(0).optional(),
  initialAlcoholPercentage: z.number().min(0).max(100).optional(),
  /** @deprecated Se ignora: la D.O. del lote se calcula en el servidor (EA-03). Sale de la entrada en H2. */
  isDoEligible: z.boolean().optional(),
  additionalParams: JsonObjectSchema.optional(),
  notes: z.string().optional(),
})
export type CreateDistillationBatchDto = z.infer<typeof CreateDistillationBatchSchema>

/** Cortes del cierre (`DistillationCutsDto`): cabezas, corazón y colas, en litros. */
export const CloseDistillationCutsSchema = z.object({
  headsLiters: z.number().min(0),
  heartLiters: z.number().min(0),
  tailsLiters: z.number().min(0),
})

/**
 * `POST /v1/production-batches/{id}/close` (`CloseDistillationDto`). Balance de masa:
 * cabezas + corazón + colas (+ vinaza) ≤ `inputVolumeLiters` → si no, 422 `TRC_MASS_BALANCE_EXCEEDED`.
 */
export const CloseDistillationSchema = z.object({
  processEndDate: DateInputSchema,
  cuts: CloseDistillationCutsSchema,
  heartAbvPercent: z.number().min(0).max(100),
  vinasseLiters: z.number().min(0).optional(),
  notes: z.string().max(2000).optional(),
})
export type CloseDistillationDto = z.infer<typeof CloseDistillationSchema>

/** `POST /v1/production-batches/{id}/discard` (`DiscardProductionBatchDto`). */
export const DiscardProductionBatchSchema = z.object({ reason: z.string().trim().min(3).max(500) })
export type DiscardProductionBatchDto = z.infer<typeof DiscardProductionBatchSchema>

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
