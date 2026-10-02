import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema } from './common'
import { AgingStatusSchema } from './enums'
import { CalendarDateSchema, LotLockInfoSchema } from './lots'

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
  /** Lote (Ola 2). */
  lotId: z.string().nullable(),
  /** Inicio de la crianza: el candado se cuenta desde aquí. */
  startDate: z.string().nullable(),
  containerCount: z.number().nullable(),
  // Solo en las rutas de crianza:
  /** Fin del candado con la instantánea del lote. */
  unlockDate: CalendarDateSchema.optional(),
  /** Candado evaluado con el reloj del servidor. */
  lock: LotLockInfoSchema.nullish(),
  /** Litros de la crianza aún sin embotellar. */
  availableLiters: z.number().nullish(),
})
export type WineAgingResponse = z.infer<typeof WineAgingResponseSchema>

export const CreateWineAgingBatchSchema = z.object({
  fermentationTankId: z.string().min(1),
  containerType: z.string().min(1),
  containerMaterial: z.string().optional(),
  containerCode: z.string().optional(),
  barrelUseCycle: z.number().int().min(1).optional(),
  /** Obligatorio desde la Ola 2 y ≤ lo disponible del tanque (la diferencia es merma de trasiego). */
  volumeLiters: z.number().positive(),
  /** Barricas o contenedores que agrupa la crianza. */
  containerCount: z.number().int().min(1).optional(),
  /** ≥ mínimo de la instantánea del lote (`trazabilidad.vino.crianzaMinimaMeses`). */
  plannedMonths: z.number().int().min(0),
  startDate: DateInputSchema.optional(),
  notes: z.string().optional(),
})
export type CreateWineAgingBatchDto = z.infer<typeof CreateWineAgingBatchSchema>

/** `POST /v1/wine-aging/{id}/discard` (`DiscardWineAgingDto`): `AGING | READY → DISCARDED`. */
export const DiscardWineAgingSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  /** Por defecto, todo lo disponible. */
  discardedLiters: z.number().min(0).optional(),
})
export type DiscardWineAgingDto = z.infer<typeof DiscardWineAgingSchema>
