import type { ChainCtx } from '../../chain/engine'
import { identityOf, txById } from '../../chain/state'
import { runChainSeed, seedChainEnv } from '../../tokenization/seed'
import type { BackofficeFixtureSet } from '../../backoffice/seed/generate'
import { REFERENCE_DAY } from '../../shared/dates'
import { uid } from '../../shared/uuid'
import { WINERY_CODES_BY_ID } from '../catalog'
import type { Correction, Lot, LotDossier, MaturityAnalysis, PhytoDecision, StoredLotEvent } from '../schemas'
import { backfillAll } from '../trace/backfill'
import { runDemoLots } from '../trace/demo'
import { dossierCanonical, dossierOf } from '../trace/dossier'
import { isDoEligible } from '../trace/domain'
import { restStatusOf } from '../trace/records'
import { takeSettingsSnapshot } from '../trace/rules'
import { emptyTraceCollections, initialTankTransition, recordTankTransition, releaseLocks, terroirDoEvaluation, toLotView, type BottleLot, type StoredAttachment, type TraceCtx, type TraceState } from '../trace/state'
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

/** TK-01 de Cinti Viejo (lote CVJ-2026-SINGANI-001): el ejemplo de tanque `CLEANED` desde el cierre H2. */
export const CLEANED_TANK_ID = 'd4e37fed-41e1-5399-9b50-e8263a6ca797'
const CLEANED_TANK_AT = '2025-05-26T14:00:00Z'

/**
 * Correcciones del cierre H2 que no caben en las filas base (las mismas que el backend aplica a
 * su semilla, `src/seed/corrections.ts`): TK-01 se limpió al día siguiente de terminar su
 * destilación y su código queda libre. Su historial se reconstruye con las fechas que ya tenía
 * (fin de la fermentación y comienzo de la destilación). Los tanques vacíos TK-06, TK-09 y
 * TK-RED-04 ya no existen en las filas base y TK-08 sale `TRANSFERRED` de ellas.
 */
function applyClosingCorrections(state: TraceState): void {
  const tank = state.tanks.find((t) => t.id === CLEANED_TANK_ID)
  if (!tank || tank.status !== 'TRANSFERRED') throw new Error('Semilla: TK-01 de Cinti Viejo debe llegar TRANSFERRED a la corrección del cierre H2')
  const distillation = state.productionBatches.find((p) => p.fermentationTankId === tank.id)
  tank.transitions = [
    initialTankTransition({ ...tank, status: 'FERMENTING' }),
    ...(tank.endDate ? [{ status: 'COMPLETED' as const, at: tank.endDate, by: null }] : []),
    ...(distillation ? [{ status: 'TRANSFERRED' as const, at: distillation.processStartDate, by: null }] : []),
  ]
  recordTankTransition(tank, 'CLEANED', CLEANED_TANK_AT, null)
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
  applyClosingCorrections(state)
  releaseLocks(state, ctx)
  runDemoLots(state, ctx)
  // La aptitud D.O. de las parcelas es la calculada con los valores vigentes de cada bodega.
  for (const t of state.terroirs) t.isDoEligible = isDoEligible(terroirDoEvaluation(ctx, t).status)
  // Bytes canónicos de los expedientes cerrados: no se guardan en los fixtures (se recalculan).
  for (const lot of state.lots) dossierCanonical(state, ctx, lot)
  return state
}

/** URL públicas de la API en los fixtures (el backend local). */
export const SEED_PUBLIC_API_BASE_URL = 'http://localhost:4000'

/** Contexto de la semilla de la Ola 3 (cadena y tokenización) sobre el de la trazabilidad. */
export function seedChainCtx(backoffice: BackofficeFixtureSet, state: Pick<TraceState, 'wineries'>, ctx: TraceCtx = seedTraceCtx(backoffice)): ChainCtx {
  const urls = { publicApiBaseUrl: SEED_PUBLIC_API_BASE_URL, homeDomain: SEED_PUBLIC_API_BASE_URL.replace(/^https?:\/\//, '') }
  return { ...ctx, env: seedChainEnv(state, backoffice['winery-profiles.json'], backoffice['settings.json'], backoffice['setting-overrides.json'], urls) }
}

/**
 * Archivos de `fixtures/erp/`: las filas del ERP ya migradas y las colecciones de la Ola 2, tras la
 * semilla de la Ola 3 (identidades, preventas, anclajes). `capture` devuelve el estado completo
 * para escribir `fixtures/chain/` y `fixtures/tokenization/`.
 */
export function buildErpFixtureFiles(base: ErpFixtureSet, backoffice: BackofficeFixtureSet, capture?: { state?: TraceState; ctx?: ChainCtx }): ErpFixtureFiles {
  const ctx = seedTraceCtx(backoffice)
  const state = buildTraceState(base, ctx)
  const chainCtx = seedChainCtx(backoffice, state, ctx)
  runChainSeed(state, chainCtx)
  if (capture) Object.assign(capture, { state, ctx: chainCtx })
  // SE-02: los campos legados de la bodega ya no llevan direcciones simuladas (contrato O3 §3.3).
  const wineries = state.wineries.map((w) => {
    const identity = identityOf(state.chain, w.id)
    return { ...w, stellarPublicKey: identity?.accountAddress ?? null, onchainProducerId: null, onchainRegisterTxHash: txById(state.chain, identity?.accountTxId ?? null)?.txHash ?? null }
  })
  return {
    ...base,
    'wineries.json': wineries,
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
