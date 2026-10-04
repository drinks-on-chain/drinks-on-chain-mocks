import type {
  BatchLabAnalysisResponse,
  BottlingBatchDetail,
  BottlingBatchResponse,
  EnologicalTreatment,
  FermentationLog,
  FermentationTankDetail,
  FermentationTankResponse,
  HarvestBatchDetail,
  HarvestBatchResponse,
  ProductionBatchDetail,
  ProductionBatchResponse,
  TerroirDetail,
  TerroirResponse,
  WineAgingDetail,
  WineAgingResponse,
} from '../schemas'
import { passportUrl } from '../trace/bottling'
import type { StoredLog, StoredTreatment, TraceState } from '../trace/state'
import * as views from '../trace/views'
import { getErpDb } from './db'
import { traceCtx } from './trace-context'

// Respuestas del ERP con sus relaciones y sus campos calculados (los `include` de Prisma de cada
// servicio del backend; ver src/erp/schemas/details.ts): las de `src/erp/trace/views.ts` sobre la
// base de los handlers y el reloj de los mocks.

/** `FermentationLogResponseDto` de una lectura guardada. */
export const logView = (log: StoredLog, db: Pick<TraceState, 'wineries'> & Partial<Pick<TraceState, 'corrections'>> = getErpDb()): FermentationLog => views.logView(log, db)

/** `EnologicalTreatmentResponseDto` de un tratamiento guardado. */
export const treatmentView = (t: StoredTreatment, db: Pick<TraceState, 'wineries' | 'tanks'> & Partial<Pick<TraceState, 'corrections'>> = getErpDb()): EnologicalTreatment => views.treatmentView(t, db)

export const terroirView = (t: TerroirResponse, detail = false): TerroirDetail => views.terroirView(getErpDb(), traceCtx(), t, detail)
export const harvestView = (h: HarvestBatchResponse, detail = false): HarvestBatchDetail => views.harvestView(getErpDb(), traceCtx(), h, detail)
export const tankView = (t: FermentationTankResponse, detail = false): FermentationTankDetail => views.tankView(getErpDb(), t, detail)
export const agingView = (a: WineAgingResponse, detail = false): WineAgingDetail => views.agingView(getErpDb(), traceCtx(), a, detail)
export const productionView = (p: ProductionBatchResponse, detail = false): ProductionBatchDetail => views.productionView(getErpDb(), traceCtx(), p, detail)
export const labView = (l: BatchLabAnalysisResponse): BatchLabAnalysisResponse => views.labView(getErpDb(), l)

/** Embotellado con su balance y sus códigos; la URL del QR usa la base del Marketplace de la app. */
export function bottlingView(b: BottlingBatchResponse, detail = false): BottlingBatchDetail {
  const ctx = traceCtx()
  return { ...views.bottlingView(getErpDb(), ctx, b, detail), qrBatchUrl: passportUrl(ctx.passportBaseUrl, b.internationalLotCode) }
}
