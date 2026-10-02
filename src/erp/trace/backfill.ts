import type { ApiErrorDetail } from '../../shared/envelope'
import { uid } from '../../shared/uuid'
import type { BottlingBatchResponse, Lot, LotProductType, MaturityAnalysis, PhytoDecision, ProductionBatchResponse, TraceActor, WineAgingResponse } from '../schemas'
import { allocateBottleLot, LAB_STATUS_LABELS, passportUrl } from './bottling'
import { dayOf, laPazDate, toDateField } from './dates'
import {
  agingLock,
  bottlingBalanceViolations,
  computeBottlingBalance,
  computeLabConformity,
  doRulesFromLot,
  doViolations,
  evaluateDo,
  methanolToAnhydrous,
  restLock,
  type BottlingBalanceInput,
} from './domain'
import { formatQuantity, LOT_RULE_KEYS, violation } from './rules'
import {
  addComplianceIssue,
  agingStartDay,
  appendLotEvent,
  bottleLotOf,
  createLot,
  distillationHeart,
  harvestTerroir,
  isAgingOpen,
  isProductionOpen,
  lotAgings,
  lotBottling,
  lotHarvests,
  lotProductions,
  lotTanks,
  refreshLotStage,
  tankLiters,
  type TraceCtx,
  type TraceState,
} from './state'

// Migración de los datos anteriores a la Ola 2 (contrato §2.6) y revisión de integridad. Como
// `lot-backfill.ts` del backend: un lote por pesaje con el mismo id (UUID v5 de `lot:{pesaje}` en el
// espacio de nombres del proyecto), instantánea `MIGRATION`, dictámenes, primer análisis de madurez,
// entradas de tanque, conformidad de laboratorio recalculada, códigos de botella y línea de tiempo.
// Lo que no cumple las reglas de la ola no se borra ni se corrige solo: queda como incidencia.

/** Id del lote migrado de un pesaje: el mismo que deriva la semilla del backend. */
export const migratedLotId = (harvestBatchId: string): string => uid(`lot:${harvestBatchId}`)

export interface IntegrityIssue {
  code: string
  message: string
  details: ApiErrorDetail[]
}

/** Membresía (`TraceActor`) de un miembro de bodega por su id; `null` si no consta. */
export function actorOfMember(state: Pick<TraceState, 'wineries'>, memberId: string | null | undefined): TraceActor | null {
  if (!memberId) return null
  for (const w of state.wineries) {
    const m = w.members?.find((x) => x.id === memberId)
    if (m) return { membershipId: m.id, userId: m.userId, fullName: m.fullName ?? '', role: m.memberRole }
  }
  return null
}

const cut = (params: unknown, key: string): number | null => {
  const v = typeof params === 'object' && params !== null ? (params as Record<string, unknown>)[key] : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Balance del embotellado con los datos guardados (fuentes ya embotelladas incluidas). */
export function bottlingInputOf(state: TraceState, lot: Lot, b: BottlingBatchResponse): { input: BottlingBalanceInput | null; sources: (WineAgingResponse | ProductionBatchResponse)[] } {
  const aging = lotAgings(state, lot.id).filter((a) => a.agingStatus === 'BOTTLED' || a.id === b.wineAgingBatchId)
  const productions = lotProductions(state, lot.id).filter((p) => p.restStatus === 'BOTTLED' || p.id === b.productionBatchId)
  const sources = [...aging, ...productions]
  const liters = [...aging.map((a) => a.volumeLiters ?? null), ...productions.map((p) => distillationHeart(p).liters)]
  if (sources.length === 0 || liters.some((l) => l === null)) return { input: null, sources }
  const hearts = productions.map(distillationHeart)
  const pure = aging.length === 0 && hearts.every((h) => h.abv !== null) ? hearts.reduce((s, h) => s + ((h.liters as number) * (h.abv as number)) / 100, 0) : null
  return {
    sources,
    input: {
      productType: (lot.productType ?? (aging.length > 0 ? 'WINE' : 'SINGANI')) as LotProductType,
      availableLiters: b.balance?.availableLiters ?? (liters as number[]).reduce((s, l) => s + l, 0),
      waterDilutionLiters: b.waterDilutionLiters ?? 0,
      bottles: b.totalBottlesPackaged,
      formatCl: b.packagingFormatCl,
      leftoverLiters: b.leftover?.liters ?? 0,
      maxLossPercent: lot.rules.bottling.maxLossPercent,
      finalAbv: b.finalAlcoholAbv,
      pureAlcoholAvailableLiters: pure,
    },
  }
}

/**
 * Revisión de integridad de un lote con las reglas de la ola y su instantánea (§2.6.8): D.O. del
 * lote singani, dictamen de la uva en tanques, candado a la fecha del embotellado, balance de
 * volumen y alcohol, agua en vino, volumen de las fuentes, salidas de un tanque por encima de su
 * volumen y fuentes abiertas en un lote embotellado. La usan la migración y las correcciones.
 */
export function reviewLot(state: TraceState, ctx: Pick<TraceCtx, 'now'>, lot: Lot): IntegrityIssue[] {
  const out: IntegrityIssue[] = []
  const harvests = lotHarvests(state, lot.id)
  const tanks = lotTanks(state, lot.id)

  if (lot.productType === 'SINGANI' && harvests.length > 0) {
    const terroirs = harvests.map((h) => harvestTerroir(state, h))
    const evaluation = evaluateDo(terroirs, doRulesFromLot(lot.rules), 'LOT_SNAPSHOT', ctx.now)
    if (evaluation.status === 'NOT_ELIGIBLE') {
      out.push({
        code: 'TRC_DO_NOT_ELIGIBLE',
        message: 'El lote singani no cumple la D.O. con las reglas de la instantánea',
        details: doViolations(evaluation, 'TRC_DO_NOT_ELIGIBLE', Object.fromEntries(terroirs.map((t) => [t.id, t.parcelName])), (terroirId) => ({
          harvestBatches: harvests.filter((h) => h.terroirId === terroirId).map((h) => ({ id: h.id, code: h.harvestBatchCode })),
        })),
      })
    }
  }

  // Dictamen: uva en un tanque sin el estado exigido (R4, S-2)
  const allowed = lot.rules.phytosanitary.requireApproved ? ['APPROVED'] : ['APPROVED', 'PENDING_INSPECTION']
  for (const h of harvests) {
    const inTanks = tanks.filter((t) => (t.inputs ?? []).some((i) => i.harvestBatchId === h.id))
    if (inTanks.length === 0 || allowed.includes(h.phytosanitaryStatus)) continue
    out.push({
      code: 'TRC_PHYTO_NOT_APPROVED',
      message: `Uva con dictamen ${h.phytosanitaryStatus} en ${inTanks.length === 1 ? 'un tanque' : `${inTanks.length} tanques`}`,
      details: [
        violation('TRC_PHYTO_NOT_APPROVED', `El pesaje ${h.harvestBatchCode} está en ${h.phytosanitaryStatus}`, {
          rule: LOT_RULE_KEYS.requireApproved,
          expected: allowed,
          actual: h.phytosanitaryStatus,
          meta: { harvestBatchId: h.id, harvestBatchCode: h.harvestBatchCode, status: h.phytosanitaryStatus, tankIds: inTanks.map((t) => t.id) },
        }),
      ],
    })
  }

  // Volumen: lo que sale de cada tanque no puede superar lo que tiene
  for (const tank of tanks) {
    const liters = tankLiters(tank)
    const drawn =
      state.wineAgings.filter((a) => a.fermentationTankId === tank.id).reduce((s, a) => s + (a.volumeLiters ?? 0), 0) +
      state.productionBatches.filter((p) => p.fermentationTankId === tank.id).reduce((s, p) => s + (p.inputVolumeLiters ?? 0), 0)
    if (liters !== null && drawn > liters + 1e-6) {
      out.push({
        code: 'TRC_VOLUME_EXCEEDS_AVAILABLE',
        message: `Del tanque ${tank.tankCode} salieron ${formatQuantity(drawn, 3)} L y solo tenía ${formatQuantity(liters, 3)} L`,
        details: [
          violation('TRC_VOLUME_EXCEEDS_AVAILABLE', `Salidas del tanque ${tank.tankCode} por encima de su volumen`, {
            expected: liters,
            actual: drawn,
            meta: { tankId: tank.id, available: liters, requested: drawn, unit: 'L' },
          }),
        ],
      })
    }
  }

  // Cortes de las destilaciones cerradas
  for (const p of lotProductions(state, lot.id)) {
    if (!p.processEndDate || p.inputVolumeLiters === null || p.inputVolumeLiters === undefined) continue
    const total = (p.headsLiters ?? 0) + (p.heartLiters ?? p.outputVolumeLiters ?? 0) + (p.tailsLiters ?? 0) + (p.vinasseLiters ?? 0)
    if (total > p.inputVolumeLiters + 1e-6) {
      out.push({
        code: 'TRC_MASS_BALANCE_EXCEEDED',
        message: `Los cortes de la destilación suman ${formatQuantity(total, 3)} L y la entrada fue de ${formatQuantity(p.inputVolumeLiters, 3)} L`,
        details: [violation('TRC_MASS_BALANCE_EXCEEDED', 'Cortes mayores que la entrada', { expected: p.inputVolumeLiters, actual: total, meta: { inputLiters: p.inputVolumeLiters, outputLiters: total, sourceId: p.id } })],
      })
    }
  }

  const bottling = lotBottling(state, lot.id)
  if (bottling) {
    const bottlingDay = dayOf(bottling.bottlingDate)
    const { input, sources } = bottlingInputOf(state, lot, bottling)
    // Candado: con la fecha del embotellado (el reloj de entonces no se conoce)
    for (const s of sources) {
      const lock =
        'agingStatus' in s
          ? agingLock({ id: s.id, startDate: agingStartDay(s), plannedMonths: s.plannedMonths, storedUnlockDate: dayOf(s.lockUntilDate) }, lot.rules, bottlingDay)
          : restLock({ id: s.id, processEndDate: s.processEndDate ? dayOf(s.processEndDate) : null, storedUnlockDate: null }, lot.rules, bottlingDay)
      if (!lock) {
        out.push({
          code: 'TRC_BOTTLING_SOURCE_INVALID',
          message: 'Se embotelló una destilación sin fecha de cierre',
          details: [violation('TRC_BOTTLING_SOURCE_INVALID', 'Destilación sin cerrar embotellada', { meta: { sourceId: s.id } })],
        })
      } else if (!lock.released) {
        out.push({
          code: 'TRC_LOCK_NOT_RELEASED',
          message: `Se embotelló el ${bottlingDay}, antes del fin del candado (${lock.unlockDate})`,
          details: [
            violation('TRC_LOCK_NOT_RELEASED', `Embotellado ${lock.daysRemaining} días antes del fin del candado`, {
              field: 'bottlingDate',
              rule: lock.rule.settingKey,
              expected: lock.unlockDate,
              actual: bottlingDay,
              meta: { sourceId: lock.sourceId, kind: lock.kind, unlockDate: lock.unlockDate, daysRemaining: lock.daysRemaining },
            }),
          ],
        })
      }
    }
    if (!input) {
      out.push({
        code: 'TRC_VOLUME_MISSING',
        message: 'La fuente del embotellado no tiene volumen registrado: no se puede verificar el balance',
        details: [violation('TRC_VOLUME_MISSING', 'Volumen de la fuente sin registrar', { field: 'volumeLiters', meta: { sourceIds: sources.map((s) => s.id) } })],
      })
    } else {
      for (const v of bottlingBalanceViolations(input, computeBottlingBalance(input))) out.push({ code: v.code as string, message: v.message, details: [v] })
    }
    // Fuentes abiertas en un lote ya embotellado (§6.2.3)
    const open = [...lotAgings(state, lot.id).filter(isAgingOpen).map((a) => a.id), ...lotProductions(state, lot.id).filter(isProductionOpen).map((p) => p.id)]
    if (open.length > 0) {
      out.push({
        code: 'TRC_BOTTLING_SOURCES_PENDING',
        message: 'El lote está embotellado y tiene fuentes abiertas que no entraron en el embotellado',
        details: [violation('TRC_BOTTLING_SOURCES_PENDING', 'Fuentes abiertas sin embotellar ni descartar', { meta: { sourceIds: open } })],
      })
    }
  }
  return out
}

export interface BackfillResult {
  harvestBatchId: string
  lotId: string | null
  skipped: 'ALREADY_ASSIGNED' | 'NOT_FOUND' | null
  issues: string[]
  bottleCodes: number
}

/**
 * Relleno de un pesaje anterior a la Ola 2: crea su lote (uno por pesaje, como `LotView`) y le
 * cuelga la cadena. Idempotente: un pesaje que ya tiene lote no se toca. `ctx.now` es el momento
 * de la migración (el de la instantánea `MIGRATION`).
 */
export function backfillHarvest(state: TraceState, ctx: TraceCtx, harvestBatchId: string): BackfillResult {
  const result: BackfillResult = { harvestBatchId, lotId: null, skipped: null, issues: [], bottleCodes: 0 }
  const harvest = state.harvestBatches.find((h) => h.id === harvestBatchId)
  if (!harvest) return { ...result, skipped: 'NOT_FOUND' }
  if (harvest.lotId) return { ...result, skipped: 'ALREADY_ASSIGNED', lotId: harvest.lotId }
  const terroir = state.terroirs.find((t) => t.id === harvest.terroirId)
  const tanks = state.tanks.filter((t) => t.harvestBatchId === harvest.id).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
  const tankIds = new Set(tanks.map((t) => t.id))
  const agings = state.wineAgings.filter((a) => tankIds.has(a.fermentationTankId))
  const productions = state.productionBatches.filter((p) => tankIds.has(p.fermentationTankId)).sort((a, b) => a.processStartDate.localeCompare(b.processStartDate))
  const sourceIds = new Set([...agings.map((a) => a.id), ...productions.map((p) => p.id)])
  const bottlings = state.bottlings
    .filter((b) => (b.wineAgingBatchId && sourceIds.has(b.wineAgingBatchId)) || (b.productionBatchId && sourceIds.has(b.productionBatchId)))
    .sort((a, b) => a.bottlingDate.localeCompare(b.bottlingDate) || a.id.localeCompare(b.id))

  // Tipo derivado (§2.6.2): destilación o tanque a singani → SINGANI; crianza o tanque a vino → WINE.
  let productType: LotProductType | null = null
  if (productions.length > 0 || tanks.some((t) => t.destinationType === 'SINGANI_DIST')) productType = 'SINGANI'
  else if (agings.length > 0 || tanks.some((t) => t.destinationType === 'WINE_AGING')) productType = 'WINE'

  const bottled = bottlings[0] ?? null
  const name = bottled ? bottled.internationalLotCode : `${terroir?.varietyName ?? 'Uva'} ${harvest.harvestYear}`
  const system: TraceCtx = { ...ctx, actor: null }
  const lot = createLot(state, system, harvest.wineryId, { name: name.slice(0, 120), harvestYear: harvest.harvestYear, productType }, {
    id: migratedLotId(harvest.id),
    origin: 'MIGRATION',
    createdAt: harvest.createdAt,
    summary: `Lote migrado desde el pesaje ${harvest.harvestBatchCode} (reglas fijadas al migrar)`,
  })
  result.lotId = lot.id
  if (bottled) lot.lotCode = bottled.internationalLotCode

  // Pesaje: lote, parcela tal como está hoy, análisis y dictamen
  harvest.lotId = lot.id
  harvest.terroirSnapshot = {
    parcelName: terroir?.parcelName ?? '',
    altitudeMasl: terroir?.altitudeMasl ?? 0,
    varietyName: terroir?.varietyName ?? '',
    rawMaterialType: terroir?.rawMaterialType ?? '',
    takenAt: ctx.now,
  }
  appendLotEvent(state, system, lot, {
    type: 'HARVEST_WEIGHED',
    occurredAt: harvest.intakeDate,
    recordedAt: harvest.createdAt,
    stage: 'HARVEST',
    summary: `Pesaje de ${formatQuantity(harvest.netWeightKg, 3)} kg desde ${terroir?.parcelName ?? 'la parcela'}`,
    data: { netWeightKg: harvest.netWeightKg, unit: 'kg', harvestBatchCode: harvest.harvestBatchCode },
    resource: { type: 'harvest_batch', id: harvest.id },
  })
  const { brixDegrees: brix, initialPh: ph, initialAcidityGl: acidity } = harvest
  // 0/0/0 en los datos anteriores = sin análisis (un pH 0 es imposible).
  if (brix !== null && ph !== null && acidity !== null && (brix > 0 || ph > 0 || acidity > 0)) {
    const analysis: MaturityAnalysis = {
      id: uid(`maturity-analysis:${harvest.id}`),
      harvestBatchId: harvest.id,
      brixDegrees: brix,
      ph,
      acidityGl: acidity,
      measuredAt: harvest.intakeDate,
      recordedAt: harvest.createdAt,
      recordedBy: null,
      notes: null,
      source: 'MIGRATION',
    }
    state.maturityAnalyses.push(analysis)
    appendLotEvent(state, system, lot, {
      type: 'MATURITY_ANALYZED',
      occurredAt: harvest.intakeDate,
      recordedAt: harvest.createdAt,
      stage: 'HARVEST',
      summary: `Análisis de madurez: ${brix} °Bx, pH ${ph}, acidez ${acidity} g/L`,
      data: { brixDegrees: brix, ph, acidityGl: acidity, harvestBatchCode: harvest.harvestBatchCode },
      resource: { type: 'maturity_analysis', id: analysis.id },
    })
  } else {
    harvest.brixDegrees = null
    harvest.initialPh = null
    harvest.initialAcidityGl = null
  }
  if (harvest.phytosanitaryStatus !== 'PENDING_INSPECTION') {
    const author = actorOfMember(state, harvest.certifiedByMemberId)
    const decision: PhytoDecision = {
      id: uid(`phyto-decision:${harvest.id}`),
      harvestBatchId: harvest.id,
      decision: harvest.phytosanitaryStatus,
      decidedAt: harvest.createdAt,
      recordedAt: harvest.createdAt,
      decidedBy: author,
      inspectionReport: harvest.phytoInspectionPdfUrl ? { key: harvest.phytoInspectionPdfUrl, sha256: null, url: harvest.phytoInspectionPdfUrl } : null,
      notes: null,
      source: 'MIGRATION',
    }
    state.phytoDecisions.push(decision)
    appendLotEvent(state, system, lot, {
      type: 'PHYTO_DECIDED',
      occurredAt: harvest.createdAt,
      recordedAt: harvest.createdAt,
      stage: 'HARVEST',
      actor: author,
      summary: `Dictamen fitosanitario: ${harvest.phytosanitaryStatus}`,
      data: { decision: harvest.phytosanitaryStatus, source: 'MIGRATION', harvestBatchCode: harvest.harvestBatchCode },
      resource: { type: 'phyto_decision', id: decision.id },
    })
  }

  // Tanques: lote y entradas (kilos repartidos por volumen llenado, para no contarlos dos veces)
  const filled = tanks.map((t) => t.volumeFilledLiters ?? 0)
  const totalFilled = filled.reduce((a, b) => a + b, 0)
  let assigned = 0
  tanks.forEach((tank, i) => {
    const last = i === tanks.length - 1
    const share = totalFilled > 0 ? (harvest.netWeightKg * (filled[i] as number)) / totalFilled : harvest.netWeightKg / tanks.length
    const kg = last ? harvest.netWeightKg - assigned : Math.round(share * 1000) / 1000
    assigned += kg
    tank.lotId = lot.id
    tank.finalVolumeLiters ??= null
    tank.inputs = [{ harvestBatchId: harvest.id, kg: Math.max(0, Math.round(kg * 1000) / 1000) }]
    const resource = { type: 'fermentation_tank', id: tank.id }
    appendLotEvent(state, system, lot, {
      type: 'TANK_FILLED',
      occurredAt: tank.startDate,
      recordedAt: tank.createdAt,
      stage: 'FERMENTING',
      summary: `Tanque ${tank.tankCode} lleno con ${formatQuantity(tank.volumeFilledLiters ?? 0, 2)} L`,
      data: { tankCode: tank.tankCode, volumeFilledLiters: tank.volumeFilledLiters ?? null, unit: 'L' },
      resource,
    })
    if (tank.endDate) {
      appendLotEvent(state, system, lot, {
        type: 'FERMENTATION_COMPLETED',
        occurredAt: tank.endDate,
        recordedAt: tank.createdAt,
        stage: 'FERMENTING',
        summary: `Fermentación completada en ${tank.tankCode}`,
        data: { tankCode: tank.tankCode, destinationType: tank.destinationType ?? null },
        resource,
      })
    }
  })

  // Crianzas y destilaciones
  for (const aging of agings) {
    aging.lotId = lot.id
    aging.startDate ??= laPazDate(aging.createdAt)
    aging.containerCount ??= null
    appendLotEvent(state, system, lot, {
      type: 'AGING_STARTED',
      occurredAt: toDateField(agingStartDay(aging)),
      recordedAt: aging.createdAt,
      stage: 'AGING',
      summary: `Crianza en ${aging.containerType} por ${aging.plannedMonths} meses`,
      data: { plannedMonths: aging.plannedMonths, volumeLiters: aging.volumeLiters ?? null, unit: 'L' },
      resource: { type: 'wine_aging_batch', id: aging.id },
    })
  }
  for (const p of productions) {
    p.lotId = lot.id
    const closed = Boolean(p.processEndDate)
    p.headsLiters = closed ? cut(p.additionalParams, 'headDiscardLiters') : null
    p.heartLiters = closed ? (cut(p.additionalParams, 'heartYieldLiters') ?? p.outputVolumeLiters ?? null) : null
    p.tailsLiters = closed ? cut(p.additionalParams, 'tailDiscardLiters') : null
    p.vinasseLiters = null
    p.heartAbvPercent = closed ? (p.initialAlcoholPercentage ?? null) : null
    const resource = { type: 'production_batch', id: p.id }
    appendLotEvent(state, system, lot, {
      type: 'DISTILLATION_STARTED',
      occurredAt: p.processStartDate,
      recordedAt: p.createdAt,
      stage: 'DISTILLING',
      summary: `Destilación en ${p.equipmentIdentifier} de ${formatQuantity(p.inputVolumeLiters ?? 0, 3)} L`,
      data: { inputVolumeLiters: p.inputVolumeLiters ?? null, unit: 'L' },
      resource,
    })
    if (p.processEndDate) {
      const heart = distillationHeart(p)
      appendLotEvent(state, system, lot, {
        type: 'DISTILLATION_CLOSED',
        occurredAt: p.processEndDate,
        recordedAt: p.createdAt,
        stage: 'RESTING',
        summary: `Destilación cerrada: corazón de ${formatQuantity(heart.liters ?? 0, 3)} L al ${heart.abv ?? '—'} %`,
        data: { heartLiters: heart.liters, heartAbvPercent: heart.abv, unit: 'L' },
        resource,
      })
    }
  }

  const issues: IntegrityIssue[] = []
  // Embotellado, códigos de botella y laboratorio
  bottlings.forEach((b, index) => {
    if (index > 0) {
      // Un embotellado por lote (S-10): los demás quedan sin lote y como incidencia.
      issues.push({
        code: 'TRC_LOT_ALREADY_BOTTLED',
        message: `El lote tiene un segundo embotellado (${b.internationalLotCode}) anterior a la Ola 2`,
        details: [violation('TRC_LOT_ALREADY_BOTTLED', `Embotellado adicional ${b.internationalLotCode}`, { meta: { bottlingBatchId: b.id, lotCode: b.internationalLotCode } })],
      })
      return
    }
    b.lotId = lot.id
    b.qrBatchUrl = passportUrl(ctx.passportBaseUrl, b.internationalLotCode)
    const releasedBy = actorOfMember(state, b.releasedByMemberId)
    const resource = { type: 'bottling_batch', id: b.id }
    appendLotEvent(state, system, lot, {
      type: 'BOTTLED',
      occurredAt: b.bottlingDate,
      recordedAt: b.createdAt,
      stage: 'BOTTLED',
      actor: releasedBy,
      summary: `Embotellado de ${formatQuantity(b.totalBottlesPackaged)} botellas de ${b.packagingFormatCl} cL (${b.internationalLotCode})`,
      data: { lotCode: b.internationalLotCode, bottles: b.totalBottlesPackaged, formatCl: b.packagingFormatCl, finalAlcoholAbv: b.finalAlcoholAbv },
      resource,
    })
    if (!bottleLotOf(state, lot.id)) {
      allocateBottleLot(state, lot.id, b.id, b.totalBottlesPackaged)
      result.bottleCodes = b.totalBottlesPackaged
      appendLotEvent(state, system, lot, {
        type: 'BOTTLE_CODES_GENERATED',
        occurredAt: ctx.now,
        stage: 'BOTTLED',
        summary: `${formatQuantity(b.totalBottlesPackaged)} códigos de botella generados al migrar`,
        data: { count: b.totalBottlesPackaged },
        resource,
      })
    }
    // Laboratorio: se recalcula la conformidad (§2.6.6); el valor guardado queda como histórico.
    const labs = state.labAnalyses.filter((l) => l.bottlingBatchId === b.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    labs.forEach((lab, i) => {
      const abv = lab.actualAlcoholAbv
      const methanolAa = lab.methanolMg100mlAa ?? (lab.methanolContentMgL !== null && lab.methanolContentMgL !== undefined ? methanolToAnhydrous(lab.methanolContentMgL, abv) : null)
      const conformity = computeLabConformity({
        productType,
        values: { actualAlcoholAbv: abv, volatileAcidityAceticGl: lab.volatileAcidityAceticGl, methanolMg100mlAa: methanolAa, copperContentMgL: lab.copperContentMgL ?? null },
        limits: lot.rules.lab.limits,
        labeledAbv: b.finalAlcoholAbv,
        rulesTakenAt: lot.rules.takenAt,
      })
      const reviewer = actorOfMember(state, lab.reviewedByMemberId)
      lab.lotId = lot.id
      lab.methanolMg100mlAa = methanolAa
      lab.conformity = conformity
      lab.conformityStatus = conformity.status
      lab.conformsToSenasagStandards = conformity.status === 'CONFORMING'
      lab.supersededAt = lab.supersededAt ?? (i < labs.length - 1 ? (labs[i + 1] as (typeof labs)[number]).createdAt : null)
      lab.recordedBy = reviewer
      lab.report = { key: lab.laboratoryReportPdfUrl, sha256: null, url: lab.laboratoryReportPdfUrl }
      appendLotEvent(state, system, lot, {
        type: 'LAB_REGISTERED',
        occurredAt: lab.testPerformedAt,
        recordedAt: lab.createdAt,
        stage: 'BOTTLED',
        actor: reviewer,
        summary: `Análisis de laboratorio de ${lab.certifiedLaboratoryName}: ${LAB_STATUS_LABELS[conformity.status]}`,
        data: { conformity: conformity.status, laboratory: lab.certifiedLaboratoryName },
        resource: { type: 'lab_analysis', id: lab.id },
      })
    })
    const { input } = bottlingInputOf(state, lot, b)
    if (input) b.balance = computeBottlingBalance(input)
    b.leftover ??= null
    b.labelDesign ??= b.labelDesignUrl ? { key: b.labelDesignUrl, url: b.labelDesignUrl } : null
  })

  const latest = [harvest.intakeDate, ...tanks.map((t) => t.endDate ?? t.startDate), ...agings.map((a) => a.createdAt), ...productions.map((p) => p.processEndDate ?? p.processStartDate), ...(bottled ? [bottled.bottlingDate] : [])]
    .sort()
    .at(-1) as string
  refreshLotStage(state, system, lot, latest)
  issues.push(...reviewLot(state, ctx, lot))
  for (const issue of issues) {
    addComplianceIssue(ctx, lot, { ...issue, source: 'MIGRATION' })
    result.issues.push(issue.code)
  }
  return result
}

/** Migra todos los pesajes sin lote que ya tienen cadena o dictamen (los datos anteriores a la Ola 2). */
export function backfillAll(state: TraceState, ctx: TraceCtx): BackfillResult[] {
  return state.harvestBatches.filter((h) => !h.lotId).map((h) => backfillHarvest(state, ctx, h.id))
}
