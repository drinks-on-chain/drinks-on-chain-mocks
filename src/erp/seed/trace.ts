import type { BackofficeFixtureSet } from '../../backoffice/seed/generate'
import { REFERENCE_DAY } from '../../shared/dates'
import { uid } from '../../shared/uuid'
import { WINERY_CODES_BY_ID } from '../catalog'
import { deriveLotViews } from '../lot-view'
import type { Correction, DagGraph, Lot, LotDossier, MaturityAnalysis, PhytoDecision, StoredLotEvent } from '../schemas'
import { backfillAll } from '../trace/backfill'
import { runDemoLots } from '../trace/demo'
import { dossierCanonical, dossierOf } from '../trace/dossier'
import { isDoEligible } from '../trace/domain'
import { legacyDagGraph } from '../trace/legacy-dag'
import { restStatusOf } from '../trace/records'
import { takeSettingsSnapshot } from '../trace/rules'
import { emptyTraceCollections, releaseLocks, terroirDoEvaluation, toLotView, type BottleLot, type StoredAttachment, type TraceCtx, type TraceState } from '../trace/state'
import type { ErpFixtureSet } from './generate'

// Fixtures de la Ola 2 (solo en TypeScript, como los del back office): parten de las filas del
// ERP iguales a las de `generate.py` (los datos anteriores a la migración), las migran con la misma
// lógica que el backend (`backfillAll`: un lote por pesaje, con el id de su semilla) y añaden los
// lotes nativos de demostración, incluido el caso del contrato §18. Lo que se escribe en
// `fixtures/erp/` son las filas ya migradas más las colecciones nuevas.

/** Momento de la migración y del reloj de los mocks (mediodía UTC del día de referencia). */
export const TRACE_SEED_NOW = `${REFERENCE_DAY}T12:00:00Z`

/** Base del QR de los fixtures: la URL local del Marketplace (los handlers usan la de `setMockAppUrls`). */
export const SEED_PASSPORT_BASE_URL = 'http://localhost:3005'

/** Archivos nuevos de `fixtures/erp/` (Ola 2). */
export interface TraceFixtureSet {
  'lots.json': Lot[]
  'lot-events.json': StoredLotEvent[]
  'maturity-analyses.json': MaturityAnalysis[]
  'phyto-decisions.json': PhytoDecision[]
  'bottle-lots.json': BottleLot[]
  'corrections.json': Correction[]
  'lot-attachments.json': StoredAttachment[]
  'lot-dossiers.json': LotDossier[]
}

/** Todo lo que `pnpm seed` escribe en `fixtures/erp/`. */
export type ErpFixtureFiles = ErpFixtureSet & TraceFixtureSet

/** Ids deterministas de la semilla (`seed:<recurso>:<n>`). */
function seedIds(): (kind: string) => string {
  const counters: Record<string, number> = {}
  return (kind) => uid(`seed:${kind}:${(counters[kind] = (counters[kind] ?? 0) + 1)}`)
}

/** Contexto de la semilla: reloj en el día de referencia y configuración de los fixtures del back office. */
export function seedTraceCtx(backoffice: Pick<BackofficeFixtureSet, 'settings.json' | 'setting-overrides.json' | 'winery-profiles.json'>, now = TRACE_SEED_NOW): TraceCtx {
  const profiles = backoffice['winery-profiles.json']
  return {
    now,
    today: now.slice(0, 10),
    actor: null,
    newId: seedIds(),
    passportBaseUrl: SEED_PASSPORT_BASE_URL,
    snapshot: (wineryId) => takeSettingsSnapshot(backoffice['settings.json'], backoffice['setting-overrides.json'], wineryId, now),
    lotPrefix: (wineryId) => profiles.find((p) => p.wineryId === wineryId)?.lotPrefix ?? WINERY_CODES_BY_ID[wineryId] ?? 'DOC',
  }
}

/** Estado de la trazabilidad a partir de las filas base, migrado y con los lotes de demostración. */
export function buildTraceState(base: ErpFixtureSet, ctx: TraceCtx): TraceState {
  const copy = structuredClone(base)
  const state: TraceState = {
    wineries: copy['wineries.json'],
    terroirs: copy['terroirs.json'],
    harvestBatches: copy['harvest-batches.json'],
    tanks: copy['fermentation-tanks.json'],
    logs: copy['fermentation-logs.json'],
    treatments: copy['enological-treatments.json'],
    wineAgings: copy['wine-aging.json'],
    productionBatches: copy['production-batches.json'],
    bottlings: copy['bottling.json'],
    labAnalyses: copy['lab-analyses.json'],
    ...emptyTraceCollections(),
  }
  backfillAll(state, ctx)
  releaseLocks(state, ctx)
  runDemoLots(state, ctx)
  // La aptitud D.O. de las parcelas es la calculada con los valores vigentes de cada bodega.
  for (const t of state.terroirs) t.isDoEligible = isDoEligible(terroirDoEvaluation(ctx, t).status)
  // Bytes canónicos de los expedientes cerrados: no se guardan en los fixtures (se recalculan).
  for (const lot of state.lots) dossierCanonical(state, ctx, lot)
  return state
}

/** Archivos de `fixtures/erp/`: las filas del ERP ya migradas, las vistas legadas recalculadas y las colecciones de la Ola 2. */
export function buildErpFixtureFiles(base: ErpFixtureSet, backoffice: BackofficeFixtureSet): ErpFixtureFiles {
  const ctx = seedTraceCtx(backoffice)
  const state = buildTraceState(base, ctx)
  const chain = {
    wineries: state.wineries,
    terroirs: state.terroirs,
    harvestBatches: state.harvestBatches,
    tanks: state.tanks,
    wineAgings: state.wineAgings,
    productionBatches: state.productionBatches,
    bottlings: state.bottlings,
    labAnalyses: state.labAnalyses,
  }
  const publicPassports: Record<string, DagGraph> = {}
  for (const b of state.bottlings) publicPassports[b.internationalLotCode] = legacyDagGraph(state, b)
  return {
    ...base,
    'terroirs.json': state.terroirs,
    'harvest-batches.json': state.harvestBatches,
    'fermentation-tanks.json': state.tanks,
    'fermentation-logs.json': state.logs,
    'enological-treatments.json': state.treatments,
    'wine-aging.json': state.wineAgings,
    'production-batches.json': state.productionBatches,
    'production-rest-status.json': state.productionBatches.map((p) => restStatusOf(state, ctx, p)),
    'bottling.json': state.bottlings,
    'lab-analyses.json': state.labAnalyses,
    'traceability-public.json': publicPassports,
    'lots-view.json': deriveLotViews(chain, { today: REFERENCE_DAY }),
    'lots.json': state.lots.map((lot) => toLotView(state, lot, ctx)),
    'lot-events.json': state.lotEvents,
    'maturity-analyses.json': state.maturityAnalyses,
    'phyto-decisions.json': state.phytoDecisions,
    'bottle-lots.json': state.bottleLots,
    'corrections.json': state.corrections,
    'lot-attachments.json': state.attachments,
    'lot-dossiers.json': state.lots.filter((lot) => state.dossiers.some((d) => d.lotId === lot.id)).map((lot) => dossierOf(state, lot)),
  }
}
