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
    wineAgingBatchId: z.string().min(1).optional(),
    productionBatchId: z.string().min(1).optional(),
    productType: ProductTypeSchema,
    finalAlcoholAbv: z.number().min(0).max(100),
    waterDilutionLiters: z.number().min(0).optional(),
    totalBottlesPackaged: z.number().int().positive(),
    packagingFormatCl: z.number().positive(),
    bottleType: z.string().optional(),
    labelDesignUrl: z.string().optional(),
    bottlingDate: DateInputSchema,
  })
  .superRefine((b, ctx) => {
    if (!b.wineAgingBatchId && !b.productionBatchId) {
      // Mismo mensaje y campos que el backend (O0-BE-2).
      const message =
        'Debe especificar un lote de crianza (wineAgingBatchId) o un lote de producción/destilación (productionBatchId)'
      ctx.addIssue({ code: 'custom', message, path: ['wineAgingBatchId'] })
      ctx.addIssue({ code: 'custom', message, path: ['productionBatchId'] })
    } else if (b.wineAgingBatchId && b.productionBatchId) {
      ctx.addIssue({ code: 'custom', message: 'Indique wineAgingBatchId o productionBatchId (uno y solo uno)', path: ['wineAgingBatchId'] })
    }
  })
export type CreateBottlingBatchDto = z.infer<typeof CreateBottlingBatchSchema>
