import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { PhytosanitaryStatusSchema } from './enums'

// Vista derivada "Lote" del ERP (solo cliente; el backend no tiene esta entidad, doc 09 §2).

export const LOT_STAGES = [
  'pesaje',
  'vendimia',
  'fermentacion',
  'bifurcacion',
  'crianza',
  'reposo',
  'embotellado',
  'rechazado',
] as const
export const LotStageSchema = z.enum(LOT_STAGES)
export type LotStage = z.infer<typeof LotStageSchema>

export const LOT_KINDS = ['vino', 'singani'] as const
export const LotKindSchema = z.enum(LOT_KINDS)
export type LotKind = z.infer<typeof LotKindSchema>

export const LotLockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('crianza'),
    unlockAt: IsoDateTimeSchema,
    released: z.boolean(),
  }),
  z.object({
    kind: z.literal('reposo'),
    unlockAt: IsoDateTimeSchema.nullable(),
    released: z.boolean(),
    daysRemaining: z.number().int(),
  }),
])
export type LotLock = z.infer<typeof LotLockSchema>

export const LotViewSchema = z.object({
  harvestBatchId: z.string(),
  harvestBatchCode: z.string(),
  wineryId: z.string(),
  terroir: z.object({
    id: z.string(),
    parcelName: z.string(),
    varietyName: z.string(),
    altitudeMasl: z.number(),
    isDoEligible: z.boolean(),
  }),
  kind: LotKindSchema.nullable(),
  stage: LotStageSchema,
  phytosanitaryStatus: PhytosanitaryStatusSchema,
  netWeightKg: z.number(),
  tankIds: z.array(z.string()),
  wineAgingBatchId: z.string().nullable(),
  productionBatchId: z.string().nullable(),
  bottlingBatchId: z.string().nullable(),
  internationalLotCode: z.string().nullable(),
  lock: LotLockSchema.nullable(),
})
export type LotView = z.infer<typeof LotViewSchema>
