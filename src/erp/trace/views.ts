import type {
  BatchLabAnalysisResponse,
  BottlingBatchDetail,
  BottlingBatchResponse,
  EnologicalTreatment,
  FermentationLog,
  FermentationTankDetail,
  FermentationTankResponse,
  FermentationTankWithHarvest,
  HarvestBatchDetail,
  HarvestBatchResponse,
  Lot,
  LotBalance,
  LotGraph,
  LotGraphNode,
  LotStageCode,
  LotTimeline,
  MaturityAnalysis,
  PhytoDecision,
  ProductionBatchDetail,
  ProductionBatchResponse,
  ProductionReport,
  ProductionReportRow,
  ProductionReportTotals,
  TankTransition,
  TerroirDetail,
  TerroirResponse,
  TraceActor,
  TraceDashboard,
  WineAgingDetail,
  WineAgingResponse,
} from '../schemas'
import { LAB_UNITS } from '../schemas/lab-analyses'
import { LOT_STAGE_CODES } from '../schemas/lots'
import { PRODUCTION_REPORT_CSV_COLUMNS } from '../schemas/lot-views'
import { dayOf, daysBetween, laPazDate } from './dates'
import { doRulesFromLot, evaluateDo, isDoEligible, readyDateFromLocks, roundTo } from './domain'
import { dossierPreview } from './dossier'
import { allHarvestAnalyses, allHarvestDecisions } from './records'
import {
  agingLockOf,
  allLotLabs,
  bottleCodesSummary,
  bottleLotOf,
  correctionMarks,
  correctionsOf,
  currentLab,
  distillationHeart,
  harvestAvailableKg,
  harvestTerroir,
  initialTankTransition,
  isVoided,
  lotAgings,
  lotBottling,
  lotDenomination,
  lotHarvests,
  lotLocks,
  lotProductions,
  lotProjection,
  lotTanks,
  restLockOf,
  tankAvailableLiters,
  tankLiters,
  terroirDoEvaluation,
  toLotSummary,
  voidedAtOf,
  type StoredLog,
  type StoredTreatment,
  type TraceCtx,
  type TraceState,
} from './state'

// Respuestas de la trazabilidad con sus campos calculados y sus relaciones (los `include` de
// Prisma del backend), y las vistas del lote (contrato de la Ola 2 §11): línea de tiempo, balance,
// grafo, panel y reporte de producción.

const desc = <T>(key: (x: T) => string) => (a: T, b: T) => key(b).localeCompare(key(a))
const asc = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b))

/** Persona (`userId`) de un miembro de bodega. */
function userOfMember(state: TraceState, memberId: string | null | undefined): string | undefined {
  if (!memberId) return undefined
  for (const w of state.wineries) {
    const m = w.members?.find((x) => x.id === memberId)
    if (m) return m.userId
  }
  return undefined
}

/** Quién autoriza los tratamientos de la semilla (los fixtures no lo guardan): el enólogo activo o, si no hay, el dueño. */
function treatmentAuthorizer(state: TraceState, tankId: string): string {
  const tank = state.tanks.find((t) => t.id === tankId)
  const members = state.wineries.find((w) => w.id === tank?.wineryId)?.members?.filter((m) => m.isActive) ?? []
  return (members.find((m) => m.memberRole === 'ENOLOGIST') ?? members.find((m) => m.memberRole === 'OWNER'))?.id ?? ''
}

type MarkSource = Partial<Pick<TraceState, 'corrections'>>

/** `FermentationLogResponseDto` de una lectura guardada, con sus marcas de corrección. */
export function logView(log: StoredLog, state: Pick<TraceState, 'wineries'> & MarkSource): FermentationLog {
  return {
    ...(state.corrections && { ...correctionMarks({ corrections: state.corrections }, 'FERMENTATION_LOG', log.id), voidedAt: voidedAtOf({ corrections: state.corrections }, 'FERMENTATION_LOG', log.id) }),
    id: log.id,
    fermentationTankId: log.fermentationTankId,
    temperatureCelsius: log.temperatureCelsius,
    specificGravity: log.specificGravity ?? null,
    phValue: log.phValue ?? null,
    co2Observations: log.co2Observations ?? null,
    recordedAt: log.recordedAt,
    recordedByUserId: log.recordedByUserId ?? userOfMember(state as TraceState, log.recordedByMemberId) ?? '',
    notes: log.notes ?? null,
  }
}

/** `EnologicalTreatmentResponseDto` de un tratamiento guardado, con sus marcas de corrección. */
export function treatmentView(t: StoredTreatment, state: Pick<TraceState, 'wineries' | 'tanks'> & MarkSource): EnologicalTreatment {
  return {
    ...(state.corrections && { ...correctionMarks({ corrections: state.corrections }, 'TREATMENT', t.id), voidedAt: voidedAtOf({ corrections: state.corrections }, 'TREATMENT', t.id) }),
    id: t.id,
    fermentationTankId: t.fermentationTankId,
    treatmentType: t.treatmentType,
    additiveName: t.additiveName,
    additiveSupplier: t.additiveSupplier ?? null,
    dosageAppliedGPerHl: t.dosageAppliedGPerHl,
    totalAppliedG: t.totalAppliedG ?? null,
    regulatoryAuthCode: t.regulatoryAuthCode,
    appliedAt: t.appliedAt,
    authorizedByMemberId: t.authorizedByMemberId ?? treatmentAuthorizer(state as TraceState, t.fermentationTankId),
    notes: t.notes ?? null,
  }
}

/** Parcela con su aptitud D.O. calculada con los valores vigentes de la bodega (anidada: sin el detalle). */
export function terroirRow(ctx: TraceCtx, t: TerroirResponse): TerroirResponse {
  return { ...t, isDoEligible: isDoEligible(terroirDoEvaluation(ctx, t).status) }
}

/** `GET /v1/terroirs` (con `doEvaluation`) y `/:id` (además sus pesajes, más recientes primero). */
export function terroirView(state: TraceState, ctx: TraceCtx, t: TerroirResponse, detail = false): TerroirDetail {
  const doEvaluation = terroirDoEvaluation(ctx, t)
  return {
    ...t,
    ...correctionMarks(state, 'TERROIR', t.id),
    isDoEligible: isDoEligible(doEvaluation.status),
    doEvaluation,
    ...(detail && { harvestBatches: state.harvestBatches.filter((h) => h.terroirId === t.id).sort(desc((h) => h.intakeDate)) }),
  }
}

/** Análisis de madurez con sus marcas de corrección. */
export const maturityView = (state: TraceState, m: MaturityAnalysis): MaturityAnalysis => ({ ...m, ...correctionMarks(state, 'MATURITY_ANALYSIS', m.id) })

/** Dictamen con sus marcas de corrección. */
export const phytoDecisionView = (state: TraceState, d: PhytoDecision): PhytoDecision => ({ ...d, ...correctionMarks(state, 'PHYTO_DECISION', d.id) })

/** `GET /v1/harvest-batches` (con `terroir`) y `/:id` (además `fermentationTanks`), con análisis, dictámenes, kilos disponibles y D.O. */
export function harvestView(state: TraceState, ctx: TraceCtx, h: HarvestBatchResponse, detail = false): HarvestBatchDetail {
  const terroir = state.terroirs.find((t) => t.id === h.terroirId)
  const lot = h.lotId ? state.lots.find((l) => l.id === h.lotId) : undefined
  return {
    ...h,
    ...correctionMarks(state, 'HARVEST_BATCH', h.id),
    // Todos, también los anulados (marcados `voided`): el valor vigente del pesaje ya no los cuenta.
    maturityAnalyses: allHarvestAnalyses(state, h.id).map((m) => maturityView(state, m)),
    phytoDecisions: allHarvestDecisions(state, h.id).map((d) => phytoDecisionView(state, d)),
    availableKg: harvestAvailableKg(state, h),
    doEvaluation: lot?.productType === 'SINGANI' ? evaluateDo([harvestTerroir(state, h)], doRulesFromLot(lot.rules), 'LOT_SNAPSHOT', ctx.now) : null,
    lateEntry: daysBetween(dayOf(h.intakeDate), laPazDate(h.createdAt)) > 7,
    ...(terroir && { terroir: terroirRow(ctx, terroir) }),
    ...(detail && { fermentationTanks: state.tanks.filter((t) => (t.inputs ?? [{ harvestBatchId: t.harvestBatchId }]).some((i) => i.harvestBatchId === h.id)) }),
  }
}

/**
 * Litros que quedan en el tanque y merma de trasiego (§4.2; `tankVolumes` del backend): el volumen
 * final (o el de llenado) menos lo transferido. Con el tanque `TRANSFERRED` o `CLEANED` ya no queda
 * nada y la diferencia es la merma.
 */
export function tankVolumes(state: TraceState, t: FermentationTankResponse): { availableLiters: number | null; transferLossLiters: number | null } {
  const liters = tankLiters(t)
  if (liters === null) return { availableLiters: null, transferLossLiters: null }
  const drawn =
    state.wineAgings.filter((a) => a.fermentationTankId === t.id).reduce((s, a) => s + (a.volumeLiters ?? 0), 0) +
    state.productionBatches.filter((p) => p.fermentationTankId === t.id).reduce((s, p) => s + (p.inputVolumeLiters ?? 0), 0)
  const remaining = Math.max(0, Math.round((liters - drawn) * 1000) / 1000)
  if (t.status === 'TRANSFERRED' || t.status === 'CLEANED') return { availableLiters: 0, transferLossLiters: remaining }
  return { availableLiters: remaining, transferLossLiters: null }
}

/**
 * Historial de estados del tanque, empezando por el llenado. Los tanques anteriores a las
 * transiciones (migrados) no lo guardan: su único punto conocido es el llenado.
 */
export function tankTransitions(t: FermentationTankResponse): TankTransition[] {
  return t.transitions && t.transitions.length > 0 ? t.transitions : [initialTankTransition(t)]
}

/** Tanque con los campos de la Ola 2 (§4.2): lo que le queda, merma de trasiego, historial y marcas de corrección. */
export function tankRow(state: TraceState, t: FermentationTankResponse): FermentationTankResponse {
  return { ...t, ...correctionMarks(state, 'FERMENTATION_TANK', t.id), ...tankVolumes(state, t), transitions: tankTransitions(t) }
}

/**
 * `GET /v1/fermentation-tanks` (con `harvestBatch`) y `/:id` (además lecturas y tratamientos, en
 * orden cronológico; los anulados se devuelven marcados con `voided` y `voidedAt`).
 */
export function tankView(state: TraceState, t: FermentationTankResponse, detail = false): FermentationTankDetail {
  const harvestBatch = state.harvestBatches.find((h) => h.id === t.harvestBatchId)
  return {
    ...tankRow(state, t),
    ...(harvestBatch && { harvestBatch }),
    ...(detail && {
      logs: state.logs
        .filter((l) => l.fermentationTankId === t.id)
        .sort(asc((l) => l.recordedAt))
        .map((l) => logView(l, state)),
      treatments: state.treatments
        .filter((x) => x.fermentationTankId === t.id)
        .sort(asc((x) => x.appliedAt))
        .map((x) => treatmentView(x, state)),
    }),
  }
}

/** Cuba con su vendimia y la parcela de esta (detalles de crianza, destilación y embotellado). */
function tankWithChain(state: TraceState, ctx: TraceCtx, id: string): FermentationTankWithHarvest | undefined {
  const tank = state.tanks.find((t) => t.id === id)
  if (!tank) return undefined
  const harvest = state.harvestBatches.find((h) => h.id === tank.harvestBatchId)
  const terroir = harvest ? state.terroirs.find((t) => t.id === harvest.terroirId) : undefined
  return { ...tank, ...(harvest && { harvestBatch: { ...harvest, ...(terroir && { terroir: terroirRow(ctx, terroir) }) } }) }
}

/** `GET /v1/wine-aging` (con `fermentationTank`) y `/:id` (cuba con su cadena + `bottlingBatches`), con su candado. */
export function agingView(state: TraceState, ctx: TraceCtx, a: WineAgingResponse, detail = false): WineAgingDetail {
  const lot = a.lotId ? state.lots.find((l) => l.id === a.lotId) : undefined
  const lock = lot && a.agingStatus !== 'DISCARDED' ? agingLockOf(a, lot.rules, ctx.today) : null
  const fermentationTank = detail ? tankWithChain(state, ctx, a.fermentationTankId) : state.tanks.find((t) => t.id === a.fermentationTankId)
  return {
    ...a,
    ...correctionMarks(state, 'WINE_AGING', a.id),
    unlockDate: lock?.unlockDate ?? a.lockUntilDate.slice(0, 10),
    lock,
    availableLiters: a.agingStatus === 'AGING' || a.agingStatus === 'READY' ? (a.volumeLiters ?? null) : 0,
    ...(fermentationTank && { fermentationTank }),
    ...(detail && { bottlingBatches: bottlingsOfSource(state, a.lotId, a.id, 'wineAgingBatchId', a.agingStatus === 'BOTTLED') }),
  }
}

/** Embotellado de una fuente: el suyo por la ruta legada o, en la Ola 2, el de su lote si entró en él. */
function bottlingsOfSource(state: TraceState, lotId: string | null, sourceId: string, key: 'wineAgingBatchId' | 'productionBatchId', bottled: boolean): BottlingBatchResponse[] {
  return state.bottlings.filter((b) => b[key] === sourceId || (bottled && lotId !== null && b.lotId === lotId))
}

/** `GET /v1/production-batches` (con `fermentationTank`) y `/:id` (cuba con su cadena + `bottlingBatches`), con su reposo. */
export function productionView(state: TraceState, ctx: TraceCtx, p: ProductionBatchResponse, detail = false): ProductionBatchDetail {
  const lot = p.lotId ? state.lots.find((l) => l.id === p.lotId) : undefined
  const heart = distillationHeart(p)
  const open = p.restStatus !== 'BOTTLED' && p.restStatus !== 'DISCARDED'
  const fermentationTank = detail ? tankWithChain(state, ctx, p.fermentationTankId) : state.tanks.find((t) => t.id === p.fermentationTankId)
  return {
    ...p,
    ...correctionMarks(state, 'PRODUCTION_BATCH', p.id),
    // D.O. del lote calculada en el servidor (EA-03).
    isDoEligible: lot ? isDoEligible(lotDenomination(state, lot, ctx.now).status) : p.isDoEligible,
    lock: lot && p.restStatus !== 'DISCARDED' ? restLockOf(p, lot.rules, ctx.today) : null,
    pureAlcoholLiters: heart.liters !== null && heart.abv !== null ? roundTo((heart.liters * heart.abv) / 100) : null,
    availableLiters: p.processEndDate ? (open ? heart.liters : 0) : null,
    ...(fermentationTank && { fermentationTank }),
    ...(detail && { bottlingBatches: bottlingsOfSource(state, p.lotId, p.id, 'productionBatchId', p.restStatus === 'BOTTLED') }),
  }
}

/** Análisis de laboratorio con sus unidades, sus marcas de corrección y si es el vigente (ni sustituido ni anulado). */
export function labView(state: TraceState, l: BatchLabAnalysisResponse): BatchLabAnalysisResponse {
  const voidedAt = voidedAtOf(state, 'LAB_ANALYSIS', l.id)
  const current = voidedAt === null && (l.lotId ? currentLab(state, l.lotId)?.id === l.id : !l.supersededAt)
  return { ...l, ...correctionMarks(state, 'LAB_ANALYSIS', l.id), voidedAt, units: LAB_UNITS, current }
}

/** `GET /v1/bottling` (con `labAnalysis`, el vigente) y `/:id` (además el origen con su cadena), con balance y códigos. */
export function bottlingView(state: TraceState, ctx: TraceCtx, b: BottlingBatchResponse, detail = false): BottlingBatchDetail {
  const labAnalysis = (b.lotId ? currentLab(state, b.lotId) : state.labAnalyses.filter((l) => l.bottlingBatchId === b.id).at(-1)) ?? null
  const base: BottlingBatchDetail = {
    ...b,
    ...correctionMarks(state, 'BOTTLING', b.id),
    lotCode: b.internationalLotCode,
    bottleCodes: bottleCodesSummary(b.lotId ? bottleLotOf(state, b.lotId) : null),
    labAnalysis,
  }
  if (!detail) return base
  const aging = b.wineAgingBatchId ? state.wineAgings.find((a) => a.id === b.wineAgingBatchId) : undefined
  const production = b.productionBatchId ? state.productionBatches.find((p) => p.id === b.productionBatchId) : undefined
  const chainOf = (tankId: string) => {
    const fermentationTank = tankWithChain(state, ctx, tankId)
    return fermentationTank ? { fermentationTank } : {}
  }
  return {
    ...base,
    wineAgingBatch: aging ? { ...aging, ...chainOf(aging.fermentationTankId) } : null,
    productionBatch: production ? { ...production, ...chainOf(production.fermentationTankId) } : null,
  }
}

// ---------------------------------------------------------------------------
// Línea de tiempo (§11.1)
// ---------------------------------------------------------------------------

/** Eventos del lote en orden, con sus candados y la fecha estimada de disponibilidad. */
export function lotTimeline(state: TraceState, ctx: Pick<TraceCtx, 'today'>, lot: Lot): LotTimeline {
  const locks = lotLocks(state, lot, ctx.today)
  const readyByLock = readyDateFromLocks(locks)
  return {
    events: state.lotEvents
      .filter((e) => e.lotId === lot.id)
      .sort((a, b) => a.seq - b.seq)
      .map(({ lotId: _lotId, ...event }) => ({ ...event, corrected: event.corrected || correctionsOf(state, event.resource.type, event.resource.id).length > 0 })),
    locks,
    estimatedReadyDate: readyByLock ?? lot.targetReadyDate,
    estimatedReadyBasis: readyByLock ? 'LOCK' : lot.targetReadyDate ? 'DECLARED' : null,
  }
}

// ---------------------------------------------------------------------------
// Balance kilos → litros → botellas (§11.3)
// ---------------------------------------------------------------------------

const sum = (values: readonly (number | null | undefined)[]): number => values.reduce<number>((s, v) => s + (v ?? 0), 0)

export function lotBalance(state: TraceState, lot: Lot): LotBalance {
  const harvests = lotHarvests(state, lot.id)
  const tanks = lotTanks(state, lot.id)
  const kgOf = (...statuses: string[]) => roundTo(sum(harvests.filter((h) => statuses.includes(h.phytosanitaryStatus)).map((h) => h.netWeightKg)))
  const filledLiters = roundTo(sum(tanks.map((t) => t.volumeFilledLiters)))
  const kgInTanks = sum(tanks.flatMap((t) => (t.inputs ?? []).map((i) => i.kg)))
  const completed = tanks.filter((t) => t.finalVolumeLiters !== null)
  const finalLiters = completed.length > 0 ? roundTo(sum(completed.map((t) => t.finalVolumeLiters))) : null
  const filledOfCompleted = sum(completed.map((t) => t.volumeFilledLiters))
  const lossLiters = finalLiters !== null ? roundTo(filledOfCompleted - finalLiters) : null
  const agings = lotAgings(state, lot.id).filter((a) => a.agingStatus !== 'DISCARDED')
  const productions = lotProductions(state, lot.id).filter((p) => p.restStatus !== 'DISCARDED')
  const closed = productions.filter((p) => p.processEndDate)
  const hearts = closed.map(distillationHeart)
  const heartLiters = sum(hearts.map((h) => h.liters))
  const pure = hearts.every((h) => h.liters !== null && h.abv !== null) && hearts.length > 0 ? sum(hearts.map((h) => ((h.liters as number) * (h.abv as number)) / 100)) : null
  return {
    harvest: { netKg: roundTo(sum(harvests.map((h) => h.netWeightKg))), approvedKg: kgOf('APPROVED'), rejectedKg: kgOf('REJECTED'), pendingKg: kgOf('PENDING_INSPECTION', 'QUARANTINE') },
    must: { filledLiters, litersPerKg: kgInTanks > 0 && filledLiters > 0 ? roundTo(filledLiters / kgInTanks, 4) : null },
    fermentation: { finalLiters, lossLiters, lossPercent: lossLiters !== null && filledOfCompleted > 0 ? roundTo((lossLiters / filledOfCompleted) * 100, 2) : null },
    ...(lot.productType === 'WINE' && {
      aging: {
        liters: roundTo(sum(agings.map((a) => a.volumeLiters))),
        lossLiters: roundTo(sum(agings.map((a) => (tankLiters(state.tanks.find((t) => t.id === a.fermentationTankId) ?? ({} as FermentationTankResponse)) ?? a.volumeLiters ?? 0) - (a.volumeLiters ?? 0)))),
      },
    }),
    ...(lot.productType === 'SINGANI' && {
      distillation: {
        inputLiters: roundTo(sum(productions.map((p) => p.inputVolumeLiters))),
        headsLiters: roundTo(sum(closed.map((p) => p.headsLiters))),
        heartLiters: roundTo(heartLiters),
        tailsLiters: roundTo(sum(closed.map((p) => p.tailsLiters))),
        heartAbvPercent: pure !== null && heartLiters > 0 ? roundTo((pure / heartLiters) * 100, 2) : null,
        pureAlcoholLiters: pure !== null ? roundTo(pure) : null,
      },
    }),
    bottling: lotBottling(state, lot.id)?.balance ?? null,
    projection: lotProjection(state, lot),
  }
}

// ---------------------------------------------------------------------------
// Grafo del lote (§11.3)
// ---------------------------------------------------------------------------

/** Autor del evento de la línea de tiempo que registró un recurso. */
function actorOfResource(state: TraceState, lotId: string, resourceId: string): { actor: TraceActor | null; recordedAt: string | null } {
  const event = state.lotEvents.filter((e) => e.lotId === lotId && e.resource.id === resourceId).sort((a, b) => a.seq - b.seq)[0]
  return { actor: event?.actor ?? null, recordedAt: event?.recordedAt ?? null }
}

const metric = (key: string, label: string, value: number | string | null | undefined, unit: string | null = null) => ({ key, label, value: value ?? null, unit })

/** Grafo con datos reales: `value: null` en una métrica = "no registrado" (EA-05). */
export function lotGraph(state: TraceState, lot: Lot): LotGraph {
  const nodes: LotGraphNode[] = []
  const edges: LotGraph['edges'] = []
  const corrected = (type: string, id: string) => correctionsOf(state, type, id).length > 0
  // La corrección de un análisis de madurez o de un dictamen marca el pesaje; la de una lectura o un tratamiento, el tanque.
  const harvestCorrected = (id: string) =>
    corrected('HARVEST_BATCH', id) ||
    state.maturityAnalyses.some((m) => m.harvestBatchId === id && corrected('MATURITY_ANALYSIS', m.id)) ||
    state.phytoDecisions.some((d) => d.harvestBatchId === id && corrected('PHYTO_DECISION', d.id))
  const tankCorrected = (id: string) =>
    corrected('FERMENTATION_TANK', id) ||
    state.logs.some((l) => l.fermentationTankId === id && corrected('FERMENTATION_LOG', l.id)) ||
    state.treatments.some((x) => x.fermentationTankId === id && corrected('TREATMENT', x.id))
  const harvests = lotHarvests(state, lot.id)
  const seenTerroirs = new Set<string>()
  for (const h of harvests) {
    const t = state.terroirs.find((x) => x.id === h.terroirId)
    const snapshot = harvestTerroir(state, h)
    if (!seenTerroirs.has(h.terroirId)) {
      seenTerroirs.add(h.terroirId)
      nodes.push({
        id: h.terroirId,
        type: 'TERROIR',
        label: snapshot.parcelName,
        occurredAt: t?.createdAt ?? h.createdAt,
        recordedAt: t?.createdAt ?? h.createdAt,
        quantity: null,
        metrics: [metric('altitudeMasl', 'Altitud', snapshot.altitudeMasl, 'msnm'), metric('varietyName', 'Cepa', snapshot.varietyName), metric('surfaceHectares', 'Superficie', t?.surfaceHectares, 'ha')],
        actor: null,
        status: t?.isActive === false ? 'INACTIVE' : 'ACTIVE',
        corrected: corrected('TERROIR', h.terroirId),
      })
    }
    const who = actorOfResource(state, lot.id, h.id)
    nodes.push({
      id: h.id,
      type: 'HARVEST_BATCH',
      label: h.harvestBatchCode,
      occurredAt: h.intakeDate,
      recordedAt: h.createdAt,
      quantity: { value: h.netWeightKg, unit: 'kg' },
      metrics: [metric('brixDegrees', 'Brix', h.brixDegrees, '°Bx'), metric('ph', 'pH', h.initialPh), metric('acidityGl', 'Acidez total', h.initialAcidityGl, 'g/L'), metric('temperatureAtIntakeC', 'Temperatura al ingreso', h.temperatureAtIntakeC, '°C')],
      actor: who.actor,
      status: h.phytosanitaryStatus,
      corrected: harvestCorrected(h.id),
    })
    edges.push({ from: h.terroirId, to: h.id, quantity: { value: h.netWeightKg, unit: 'kg' } })
  }
  for (const t of lotTanks(state, lot.id)) {
    const who = actorOfResource(state, lot.id, t.id)
    const readings = state.logs.filter((l) => l.fermentationTankId === t.id && !isVoided(state, 'FERMENTATION_LOG', l.id))
    const last = readings.sort(asc((l) => l.recordedAt)).at(-1)
    nodes.push({
      id: t.id,
      type: 'TANK',
      label: t.tankCode,
      occurredAt: t.startDate,
      recordedAt: t.createdAt,
      quantity: t.volumeFilledLiters !== null && t.volumeFilledLiters !== undefined ? { value: t.volumeFilledLiters, unit: 'L' } : null,
      metrics: [
        metric('finalVolumeLiters', 'Volumen final', t.finalVolumeLiters, 'L'),
        metric('readings', 'Lecturas', readings.length),
        metric('lastTemperatureC', 'Última temperatura', last?.temperatureCelsius, '°C'),
        metric('lastSpecificGravity', 'Última densidad', last?.specificGravity),
        metric('treatments', 'Tratamientos', state.treatments.filter((x) => x.fermentationTankId === t.id && !isVoided(state, 'TREATMENT', x.id)).length),
      ],
      actor: who.actor,
      status: t.status,
      corrected: tankCorrected(t.id),
    })
    for (const input of t.inputs ?? []) edges.push({ from: input.harvestBatchId, to: t.id, quantity: { value: input.kg, unit: 'kg' } })
  }
  const bottling = lotBottling(state, lot.id)
  for (const a of lotAgings(state, lot.id)) {
    nodes.push({
      id: a.id,
      type: 'WINE_AGING',
      label: `${a.containerType}${a.containerCode ? ` ${a.containerCode}` : ''}`,
      occurredAt: a.startDate ? `${dayOf(a.startDate)}T00:00:00Z` : a.createdAt,
      recordedAt: a.createdAt,
      quantity: a.volumeLiters !== null && a.volumeLiters !== undefined ? { value: a.volumeLiters, unit: 'L' } : null,
      metrics: [metric('plannedMonths', 'Meses de crianza', a.plannedMonths, 'meses'), metric('unlockDate', 'Fin del candado', agingLockOf(a, lot.rules, dayOf(a.lockUntilDate)).unlockDate), metric('barrelUseCycle', 'Uso de la barrica', a.barrelUseCycle)],
      actor: actorOfResource(state, lot.id, a.id).actor,
      status: a.agingStatus,
      corrected: corrected('WINE_AGING', a.id),
    })
    edges.push({ from: a.fermentationTankId, to: a.id, quantity: a.volumeLiters !== null && a.volumeLiters !== undefined ? { value: a.volumeLiters, unit: 'L' } : null })
    if (bottling && a.agingStatus === 'BOTTLED') edges.push({ from: a.id, to: bottling.id, quantity: a.volumeLiters !== null && a.volumeLiters !== undefined ? { value: a.volumeLiters, unit: 'L' } : null })
  }
  for (const p of lotProductions(state, lot.id)) {
    const heart = distillationHeart(p)
    nodes.push({
      id: p.id,
      type: 'DISTILLATION',
      label: p.equipmentIdentifier,
      occurredAt: p.processStartDate,
      recordedAt: p.createdAt,
      quantity: heart.liters !== null ? { value: heart.liters, unit: 'L' } : null,
      metrics: [
        metric('inputVolumeLiters', 'Vino base', p.inputVolumeLiters, 'L'),
        metric('headsLiters', 'Cabezas', p.headsLiters, 'L'),
        metric('tailsLiters', 'Colas', p.tailsLiters, 'L'),
        metric('heartAbvPercent', 'Grado del corazón', heart.abv, '% v/v'),
        metric('restUntil', 'Fin del reposo', p.mandatoryRestUntil?.slice(0, 10)),
      ],
      actor: actorOfResource(state, lot.id, p.id).actor,
      status: p.restStatus,
      corrected: corrected('PRODUCTION_BATCH', p.id),
    })
    edges.push({ from: p.fermentationTankId, to: p.id, quantity: p.inputVolumeLiters !== null && p.inputVolumeLiters !== undefined ? { value: p.inputVolumeLiters, unit: 'L' } : null })
    if (bottling && p.restStatus === 'BOTTLED') edges.push({ from: p.id, to: bottling.id, quantity: heart.liters !== null ? { value: heart.liters, unit: 'L' } : null })
  }
  if (bottling) {
    nodes.push({
      id: bottling.id,
      type: 'BOTTLING',
      label: bottling.internationalLotCode,
      occurredAt: bottling.bottlingDate,
      recordedAt: bottling.createdAt,
      quantity: { value: bottling.totalBottlesPackaged, unit: 'bottles' },
      metrics: [
        metric('packagingFormatCl', 'Formato', bottling.packagingFormatCl, 'cL'),
        metric('finalAlcoholAbv', 'Grado', bottling.finalAlcoholAbv, '% v/v'),
        metric('waterDilutionLiters', 'Agua de dilución', bottling.waterDilutionLiters, 'L'),
        metric('lossPercent', 'Merma', bottling.balance?.lossPercent, '%'),
      ],
      actor: actorOfResource(state, lot.id, bottling.id).actor,
      status: lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED' ? 'CERTIFIED' : 'BOTTLED',
      corrected: corrected('BOTTLING', bottling.id),
    })
    // Un análisis anulado sigue como nodo, con `status: 'VOIDED'`.
    for (const l of allLotLabs(state, lot.id)) {
      nodes.push({
        id: l.id,
        type: 'LAB_ANALYSIS',
        label: l.certifiedLaboratoryName,
        occurredAt: l.testPerformedAt,
        recordedAt: l.createdAt,
        quantity: null,
        metrics: [
          metric('actualAlcoholAbv', 'Grado', l.actualAlcoholAbv, LAB_UNITS.actualAlcoholAbv),
          metric('methanolMg100mlAa', 'Metanol', l.methanolMg100mlAa, LAB_UNITS.methanolMg100mlAa),
          metric('copperContentMgL', 'Cobre', l.copperContentMgL, LAB_UNITS.copperContentMgL),
          metric('volatileAcidityAceticGl', 'Acidez volátil', l.volatileAcidityAceticGl, LAB_UNITS.volatileAcidityAceticGl),
        ],
        actor: l.recordedBy ?? null,
        status: isVoided(state, 'LAB_ANALYSIS', l.id) ? 'VOIDED' : l.supersededAt ? 'SUPERSEDED' : (l.conformityStatus ?? 'NOT_RECORDED'),
        corrected: corrected('LAB_ANALYSIS', l.id),
      })
      edges.push({ from: bottling.id, to: l.id, quantity: null })
    }
  }
  return { lotId: lot.id, lotCode: lot.lotCode, productType: lot.productType, nodes, edges }
}

// ---------------------------------------------------------------------------
// Panel de la bodega (§11.2)
// ---------------------------------------------------------------------------

/** Umbrales de las alertas de fermentación (S-18). */
export const FERMENTATION_ALERT_MAX_TEMPERATURE_C = 32
export const FERMENTATION_ALERT_NO_READING_HOURS = 48
/** Días de antelación con los que el panel avisa de un candado. */
export const LOCK_DUE_SOON_DAYS = 14

/** Panel de la trazabilidad de una bodega (`wineryId: null` = todas, para la plataforma). */
export function traceDashboard(state: TraceState, ctx: TraceCtx, wineryId: string | null): TraceDashboard {
  const mine = <T extends { wineryId: string }>(rows: readonly T[]) => (wineryId ? rows.filter((r) => r.wineryId === wineryId) : [...rows])
  const lots = mine(state.lots)
  const lotsByStage = Object.fromEntries(LOT_STAGE_CODES.map((s) => [s, 0])) as Record<LotStageCode, number>
  for (const lot of lots) lotsByStage[lot.stage]++
  const open = lots.filter((l) => !['BOTTLED', 'CERTIFIED', 'ANCHORED', 'REJECTED', 'DISCARDED'].includes(l.stage))
  const locksDueSoon = open
    .flatMap((lot) => lotLocks(state, lot, ctx.today).filter((lock) => !lock.released && lock.daysRemaining <= LOCK_DUE_SOON_DAYS).map((lock) => ({ lotId: lot.id, reference: lot.reference, name: lot.name, lock })))
    .sort((a, b) => a.lock.unlockDate.localeCompare(b.lock.unlockDate))
  const now = Date.parse(ctx.now)
  const fermentationAlerts: TraceDashboard['fermentationAlerts'] = []
  for (const tank of mine(state.tanks)) {
    if (tank.status !== 'FERMENTING' || !tank.lotId) continue
    const last = state.logs
      .filter((l) => l.fermentationTankId === tank.id && !isVoided(state, 'FERMENTATION_LOG', l.id))
      .sort(asc((l) => l.recordedAt))
      .at(-1)
    const base = { tankId: tank.id, tankCode: tank.tankCode, lotId: tank.lotId, lastReadingAt: last?.recordedAt ?? null }
    const since = Date.parse(last?.recordedAt ?? tank.startDate)
    if (now - since > FERMENTATION_ALERT_NO_READING_HOURS * 3_600_000) fermentationAlerts.push({ ...base, kind: 'NO_READING', value: last?.temperatureCelsius ?? null })
    else if (last && last.temperatureCelsius > FERMENTATION_ALERT_MAX_TEMPERATURE_C) fermentationAlerts.push({ ...base, kind: 'HIGH_TEMPERATURE', value: last.temperatureCelsius })
  }
  const harvests = mine(state.harvestBatches)
  const bottled = lots.filter((l) => l.stage === 'BOTTLED')
  return {
    lotsByStage,
    locksDueSoon,
    fermentationAlerts,
    pendingPhyto: harvests
      .filter((h) => h.phytosanitaryStatus === 'PENDING_INSPECTION' || h.phytosanitaryStatus === 'QUARANTINE')
      .sort(asc((h) => h.intakeDate))
      .map((h) => ({ harvestBatchId: h.id, harvestBatchCode: h.harvestBatchCode, lotId: h.lotId, intakeDate: h.intakeDate, status: h.phytosanitaryStatus })),
    bottledWithoutLab: bottled.filter((l) => !currentLab(state, l.id)).map((l) => toLotSummary(state, l, ctx)),
    readyToClose: bottled.filter((l) => dossierPreview(state, ctx, l).ready).map((l) => toLotSummary(state, l, ctx)),
    complianceIssuesOpen: sum(lots.map((l) => l.complianceIssues.filter((i) => !i.resolvedAt).length)),
    unassignedHarvestBatches: harvests.filter((h) => !h.lotId).length,
  }
}

// ---------------------------------------------------------------------------
// Reporte de producción (§11.4)
// ---------------------------------------------------------------------------

/** Máximo de filas del reporte; más → 422 `TRC_REPORT_TOO_LARGE`. */
export const PRODUCTION_REPORT_MAX_ROWS = 10_000

const percent = (loss: number | null, base: number | null): number | null => (loss !== null && base !== null && base > 0 ? roundTo((loss / base) * 100, 2) : null)

export function productionReportRow(state: TraceState, lot: Lot): ProductionReportRow {
  const balance = lotBalance(state, lot)
  const tanks = lotTanks(state, lot.id)
  const bottling = lotBottling(state, lot.id)
  const mustLiters = tanks.length > 0 ? balance.must.filledLiters : null
  const baseWineLiters = balance.fermentation.finalLiters
  const heartLiters = balance.distillation && balance.distillation.heartLiters > 0 ? balance.distillation.heartLiters : null
  const bottles = bottling ? bottleCodesSummary(bottleLotOf(state, lot.id)).active : null
  const netKg = balance.harvest.netKg
  return {
    lotId: lot.id,
    reference: lot.reference,
    lotCode: lot.lotCode,
    name: lot.name,
    productType: lot.productType,
    harvestYear: lot.harvestYear,
    stage: lot.stage,
    netKg,
    mustLiters,
    baseWineLiters,
    heartLiters,
    bottledLiters: bottling ? (bottling.balance?.bottledLiters ?? roundTo((bottling.totalBottlesPackaged * bottling.packagingFormatCl) / 100)) : null,
    bottles,
    formatCl: bottling?.packagingFormatCl ?? null,
    lossPercentByStage: {
      fermentation: balance.fermentation.lossPercent,
      transfer: balance.aging ? percent(balance.aging.lossLiters, balance.aging.liters + balance.aging.lossLiters) : null,
      distillation: balance.distillation && heartLiters !== null ? percent(balance.distillation.inputLiters - heartLiters, balance.distillation.inputLiters) : null,
      bottling: bottling?.balance?.lossPercent ?? null,
    },
    litersPerKg: balance.must.litersPerKg,
    bottlesPerTonne: bottles !== null && netKg > 0 ? roundTo(bottles / (netKg / 1000), 1) : null,
    bottlingDate: bottling?.bottlingDate.slice(0, 10) ?? null,
    labStatus: currentLab(state, lot.id)?.conformityStatus ?? 'NOT_RECORDED',
  }
}

function totalsOf(rows: readonly ProductionReportRow[]): ProductionReportTotals {
  const netKg = roundTo(sum(rows.map((r) => r.netKg)))
  const mustLiters = roundTo(sum(rows.map((r) => r.mustLiters)))
  const bottles = sum(rows.map((r) => r.bottles))
  return {
    lots: rows.length,
    netKg,
    mustLiters,
    baseWineLiters: roundTo(sum(rows.map((r) => r.baseWineLiters))),
    heartLiters: roundTo(sum(rows.map((r) => r.heartLiters))),
    bottledLiters: roundTo(sum(rows.map((r) => r.bottledLiters))),
    bottles,
    litersPerKg: netKg > 0 ? roundTo(mustLiters / netKg, 4) : null,
    bottlesPerTonne: netKg > 0 ? roundTo(bottles / (netKg / 1000), 1) : null,
  }
}

export interface ProductionReportFilter {
  wineryId: string | null
  from?: string
  to?: string
  productType?: 'WINE' | 'SINGANI'
  stages?: LotStageCode[]
}

/** Una fila por lote (por fecha de creación) y totales por tipo de producto. */
export function productionReport(state: TraceState, filter: ProductionReportFilter): ProductionReport {
  const rows = state.lots
    .filter(
      (l) =>
        (!filter.wineryId || l.wineryId === filter.wineryId) &&
        (!filter.productType || l.productType === filter.productType) &&
        (!filter.stages || filter.stages.includes(l.stage)) &&
        (!filter.from || laPazDate(l.createdAt) >= filter.from) &&
        (!filter.to || laPazDate(l.createdAt) <= filter.to),
    )
    .sort(asc((l) => l.createdAt))
    .map((l) => productionReportRow(state, l))
  return {
    rows,
    totals: {
      WINE: totalsOf(rows.filter((r) => r.productType === 'WINE')),
      SINGANI: totalsOf(rows.filter((r) => r.productType === 'SINGANI')),
      UNDECIDED: totalsOf(rows.filter((r) => r.productType === null)),
    },
  }
}

/** CSV del reporte (`text/csv; charset=utf-8`, CRLF), con las mismas columnas y sin totales. */
export function productionReportCsv(report: ProductionReport): string {
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [PRODUCTION_REPORT_CSV_COLUMNS.join(',')]
  for (const r of report.rows) {
    const flat: Record<string, unknown> = {
      ...r,
      lossPercentFermentation: r.lossPercentByStage.fermentation,
      lossPercentTransfer: r.lossPercentByStage.transfer,
      lossPercentDistillation: r.lossPercentByStage.distillation,
      lossPercentBottling: r.lossPercentByStage.bottling,
    }
    lines.push(PRODUCTION_REPORT_CSV_COLUMNS.map((c) => cell(flat[c])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

export { tankAvailableLiters }
