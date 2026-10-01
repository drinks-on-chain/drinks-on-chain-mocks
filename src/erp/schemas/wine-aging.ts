import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema } from './common'
import { AgingStatusSchema } from './enums'

// /v1/wine-aging · WineAgingResponseDto, CreateWineAgingBatchDto

export const WineAgingResponseSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  fermentationTankId: z.string(),
  containerType: z.string(),
  containerMaterial: z.string().nullish(),
  containerCode: z.string().nullish(),
  barrelUseCycle: z.number().nullish(),
  volumeLiters: z.number().nullish(),
  plannedMonths: z.number(),
  lockUntilDate: IsoDateTimeSchema,
  agingStatus: AgingStatusSchema,
  notes: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
})
export type WineAgingResponse = z.infer<typeof WineAgingResponseSchema>

export const CreateWineAgingBatchSchema = z.object({
  fermentationTankId: z.string().min(1),
  containerType: z.string().min(1),
  containerMaterial: z.string().optional(),
  containerCode: z.string().optional(),
  barrelUseCycle: z.number().int().min(1).optional(),
  volumeLiters: z.number().positive().optional(),
  plannedMonths: z.number().int().min(0),
  startDate: DateInputSchema.optional(),
  notes: z.string().optional(),
})
export type CreateWineAgingBatchDto = z.infer<typeof CreateWineAgingBatchSchema>
