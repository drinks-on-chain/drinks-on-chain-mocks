import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema } from './common'
import { PhytosanitaryStatusSchema } from './enums'

// /v1/harvest-batches · HarvestBatchResponseDto, CreateHarvestBatchDto, UpdatePhytoStatusDto

export const HarvestBatchResponseSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  terroirId: z.string(),
  harvestBatchCode: z.string(),
  intakeDate: IsoDateTimeSchema,
  harvestYear: z.number().int(),
  grossWeightKg: z.number(),
  tareWeightKg: z.number(),
  netWeightKg: z.number(),
  brixDegrees: z.number(),
  initialPh: z.number(),
  initialAcidityGl: z.number(),
  temperatureAtIntakeC: z.number().nullish(),
  phytosanitaryStatus: PhytosanitaryStatusSchema,
  phytoInspectionPdfUrl: z.string().nullish(),
  certifiedByMemberId: z.string().nullish(),
  notes: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
})
export type HarvestBatchResponse = z.infer<typeof HarvestBatchResponseSchema>

/** Campos de laboratorio obligatorios en el alta del pesaje (doc 09 §8 punto 6). */
export const HARVEST_LAB_FIELDS = ['brixDegrees', 'initialPh', 'initialAcidityGl'] as const

export const CreateHarvestBatchSchema = z.object({
  terroirId: z.string().min(1),
  intakeDate: DateInputSchema,
  harvestYear: z.number().int().min(1900).max(2100),
  grossWeightKg: z.number().positive(),
  tareWeightKg: z.number().min(0),
  brixDegrees: z.number().min(0),
  initialPh: z.number().min(0).max(14),
  initialAcidityGl: z.number().min(0),
  temperatureAtIntakeC: z.number().nullish(),
  phytosanitaryStatus: PhytosanitaryStatusSchema.nullish(),
  notes: z.string().nullish(),
})
export type CreateHarvestBatchDto = z.infer<typeof CreateHarvestBatchSchema>

export const UpdatePhytoStatusSchema = z.object({
  phytosanitaryStatus: PhytosanitaryStatusSchema,
  phytoInspectionPdfUrl: z.string().nullish(),
  notes: z.string().nullish(),
})
export type UpdatePhytoStatusDto = z.infer<typeof UpdatePhytoStatusSchema>

