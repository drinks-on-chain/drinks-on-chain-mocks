import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema } from './common'
import { ProductTypeSchema } from './enums'

// /v1/bottling · BottlingBatchResponseDto, CreateBottlingBatchDto

export const BottlingBatchResponseSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  wineAgingBatchId: z.string().nullish(),
  productionBatchId: z.string().nullish(),
  productType: ProductTypeSchema,
  internationalLotCode: z.string(),
  finalAlcoholAbv: z.number(),
  waterDilutionLiters: z.number().nullish(),
  totalBottlesPackaged: z.number(),
  packagingFormatCl: z.number(),
  bottleType: z.string().nullish(),
  labelDesignUrl: z.string().nullish(),
  bottlingDate: IsoDateTimeSchema,
  releasedByMemberId: z.string().nullish(),
  blockchainAnchorTxHash: z.string().nullish(),
  blockchainDataHash: z.string().nullish(),
  isAnchoredOnChain: z.boolean(),
  anchoredAt: IsoDateTimeSchema.nullish(),
  qrBatchUrl: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
})
export type BottlingBatchResponse = z.infer<typeof BottlingBatchResponseSchema>

/** Alta de embotellado: exactamente una fuente (`wineAgingBatchId` o `productionBatchId`). */
export const CreateBottlingBatchSchema = z
  .object({
    wineAgingBatchId: z.string().min(1).nullish(),
    productionBatchId: z.string().min(1).nullish(),
    productType: ProductTypeSchema,
    finalAlcoholAbv: z.number().min(0).max(100),
    waterDilutionLiters: z.number().min(0).nullish(),
    totalBottlesPackaged: z.number().int().positive(),
    packagingFormatCl: z.number().positive(),
    bottleType: z.string().nullish(),
    labelDesignUrl: z.string().nullish(),
    bottlingDate: DateInputSchema,
  })
  .refine((b) => Boolean(b.wineAgingBatchId) !== Boolean(b.productionBatchId), {
    message: 'Indique wineAgingBatchId o productionBatchId (uno y solo uno)',
    path: ['wineAgingBatchId'],
  })
export type CreateBottlingBatchDto = z.infer<typeof CreateBottlingBatchSchema>
