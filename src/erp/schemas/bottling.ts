import { z } from 'zod'
import { CorrectionMarksShape, DateInputSchema, IsoDateTimeSchema } from './common'
import { ProductTypeSchema } from './enums'
import { ErrorDetailSchema } from './lots'

// /v1/bottling y /v1/lots/{id}/bottling · embotellado seguro (contrato de la Ola 2 §6):
// BottlingBatchResponseDto, CreateBottlingBatchDto (legado), CreateLotBottlingDto, BottlingPreviewDto.

/** Balance del embotellado (`BottlingBalanceDto`, §6.1). */
export const BottlingBalanceSchema = z.object({
  /** Σ litros de las fuentes. */
  availableLiters: z.number(),
  waterDilutionLiters: z.number(),
  /** Botellas × cL / 100. */
  bottledLiters: z.number(),
  leftoverLiters: z.number(),
  /** Disponible + agua − embotellado − remanente. */
  lossLiters: z.number(),
  lossPercent: z.number(),
  /** `rules.bottling.maxLossPercent` de la instantánea. */
  maxLossPercent: z.number(),
  /** Solo singani: alcohol puro del corazón y el embotellado (L). */
  pureAlcohol: z.object({ availableLiters: z.number(), bottledLiters: z.number() }).nullable(),
  /** Botellas que caben sin superar lo disponible. */
  maxBottles: z.number().int(),
})
export type BottlingBalance = z.infer<typeof BottlingBalanceSchema>

export const LEFTOVER_DISPOSITIONS = ['RETAINED', 'DISCARDED'] as const

/** Remanente declarado al embotellar (`BottlingLeftoverResponseDto`). */
export const BottlingLeftoverSchema = z.object({
  liters: z.number(),
  disposition: z.enum(LEFTOVER_DISPOSITIONS),
  notes: z.string().nullable(),
})
export type BottlingLeftover = z.infer<typeof BottlingLeftoverSchema>

/** Totales de los códigos de botella del embotellado (`BottleCodesSummaryDto`). */
export const BottleCodesSummarySchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  voided: z.number().int(),
  firstSerial: z.number().int().nullable(),
  lastSerial: z.number().int().nullable(),
})
export type BottleCodesSummary = z.infer<typeof BottleCodesSummarySchema>

export const LabelDesignSchema = z.object({ key: z.string(), url: z.string().nullable() })
export type LabelDesign = z.infer<typeof LabelDesignSchema>

export const BottlingBatchResponseSchema = z.object({
  ...CorrectionMarksShape,
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
  /** @deprecated `null` en los embotellados de la Ola 2: el hash válido es el del expediente (§10). */
  blockchainDataHash: z.string().nullish(),
  isAnchoredOnChain: z.boolean(),
  anchoredAt: IsoDateTimeSchema.nullish(),
  /** `{PASSPORT_BASE_URL}/b/{lotCode}` (OP-06). */
  qrBatchUrl: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
  /** Lote (Ola 2). */
  lotId: z.string().nullable(),
  // Solo en las rutas de embotellado:
  /** Código de lote (= `internationalLotCode`). */
  lotCode: z.string().optional(),
  /** Balance con la merma de la instantánea. */
  balance: BottlingBalanceSchema.nullish(),
  leftover: BottlingLeftoverSchema.nullish(),
  bottleCodes: BottleCodesSummarySchema.optional(),
  labelDesign: LabelDesignSchema.nullish(),
})
export type BottlingBatchResponse = z.infer<typeof BottlingBatchResponseSchema>

/**
 * Alta de embotellado por la ruta legada (`POST /v1/bottling`, alias hasta H2): exactamente una
 * fuente. `productType` se deriva del origen; si el enviado no coincide → 422
 * `TRC_PRODUCT_TYPE_MISMATCH` (EA-01).
 */
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

/** Fuente del embotellado del lote (`LotBottlingSourceDto`): una crianza o una destilación. */
export const LotBottlingSourceSchema = z
  .object({
    wineAgingBatchId: z.string().min(1).optional(),
    productionBatchId: z.string().min(1).optional(),
    /** Litros que se toman de la fuente. */
    liters: z.number().positive(),
  })
  .superRefine((s, ctx) => {
    if (Boolean(s.wineAgingBatchId) === Boolean(s.productionBatchId)) {
      ctx.addIssue({ code: 'custom', message: 'Indica wineAgingBatchId o productionBatchId (uno y solo uno)', path: ['wineAgingBatchId'] })
    }
  })
export type LotBottlingSource = z.infer<typeof LotBottlingSourceSchema>

/**
 * `POST /v1/lots/{id}/bottling` y `…/bottling/preview` (`CreateLotBottlingDto`). El tipo de producto
 * no se envía: se deriva de las fuentes. Sin `sources`, todas las abiertas del lote con todo su volumen.
 */
export const CreateLotBottlingSchema = z.object({
  sources: z.array(LotBottlingSourceSchema).min(1).optional(),
  bottlingDate: DateInputSchema,
  packagingFormatCl: z.number().int().min(5).max(300),
  totalBottlesPackaged: z.number().int().min(1).max(100_000),
  finalAlcoholAbv: z.number().min(0).max(100),
  /** Solo singani; en vino → 422 `TRC_DILUTION_NOT_ALLOWED`. */
  waterDilutionLiters: z.number().min(0).optional(),
  leftover: z
    .object({ liters: z.number().min(0), disposition: z.enum(LEFTOVER_DISPOSITIONS), notes: z.string().max(500).optional() })
    .optional(),
  bottleType: z.string().max(120).optional(),
  /** `key` de `POST /v1/uploads`. */
  labelDesignKey: z.string().min(1).optional(),
  /** @deprecated Alias de `labelDesignKey` hasta H2. */
  labelDesignUrl: z.string().min(1).optional(),
})
export type CreateLotBottlingDto = z.infer<typeof CreateLotBottlingSchema>

/** `POST /v1/lots/{id}/bottling/preview` (`BottlingPreviewDto`): no escribe nada. */
export const BottlingPreviewSchema = z.object({
  valid: z.boolean(),
  balance: BottlingBalanceSchema,
  /** Una por regla incumplida (`code` `TRC_…`, `rule`, `meta`). */
  violations: z.array(ErrorDetailSchema),
})
export type BottlingPreview = z.infer<typeof BottlingPreviewSchema>
