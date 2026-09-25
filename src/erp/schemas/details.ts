import { z } from 'zod'
import { EnologicalTreatmentSchema, FermentationLogSchema, FermentationTankResponseSchema } from './fermentation-tanks'
import { HarvestBatchResponseSchema } from './harvest-batches'
import { TerroirResponseSchema } from './terroirs'

// Detalles con relaciones. El catálogo del backend (`backend/endpoints.md`) dice que estos
// GET incluyen las entidades hijas, pero el OpenAPI solo declara el DTO base. Los campos
// extra son opcionales: el ERP debe funcionar con y sin ellos (doc 09 §8, CONTRATO.md).

/** `GET /v1/terroirs/:id`: parcela + lotes de vendimia históricos. */
export const TerroirDetailSchema = TerroirResponseSchema.extend({
  harvestBatches: z.array(HarvestBatchResponseSchema).optional(),
})
export type TerroirDetail = z.infer<typeof TerroirDetailSchema>

/** `GET /v1/harvest-batches/:id`: lote + tanques vinculados. */
export const HarvestBatchDetailSchema = HarvestBatchResponseSchema.extend({
  fermentationTanks: z.array(FermentationTankResponseSchema).optional(),
})
export type HarvestBatchDetail = z.infer<typeof HarvestBatchDetailSchema>

/** `GET /v1/fermentation-tanks/:id`: tanque + lecturas y tratamientos. */
export const FermentationTankDetailSchema = FermentationTankResponseSchema.extend({
  logs: z.array(FermentationLogSchema).optional(),
  treatments: z.array(EnologicalTreatmentSchema).optional(),
})
export type FermentationTankDetail = z.infer<typeof FermentationTankDetailSchema>
