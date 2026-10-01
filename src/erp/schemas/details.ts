import { z } from 'zod'
import { BottlingBatchResponseSchema } from './bottling'
import { EnologicalTreatmentSchema, FermentationLogSchema, FermentationTankResponseSchema } from './fermentation-tanks'
import { HarvestBatchResponseSchema } from './harvest-batches'
import { BatchLabAnalysisResponseSchema } from './lab-analyses'
import { ProductionBatchResponseSchema } from './production-batches'
import { TerroirResponseSchema } from './terroirs'
import { WineAgingResponseSchema } from './wine-aging'

// Relaciones que el backend incluye en las respuestas del ERP (los `include` de Prisma, que el
// OpenAPI declara como campos opcionales de cada DTO). Los esquemas `*ResponseSchema` son la
// fila sin relaciones; estos, la fila con las relaciones que trae cada ruta. Todas son
// opcionales: la respuesta de un alta (`POST`) no las lleva.
//
// | Ruta | Relaciones |
// |---|---|
// | `GET /terroirs/:id` | `harvestBatches` (más recientes primero) |
// | `GET /harvest-batches` | `terroir` |
// | `GET /harvest-batches/:id` | `terroir`, `fermentationTanks` |
// | `GET /fermentation-tanks` | `harvestBatch` |
// | `GET /fermentation-tanks/:id` | `harvestBatch`, `logs`, `treatments` (en orden cronológico) |
// | `GET /wine-aging`, `GET /production-batches` | `fermentationTank` |
// | `GET /wine-aging/:id`, `GET /production-batches/:id` | `fermentationTank` (con `harvestBatch.terroir`), `bottlingBatches` |
// | `GET /bottling` | `labAnalysis` (`null` si no hay) |
// | `GET /bottling/:id` | `labAnalysis`, `wineAgingBatch` y `productionBatch` (con la cuba, la vendimia y la parcela; `null` el que no aplica) |

/** Vendimia con su parcela. */
export const HarvestBatchWithTerroirSchema = HarvestBatchResponseSchema.extend({
  terroir: TerroirResponseSchema.optional(),
})
export type HarvestBatchWithTerroir = z.infer<typeof HarvestBatchWithTerroirSchema>

/** Cuba con su vendimia (y la parcela de esta en los detalles de crianza, destilación y embotellado). */
export const FermentationTankWithHarvestSchema = FermentationTankResponseSchema.extend({
  harvestBatch: HarvestBatchWithTerroirSchema.optional(),
})
export type FermentationTankWithHarvest = z.infer<typeof FermentationTankWithHarvestSchema>

/** `GET /v1/terroirs/:id`: parcela + lotes de vendimia. */
export const TerroirDetailSchema = TerroirResponseSchema.extend({
  harvestBatches: z.array(HarvestBatchResponseSchema).optional(),
})
export type TerroirDetail = z.infer<typeof TerroirDetailSchema>

/** `GET /v1/harvest-batches` (con `terroir`) y `/:id` (además `fermentationTanks`). */
export const HarvestBatchDetailSchema = HarvestBatchWithTerroirSchema.extend({
  fermentationTanks: z.array(FermentationTankResponseSchema).optional(),
})
export type HarvestBatchDetail = z.infer<typeof HarvestBatchDetailSchema>

/** `GET /v1/fermentation-tanks` (con `harvestBatch`) y `/:id` (además `logs` y `treatments`). */
export const FermentationTankDetailSchema = FermentationTankResponseSchema.extend({
  harvestBatch: HarvestBatchResponseSchema.optional(),
  logs: z.array(FermentationLogSchema).optional(),
  treatments: z.array(EnologicalTreatmentSchema).optional(),
})
export type FermentationTankDetail = z.infer<typeof FermentationTankDetailSchema>

/** `GET /v1/wine-aging` (con `fermentationTank`) y `/:id` (cuba con vendimia y parcela + `bottlingBatches`). */
export const WineAgingDetailSchema = WineAgingResponseSchema.extend({
  fermentationTank: FermentationTankWithHarvestSchema.optional(),
  bottlingBatches: z.array(BottlingBatchResponseSchema).optional(),
})
export type WineAgingDetail = z.infer<typeof WineAgingDetailSchema>

/** `GET /v1/production-batches` (con `fermentationTank`) y `/:id` (cuba con vendimia y parcela + `bottlingBatches`). */
export const ProductionBatchDetailSchema = ProductionBatchResponseSchema.extend({
  fermentationTank: FermentationTankWithHarvestSchema.optional(),
  bottlingBatches: z.array(BottlingBatchResponseSchema).optional(),
})
export type ProductionBatchDetail = z.infer<typeof ProductionBatchDetailSchema>

/** `GET /v1/bottling` (con `labAnalysis`) y `/:id` (además el origen con su cadena). */
export const BottlingBatchDetailSchema = BottlingBatchResponseSchema.extend({
  labAnalysis: BatchLabAnalysisResponseSchema.nullish(),
  wineAgingBatch: WineAgingResponseSchema.extend({ fermentationTank: FermentationTankWithHarvestSchema.optional() }).nullish(),
  productionBatch: ProductionBatchResponseSchema.extend({ fermentationTank: FermentationTankWithHarvestSchema.optional() }).nullish(),
})
export type BottlingBatchDetail = z.infer<typeof BottlingBatchDetailSchema>
