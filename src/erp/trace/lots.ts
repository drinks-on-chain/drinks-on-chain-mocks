import { mintedOfLot } from '../../chain/state'
import { ApiError } from '../handlers/errors'
import type { Lot, UpdateLotDto } from '../schemas'
import { formatQuantity } from './rules'
import { appendLotEvent, assertLotWritable, bottleCodesSummary, bottleLotOf, lotAgings, lotProductions, refreshLotStage, type TraceCtx, type TraceState } from './state'

// Edición y descarte del lote (contrato de la Ola 2 §2.5), y retirada de un lote de demostración.

/** Edita el lote. Cambiar `estimatedBottles` exige `reason` y queda en su historial; `productType` no cambia por aquí (§4.3). */
export function updateLot(state: TraceState, ctx: TraceCtx, lot: Lot, body: UpdateLotDto): Lot {
  assertLotWritable(lot)
  const estimateChanges = body.estimatedBottles !== undefined && body.estimatedBottles !== lot.estimatedBottles
  const reason = body.reason?.trim() || null
  if (estimateChanges && !reason) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', [
      { field: 'reason', message: 'Indica el motivo del cambio de la estimación de botellas (queda en su historial)' },
    ])
  }
  if (estimateChanges) {
    // Ola 3 §5.2: la estimación no baja de lo ya emitido (bajarla de la cuota solo limita futuras ampliaciones).
    const minted = mintedOfLot(state.chain, lot.id)
    if ((body.estimatedBottles as number) < minted) {
      const message = `La estimación no puede ser menor que los ${minted} NFT ya emitidos del lote`
      throw new ApiError(422, 'TOK_ESTIMATE_BELOW_MINTED', message, [{ field: 'estimatedBottles', message, code: 'TOK_ESTIMATE_BELOW_MINTED', expected: minted, actual: body.estimatedBottles }])
    }
  }
  if (body.name !== undefined) lot.name = body.name.trim()
  if (body.plannedFormatCl !== undefined) lot.plannedFormatCl = body.plannedFormatCl
  if (body.targetAbvPercent !== undefined) lot.targetAbvPercent = body.targetAbvPercent
  if (body.targetReadyDate !== undefined) lot.targetReadyDate = body.targetReadyDate
  if (body.notes !== undefined) lot.notes = body.notes
  if (estimateChanges) {
    const previous = lot.estimatedBottles
    lot.estimatedBottles = body.estimatedBottles as number
    lot.estimatedBottlesHistory.push({ value: lot.estimatedBottles, at: ctx.now, by: ctx.actor, reason })
    appendLotEvent(state, ctx, lot, {
      type: 'ESTIMATE_CHANGED',
      occurredAt: ctx.now,
      summary: `Estimación de botellas: ${previous === null ? '—' : formatQuantity(previous)} → ${formatQuantity(lot.estimatedBottles)}`,
      data: { value: lot.estimatedBottles, previous, reason },
      resource: { type: 'lot', id: lot.id },
    })
  }
  refreshLotStage(state, ctx, lot)
  return lot
}

/**
 * Descarta el lote con motivo (§2.2): las fuentes abiertas pasan a `DISCARDED` y se anulan sus
 * códigos de botella. Un lote certificado, rechazado o ya descartado → 409 `TRC_LOT_TERMINAL`.
 */
export function discardLot(state: TraceState, ctx: TraceCtx, lot: Lot, reason: string): Lot {
  assertLotWritable(lot)
  const previousStage = lot.stage
  lot.discarded = { at: ctx.now, by: ctx.actor, reason }
  for (const a of lotAgings(state, lot.id)) if (a.agingStatus === 'AGING' || a.agingStatus === 'READY') a.agingStatus = 'DISCARDED'
  for (const p of lotProductions(state, lot.id)) if (p.restStatus !== 'BOTTLED' && p.restStatus !== 'DISCARDED') p.restStatus = 'DISCARDED'
  const bottleLot = bottleLotOf(state, lot.id)
  const voidedBottleCodes = bottleCodesSummary(bottleLot).active
  if (bottleLot && !bottleLot.allVoided) bottleLot.allVoided = { at: ctx.now, by: ctx.actor, reason: `Lote descartado: ${reason}` }
  refreshLotStage(state, ctx, lot)
  appendLotEvent(state, ctx, lot, {
    type: 'LOT_DISCARDED',
    occurredAt: ctx.now,
    summary: `Lote descartado: ${reason}`,
    data: { reason, previousStage, voidedBottleCodes },
    resource: { type: 'lot', id: lot.id },
  })
  return lot
}

/** Quita un lote y toda su cadena del estado (lo usan los escenarios para rehacer un lote de demostración en otra etapa). */
export function removeLot(state: TraceState, lotId: string): void {
  const harvestIds = new Set(state.harvestBatches.filter((h) => h.lotId === lotId).map((h) => h.id))
  const tankIds = new Set(state.tanks.filter((t) => t.lotId === lotId).map((t) => t.id))
  const labIds = new Set(state.labAnalyses.filter((l) => l.lotId === lotId).map((l) => l.id))
  const analysisIds = new Set(state.maturityAnalyses.filter((m) => harvestIds.has(m.harvestBatchId)).map((m) => m.id))
  const decisionIds = new Set(state.phytoDecisions.filter((d) => harvestIds.has(d.harvestBatchId)).map((d) => d.id))
  const logIds = new Set(state.logs.filter((l) => tankIds.has(l.fermentationTankId)).map((l) => l.id))
  const treatmentIds = new Set(state.treatments.filter((t) => tankIds.has(t.fermentationTankId)).map((t) => t.id))
  const gone = new Set([...harvestIds, ...tankIds, ...labIds, ...analysisIds, ...decisionIds, ...logIds, ...treatmentIds])
  state.lots = state.lots.filter((l) => l.id !== lotId)
  state.lotEvents = state.lotEvents.filter((e) => e.lotId !== lotId)
  state.harvestBatches = state.harvestBatches.filter((h) => !harvestIds.has(h.id))
  state.maturityAnalyses = state.maturityAnalyses.filter((m) => !analysisIds.has(m.id))
  state.phytoDecisions = state.phytoDecisions.filter((d) => !decisionIds.has(d.id))
  state.tanks = state.tanks.filter((t) => !tankIds.has(t.id))
  state.logs = state.logs.filter((l) => !logIds.has(l.id))
  state.treatments = state.treatments.filter((t) => !treatmentIds.has(t.id))
  state.wineAgings = state.wineAgings.filter((a) => a.lotId !== lotId)
  state.productionBatches = state.productionBatches.filter((p) => p.lotId !== lotId)
  state.bottlings = state.bottlings.filter((b) => b.lotId !== lotId)
  state.labAnalyses = state.labAnalyses.filter((l) => l.lotId !== lotId)
  state.bottleLots = state.bottleLots.filter((b) => b.lotId !== lotId)
  state.bottleExports = state.bottleExports.filter((e) => e.lotId !== lotId)
  state.dossiers = state.dossiers.filter((d) => d.lotId !== lotId)
  state.corrections = state.corrections.filter((c) => c.lotId !== lotId)
  state.attachments = state.attachments.filter((a) => a.lotId !== lotId)
  state.voidedRecords = state.voidedRecords.filter((key) => !gone.has(key.split(':').at(-1) ?? ''))
}
