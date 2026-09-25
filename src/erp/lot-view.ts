import { dayFromIso, toDay } from '../shared/dates'
import type {
  BottlingBatchResponse,
  FermentationTankResponse,
  HarvestBatchResponse,
  LotKind,
  LotLock,
  LotStage,
  LotView,
  ProductionBatchResponse,
  RestStatusResponse,
  TerroirResponse,
  WineAgingResponse,
} from './schemas'

// Vista derivada "Lote" del ERP (doc 09 §2). Función pura, puerto exacto de `lot_view` de
// `generate.py`: sirve con los fixtures y con datos reales del backend.

/** Días de reposo obligatorio del singani D.O. */
export const SINGANI_REST_DAYS = 180

/** La cadena de entidades de una bodega, tal como la devuelven los GET del backend. */
export interface LotChain {
  harvestBatches: readonly HarvestBatchResponse[]
  terroirs: readonly TerroirResponse[]
  tanks: readonly FermentationTankResponse[]
  wineAgings: readonly WineAgingResponse[]
  productionBatches: readonly ProductionBatchResponse[]
  bottlings: readonly BottlingBatchResponse[]
}

export interface LotViewOptions {
  /** "Hoy" para calcular el reposo. Por defecto, la fecha actual (UTC). */
  today?: Date | string
}

/**
 * Estado del reposo de una destilación, igual que `GET /v1/production-batches/:id/rest-status`
 * (y que `rest_status` de `generate.py`).
 */
export function deriveRestStatus(p: ProductionBatchResponse, options: LotViewOptions = {}): RestStatusResponse {
  const today = toDay(options.today ?? new Date())
  const endIso = p.processEndDate ?? p.processStartDate
  const elapsed = today - dayFromIso(endIso)
  const remaining = Math.max(0, SINGANI_REST_DAYS - elapsed)
  return {
    id: p.id,
    restStatus: p.restStatus,
    daysElapsed: elapsed,
    daysRemaining: remaining,
    isRestCompleted: remaining === 0,
    mandatoryRestUntil: p.mandatoryRestUntil ?? null,
  }
}

/** Deriva la fila `LotView` de un lote de vendimia. */
export function deriveLotView(h: HarvestBatchResponse, chain: LotChain, options: LotViewOptions = {}): LotView {
  const t = chain.terroirs.find((x) => x.id === h.terroirId)
  const tks = chain.tanks.filter((x) => x.harvestBatchId === h.id && x.status !== 'CLEANED')
  const tankIds = new Set(tks.map((x) => x.id))
  const ag = chain.wineAgings.filter((a) => tankIds.has(a.fermentationTankId))
  const pr = chain.productionBatches.filter((p) => tankIds.has(p.fermentationTankId))
  const agIds = new Set(ag.map((a) => a.id))
  const prIds = new Set(pr.map((p) => p.id))
  const bt = chain.bottlings.filter(
    (b) =>
      (ag.length > 0 && b.wineAgingBatchId != null && agIds.has(b.wineAgingBatchId)) ||
      (pr.length > 0 && b.productionBatchId != null && prIds.has(b.productionBatchId)),
  )

  let stage: LotStage
  let lock: LotLock | null = null
  const a0 = ag[0]
  const p0 = pr[0]
  if (bt.length > 0) {
    stage = 'embotellado'
  } else if (a0) {
    stage = 'crianza'
    lock = { kind: 'crianza', unlockAt: a0.lockUntilDate, released: a0.agingStatus === 'READY' }
  } else if (p0) {
    stage = 'reposo'
    const rs = deriveRestStatus(p0, options)
    lock = {
      kind: 'reposo',
      unlockAt: p0.mandatoryRestUntil ?? null,
      released: rs.isRestCompleted,
      daysRemaining: rs.daysRemaining,
    }
  } else if (tks.some((x) => x.status === 'COMPLETED')) {
    stage = 'bifurcacion'
  } else if (tks.length > 0) {
    stage = 'fermentacion'
  } else if (h.phytosanitaryStatus === 'APPROVED') {
    stage = 'vendimia'
  } else if (h.phytosanitaryStatus === 'REJECTED') {
    stage = 'rechazado'
  } else {
    stage = 'pesaje'
  }

  let kind: LotKind | null = null
  if (tks.some((x) => x.destinationType === 'SINGANI_DIST') || pr.length > 0) kind = 'singani'
  else if (ag.length > 0 || bt.length > 0) kind = 'vino'

  return {
    harvestBatchId: h.id,
    harvestBatchCode: h.harvestBatchCode,
    wineryId: h.wineryId,
    // Si la parcela no está en la cadena (p. ej. lista paginada), se devuelve solo su id.
    terroir: {
      id: t?.id ?? h.terroirId,
      parcelName: t?.parcelName ?? '',
      varietyName: t?.varietyName ?? '',
      altitudeMasl: t?.altitudeMasl ?? 0,
      isDoEligible: t?.isDoEligible ?? false,
    },
    kind,
    stage,
    phytosanitaryStatus: h.phytosanitaryStatus,
    netWeightKg: h.netWeightKg,
    tankIds: tks.map((x) => x.id),
    wineAgingBatchId: a0?.id ?? null,
    productionBatchId: p0?.id ?? null,
    bottlingBatchId: bt[0]?.id ?? null,
    internationalLotCode: bt[0]?.internationalLotCode ?? null,
    lock,
  }
}

/** Deriva una fila `LotView` por cada lote de vendimia de la cadena, en el mismo orden. */
export function deriveLotViews(chain: LotChain, options: LotViewOptions = {}): LotView[] {
  return chain.harvestBatches.map((h) => deriveLotView(h, chain, options))
}
