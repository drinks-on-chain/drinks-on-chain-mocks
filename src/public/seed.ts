import type { ChainState } from '../chain/state'
import type { PublicWineryProfile } from '../backoffice/schemas'
import type { BackofficeFixtureSet } from '../backoffice/seed/generate'
import { TRACE_SEED_NOW, type ErpFixtureFiles } from '../erp/seed/trace'
import { emptyTraceCollections, bottleCodeOf, isSerialVoided, voidedRecordsOf, type TraceState } from '../erp/trace/state'
import { buildCollections } from './collections'
import { buildLotPassport, toPublicProfile, type PublicWineryInfo, type WineryResolver } from './passport'
import type { PublicCollection, PublicLotPassport } from './schemas'

// Fixtures del dominio público (`fixtures/public/`, solo en TypeScript): pasaportes de los lotes
// embotellados, códigos de botella de muestra, perfiles públicos de las bodegas activas y el
// borrador del catálogo (§17.1). Los usa el Marketplace sin msw (Server Components, pruebas).

/** Códigos de botella de un lote que sirven de muestra en pruebas y demos. */
export interface BottleCodeSample {
  lotCode: string
  lotId: string
  /** Botellas embotelladas (series `1…total`). */
  total: number
  codes: { serial: number; code: string; status: 'ACTIVE' | 'VOIDED' }[]
}

export interface PublicFixtureSet {
  'passports.json': Record<string, PublicLotPassport>
  'bottle-codes.json': BottleCodeSample[]
  'wineries.json': PublicWineryProfile[]
  'collections.json': PublicCollection[]
}

/** Estado de la trazabilidad a partir de los archivos de `fixtures/erp/`. */
export function traceStateOf(erp: ErpFixtureFiles, chain?: ChainState): TraceState {
  const copy = structuredClone(erp)
  return {
    ...emptyTraceCollections(),
    ...(chain ? { chain: structuredClone(chain) } : {}),
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
    lots: copy['lots.json'],
    lotEvents: copy['lot-events.json'],
    maturityAnalyses: copy['maturity-analyses.json'],
    phytoDecisions: copy['phyto-decisions.json'],
    corrections: copy['corrections.json'],
    attachments: copy['lot-attachments.json'],
    dossiers: copy['lot-dossiers.json'],
    bottleLots: copy['bottle-lots.json'],
    voidedRecords: voidedRecordsOf(copy['corrections.json']),
  }
}

/** Perfil público de una bodega a partir de su ficha del ERP y su perfil de la Ola 1. */
export function wineryResolver(erp: Pick<ErpFixtureFiles, 'wineries.json'>, backoffice: Pick<BackofficeFixtureSet, 'winery-profiles.json'>): WineryResolver {
  return (wineryId): PublicWineryInfo => {
    const w = erp['wineries.json'].find((x) => x.id === wineryId)
    const profile = backoffice['winery-profiles.json'].find((p) => p.wineryId === wineryId)
    return {
      slug: profile?.slug ?? wineryId,
      tradeName: w?.commercialName ?? '',
      region: w?.geographicRegion ?? '',
      category: w?.beverageCategory ?? 'OTHER',
      logoUrl: w?.logoUrl ?? null,
      publicStory: profile?.publicStory ?? null,
      website: profile?.website ?? null,
      active: w?.certificationStatus === 'ACTIVE',
    }
  }
}

export function generatePublicFixtures(erp: ErpFixtureFiles, backoffice: BackofficeFixtureSet, chain?: ChainState): PublicFixtureSet {
  const state = traceStateOf(erp, chain)
  const wineryOf = wineryResolver(erp, backoffice)
  const passports: Record<string, PublicLotPassport> = {}
  const samples: BottleCodeSample[] = []
  for (const bl of state.bottleLots) {
    const lot = state.lots.find((l) => l.id === bl.lotId)
    if (!lot?.lotCode) continue
    passports[lot.lotCode] = buildLotPassport(state, lot, wineryOf(lot.wineryId), TRACE_SEED_NOW)
    const serials = [...new Set([1, 2, 3, ...bl.voided.map((v) => v.serial), bl.total])].filter((s) => s >= 1 && s <= bl.total).sort((a, b) => a - b)
    samples.push({
      lotCode: lot.lotCode,
      lotId: lot.id,
      total: bl.total,
      codes: [
        ...bl.voided.map((v) => ({ serial: v.serial, code: v.code, status: 'VOIDED' as const })),
        ...serials.map((serial) => ({ serial, code: bottleCodeOf(bl, serial), status: isSerialVoided(bl, serial) ? ('VOIDED' as const) : ('ACTIVE' as const) })),
      ].sort((a, b) => a.serial - b.serial || a.status.localeCompare(b.status)),
    })
  }
  const wineries = erp['wineries.json']
    .filter((w) => w.certificationStatus === 'ACTIVE')
    .map((w) => toPublicProfile(wineryOf(w.id)))
    .sort((a, b) => a.tradeName.localeCompare(b.tradeName, 'es'))
  return {
    'passports.json': passports,
    'bottle-codes.json': samples,
    'wineries.json': wineries,
    'collections.json': buildCollections(state, wineryOf, TRACE_SEED_NOW),
  }
}
