import type { ApiErrorDetail } from '../../shared/envelope'
import { ApiError } from '../handlers/errors'
import type {
  CloseDistillationDto,
  CompleteFermentationTankDto,
  CreateDistillationBatchDto,
  CreateEnologicalTreatmentDto,
  CreateFermentationLogDto,
  CreateFermentationTankDto,
  CreateHarvestBatchDto,
  CreateMaturityAnalysisDto,
  CreateWineAgingBatchDto,
  FermentationTankResponse,
  HarvestBatchResponse,
  Lot,
  LotProductType,
  MaturityAnalysis,
  PhytoDecision,
  PhytoDecisionValue,
  ProductionBatchResponse,
  RestStatusResponse,
  TerroirResponse,
  WineAgingResponse,
} from '../schemas'
import { addDaysYmd, addMonthsYmd, dayOf, daysBetween, laPazDate, toDateField } from './dates'
import { DESTINATION_OF_PRODUCT, doRulesFromLot, doViolations, evaluateDo, productTypeOfDestination } from './domain'
import { buildLotRules, formatQuantity, LOT_RULE_KEYS, violation } from './rules'
import {
  appendLotEvent,
  assertLotWritable,
  assertNotBefore,
  assertNotFuture,
  assertStage,
  createLot,
  distillationHeart,
  findLot,
  harvestAvailableKg,
  harvestInTank,
  harvestTerroir,
  isVoided,
  lotHarvests,
  lotProductions,
  nextHarvestCode,
  parseProductType,
  recordTankTransition,
  fileSha256,
  refreshLotStage,
  releaseLocks,
  restLockOf,
  ruleError,
  stateError,
  tankAvailableLiters,
  type StoredLog,
  type StoredTreatment,
  type TraceCtx,
  type TraceState,
} from './state'

// Registros de la cadena con las reglas de la Ola 2 (contrato §3–§5): pesaje, análisis de madurez,
// dictamen, tanques y sus transiciones, lecturas, tratamientos, crianza, destilación y reposo.
// Todas las rutas pasan por aquí: las reglas no dependen de por dónde se entre.

const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message)
const invalidField = (field: string, message: string) => new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', [{ field, message }])

/** Instante de un hecho declarado: una fecha sin hora se guarda a medianoche UTC. */
const toInstant = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? toDateField(value) : new Date(Date.parse(value)).toISOString().replace(/\.\d{3}Z$/, 'Z'))

/** Instante no futuro, con 5 min de tolerancia (contrato §0). */
function assertInstantNotFuture(ctx: TraceCtx, field: string, value: string): void {
  const day = dayOf(value)
  if (day > ctx.today || (day === ctx.today && !/T00:00:00/.test(toInstant(value)) && Date.parse(value) > Date.parse(ctx.now) + 5 * 60_000)) {
    throw ruleError('TRC_DATE_IN_FUTURE', 'La fecha no puede ser futura', [violation('TRC_DATE_IN_FUTURE', 'Fecha futura', { field, expected: ctx.today, actual: day })])
  }
}

/** El archivo existe y es de la bodega: las claves privadas son `org/<organización>/…` (§0). */
export function assertOwnFile(wineryId: string, field: string, key: string): void {
  if (key.startsWith(`org/${wineryId}/`) && !key.includes('..')) return
  throw ruleError('TRC_FILE_NOT_FOUND', 'El archivo no existe o es de otra organización', [
    violation('TRC_FILE_NOT_FOUND', 'Archivo no encontrado en esta bodega', { field, meta: { field } }),
  ])
}

// ---------------------------------------------------------------------------
// Destino, tipo de producto y D.O. del lote (§4.3)
// ---------------------------------------------------------------------------

/** Coherencia del destino con el tipo del lote: `WINE ↔ WINE_AGING`, `SINGANI ↔ SINGANI_DIST`. */
export function assertDestination(lot: Lot, destination: string | null | undefined, field = 'destinationType'): LotProductType | null {
  if (destination === null || destination === undefined) return null
  const product = productTypeOfDestination(destination)
  if (!product) {
    throw ruleError('TRC_PRODUCT_NOT_SUPPORTED', `El lote solo admite vino o singani: destino ${destination} no admitido`, [
      violation('TRC_PRODUCT_NOT_SUPPORTED', 'Destino fuera del MVP', { field, expected: ['WINE_AGING', 'SINGANI_DIST'], actual: destination }),
    ])
  }
  if (lot.productType && lot.productType !== product) {
    throw ruleError('TRC_DESTINATION_MISMATCH', `El lote es ${lot.productType}: su destino es ${DESTINATION_OF_PRODUCT[lot.productType]}`, [
      violation('TRC_DESTINATION_MISMATCH', 'Destino incoherente con el tipo del lote', { field, expected: DESTINATION_OF_PRODUCT[lot.productType], actual: destination }),
    ])
  }
  return product
}

/** D.O. del lote singani con su instantánea, sobre **todos** sus pesajes (EA-03): 422 `TRC_DO_NOT_ELIGIBLE`. */
export function assertLotDo(state: TraceState, ctx: TraceCtx, lot: Lot): void {
  const harvests = lotHarvests(state, lot.id)
  if (harvests.length === 0) return
  const terroirs = harvests.map((h) => harvestTerroir(state, h))
  const evaluation = evaluateDo(terroirs, doRulesFromLot(lot.rules), 'LOT_SNAPSHOT', ctx.now)
  if (evaluation.status !== 'NOT_ELIGIBLE') return
  const names = Object.fromEntries(terroirs.map((t) => [t.id, t.parcelName]))
  throw ruleError(
    'TRC_DO_NOT_ELIGIBLE',
    'El lote no cumple la D.O. Singani con las reglas de su instantánea',
    doViolations(evaluation, 'TRC_DO_NOT_ELIGIBLE', names, (terroirId) => ({
      harvestBatches: harvests.filter((h) => h.terroirId === terroirId).map((h) => ({ id: h.id, code: h.harvestBatchCode })),
    })),
  )
}

/** Fija el tipo del lote en la primera bifurcación (evento `PRODUCT_DECIDED`); después no cambia (S-8). */
export function decideProductType(state: TraceState, ctx: TraceCtx, lot: Lot, product: LotProductType, at: string, resource: { type: string; id: string }): void {
  if (lot.productType) return
  lot.productType = product
  appendLotEvent(state, ctx, lot, {
    type: 'PRODUCT_DECIDED',
    occurredAt: at,
    summary: `El lote será ${product === 'WINE' ? 'vino' : 'singani'}`,
    data: { productType: product },
    resource,
  })
}

// ---------------------------------------------------------------------------
// Vendimia: pesaje, análisis de madurez y dictamen (§3)
// ---------------------------------------------------------------------------

export const findHarvestIn = (state: TraceState, id: string, wineryId: string | null): HarvestBatchResponse => {
  const h = state.harvestBatches.find((x) => x.id === id)
  if (!h || (wineryId && h.wineryId !== wineryId)) throw notFound(`Lote de vendimia con identificador "${id}" no encontrado`)
  return h
}

/** Análisis de madurez vigentes de un pesaje (sin los anulados), por fecha de medición. */
export const harvestAnalyses = (state: TraceState, harvestId: string): MaturityAnalysis[] =>
  state.maturityAnalyses
    .filter((m) => m.harvestBatchId === harvestId && !isVoided(state, 'MATURITY_ANALYSIS', m.id))
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.recordedAt.localeCompare(b.recordedAt))

/** Dictámenes vigentes de un pesaje (sin los anulados), en orden de registro. */
export const harvestDecisions = (state: TraceState, harvestId: string): PhytoDecision[] =>
  state.phytoDecisions.filter((d) => d.harvestBatchId === harvestId && !isVoided(state, 'PHYTO_DECISION', d.id)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))

/** Todos los análisis de madurez de un pesaje, también los anulados (las vistas los devuelven marcados). */
export const allHarvestAnalyses = (state: TraceState, harvestId: string): MaturityAnalysis[] =>
  state.maturityAnalyses.filter((m) => m.harvestBatchId === harvestId).sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.recordedAt.localeCompare(b.recordedAt))

/** Todos los dictámenes de un pesaje, también los anulados. */
export const allHarvestDecisions = (state: TraceState, harvestId: string): PhytoDecision[] =>
  state.phytoDecisions.filter((d) => d.harvestBatchId === harvestId).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))

/** El pesaje refleja su último análisis (Brix, pH, acidez) y su último dictamen. */
export function syncHarvest(state: TraceState, h: HarvestBatchResponse): void {
  const analysis = harvestAnalyses(state, h.id).at(-1)
  h.brixDegrees = analysis?.brixDegrees ?? null
  h.initialPh = analysis?.ph ?? null
  h.initialAcidityGl = analysis?.acidityGl ?? null
  const decision = harvestDecisions(state, h.id).at(-1)
  h.phytosanitaryStatus = decision?.decision ?? 'PENDING_INSPECTION'
  h.certifiedByMemberId = decision?.decidedBy?.membershipId ?? null
}

/** Lote abierto de un pesaje (o `null` si es uva recibida sin lote); terminal → 409 `TRC_LOT_TERMINAL`. */
function writableLotOf(state: TraceState, lotId: string | null): Lot | null {
  if (!lotId) return null
  const lot = state.lots.find((l) => l.id === lotId) ?? null
  if (lot) assertLotWritable(lot)
  return lot
}

function doTerroirCheck(ctx: TraceCtx, rules: Lot['rules'], terroir: TerroirResponse, field: string): void {
  const evaluation = evaluateDo([{ id: terroir.id, altitudeMasl: terroir.altitudeMasl, varietyName: terroir.varietyName }], doRulesFromLot(rules), 'LOT_SNAPSHOT', ctx.now)
  if (evaluation.status !== 'NOT_ELIGIBLE') return
  throw ruleError(
    'TRC_DO_TERROIR_NOT_ELIGIBLE',
    `La parcela ${terroir.parcelName} no es apta para la D.O. Singani con las reglas del lote`,
    doViolations(evaluation, 'TRC_DO_TERROIR_NOT_ELIGIBLE', { [terroir.id]: terroir.parcelName }).map((d) => ({ ...d, field })),
  )
}

/** Pesaje (§3.2): con lote, con lote nuevo (`newLot`) o sin lote (uva recibida). El dictamen va aparte (EA-04). */
export function createHarvest(state: TraceState, ctx: TraceCtx, wineryId: string, body: CreateHarvestBatchDto): HarvestBatchResponse {
  if (body.grossWeightKg <= body.tareWeightKg) throw invalidField('grossWeightKg', 'El peso bruto debe ser estrictamente mayor al peso tara')
  const terroir = state.terroirs.find((t) => t.id === body.terroirId && t.wineryId === wineryId)
  if (!terroir) throw notFound('Parcela no encontrada en esta bodega')
  const intakeDay = dayOf(body.intakeDate)
  assertNotFuture(ctx, 'intakeDate', intakeDay)

  let lot: Lot | null = null
  if (body.lotId) {
    lot = findLot(state, body.lotId, wineryId, { writable: true })
    assertStage(lot, ['ORIGIN', 'HARVEST', 'FERMENTING'], 'pesajes')
  }
  const lotYear = lot?.harvestYear ?? body.newLot?.harvestYear
  const harvestYear = body.harvestYear ?? lotYear ?? Number(intakeDay.slice(0, 4))
  if (lotYear !== undefined && harvestYear !== lotYear) {
    throw ruleError('TRC_HARVEST_YEAR_MISMATCH', `El lote es de la añada ${lotYear}`, [
      violation('TRC_HARVEST_YEAR_MISMATCH', 'Pesaje de otra añada', { field: 'harvestYear', expected: lotYear, actual: harvestYear }),
    ])
  }
  // D.O. de la parcela con la instantánea del lote singani (la de un lote nuevo es la vigente).
  const productType = lot ? lot.productType : parseProductType(body.newLot?.productType, 'newLot.productType')
  if (productType === 'SINGANI') doTerroirCheck(ctx, lot?.rules ?? buildLotRules(ctx.snapshot(wineryId), 'LOT_CREATION'), terroir, 'terroirId')
  if (body.newLot) lot = createLot(state, ctx, wineryId, body.newLot, { field: 'newLot' })

  const maturity = body.maturity ?? null
  const intakeDate = toInstant(body.intakeDate)
  const harvest: HarvestBatchResponse = {
    id: ctx.newId('harvest'),
    wineryId,
    terroirId: terroir.id,
    harvestBatchCode: nextHarvestCode(state, wineryId, harvestYear, terroir.parcelName),
    intakeDate,
    harvestYear,
    grossWeightKg: body.grossWeightKg,
    tareWeightKg: body.tareWeightKg,
    netWeightKg: Math.round((body.grossWeightKg - body.tareWeightKg) * 1000) / 1000,
    brixDegrees: null,
    initialPh: null,
    initialAcidityGl: null,
    temperatureAtIntakeC: body.temperatureAtIntakeC ?? null,
    phytosanitaryStatus: 'PENDING_INSPECTION',
    phytoInspectionPdfUrl: null,
    certifiedByMemberId: null,
    notes: body.notes ?? null,
    createdAt: ctx.now,
    lotId: lot?.id ?? null,
    terroirSnapshot: {
      parcelName: terroir.parcelName,
      altitudeMasl: terroir.altitudeMasl,
      varietyName: terroir.varietyName,
      rawMaterialType: terroir.rawMaterialType,
      takenAt: ctx.now,
    },
  }
  state.harvestBatches.push(harvest)
  if (lot) {
    appendLotEvent(state, ctx, lot, {
      type: 'HARVEST_WEIGHED',
      occurredAt: intakeDate,
      summary: `Pesaje de ${formatQuantity(harvest.netWeightKg, 3)} kg desde ${terroir.parcelName}`,
      data: { netWeightKg: harvest.netWeightKg, unit: 'kg', harvestBatchCode: harvest.harvestBatchCode },
      resource: { type: 'harvest_batch', id: harvest.id },
    })
    refreshLotStage(state, ctx, lot)
  }
  if (maturity) addMaturityAnalysis(state, ctx, harvest, { ...maturity, measuredAt: maturity.measuredAt ?? body.intakeDate })
  return harvest
}

/** Análisis de madurez (§3.3): solo inserción; el último por fecha de medición es el vigente. */
export function addMaturityAnalysis(state: TraceState, ctx: TraceCtx, harvest: HarvestBatchResponse, body: CreateMaturityAnalysisDto): MaturityAnalysis {
  const lot = writableLotOf(state, harvest.lotId)
  assertInstantNotFuture(ctx, 'measuredAt', body.measuredAt)
  const analysis: MaturityAnalysis = {
    id: ctx.newId('maturity-analysis'),
    harvestBatchId: harvest.id,
    brixDegrees: body.brixDegrees,
    ph: body.ph,
    acidityGl: body.acidityGl,
    measuredAt: toInstant(body.measuredAt),
    recordedAt: ctx.now,
    recordedBy: ctx.actor,
    notes: body.notes ?? null,
    source: 'ERP',
  }
  state.maturityAnalyses.push(analysis)
  syncHarvest(state, harvest)
  if (lot) {
    appendLotEvent(state, ctx, lot, {
      type: 'MATURITY_ANALYZED',
      occurredAt: analysis.measuredAt,
      summary: `Análisis de madurez: ${body.brixDegrees} °Bx, pH ${body.ph}, acidez ${body.acidityGl} g/L`,
      data: { brixDegrees: body.brixDegrees, ph: body.ph, acidityGl: body.acidityGl, harvestBatchCode: harvest.harvestBatchCode },
      resource: { type: 'maturity_analysis', id: analysis.id },
    })
    refreshLotStage(state, ctx, lot)
  }
  return analysis
}

export interface PhytoDecisionInput {
  decision: PhytoDecisionValue
  inspectionReportKey?: string
  notes?: string | null
  decidedAt?: string
}

/**
 * Dictamen fitosanitario (§3.4, EA-04): solo inserción. `PENDING_INSPECTION → APPROVED | REJECTED |
 * QUARANTINE`; `QUARANTINE → …`; `APPROVED` y `REJECTED` son finales, y nada cambia con la uva ya
 * en un tanque → 409 `TRC_PHYTO_DECISION_FINAL`.
 */
export function decidePhyto(state: TraceState, ctx: TraceCtx, harvest: HarvestBatchResponse, input: PhytoDecisionInput): HarvestBatchResponse {
  const status = harvest.phytosanitaryStatus
  // Antes que el estado del lote: un dictamen final lo es aunque su lote ya esté rechazado.
  if (status === 'APPROVED' || status === 'REJECTED' || harvestInTank(state, harvest.id)) {
    const inTank = harvestInTank(state, harvest.id)
    throw stateError('TRC_PHYTO_DECISION_FINAL', inTank ? 'La uva ya entró a un tanque: su dictamen no cambia' : `El dictamen ${status} es final`, [
      violation('TRC_PHYTO_DECISION_FINAL', inTank ? 'Uva ya en un tanque' : 'Dictamen final', { field: 'decision', meta: { status, inTank } }),
    ])
  }
  const lot = writableLotOf(state, harvest.lotId)
  const notes = input.notes?.trim() || null
  if ((input.decision === 'REJECTED' || input.decision === 'QUARANTINE') && !notes) throw invalidField('notes', 'Indica el motivo del dictamen (obligatorio al rechazar o poner en cuarentena)')
  if (input.decidedAt) {
    assertInstantNotFuture(ctx, 'decidedAt', input.decidedAt)
    assertNotBefore('decidedAt', dayOf(input.decidedAt), dayOf(harvest.intakeDate))
  }
  if (input.inspectionReportKey) assertOwnFile(harvest.wineryId, 'inspectionReportKey', input.inspectionReportKey)
  const key = input.inspectionReportKey ?? null
  const decision: PhytoDecision = {
    id: ctx.newId('phyto-decision'),
    harvestBatchId: harvest.id,
    decision: input.decision,
    decidedAt: input.decidedAt ? toInstant(input.decidedAt) : ctx.now,
    recordedAt: ctx.now,
    decidedBy: ctx.actor,
    inspectionReport: key ? { key, sha256: fileSha256(key, state), url: null } : null,
    notes,
    source: 'ERP',
  }
  state.phytoDecisions.push(decision)
  syncHarvest(state, harvest)
  if (key) harvest.phytoInspectionPdfUrl = key
  if (lot) {
    appendLotEvent(state, ctx, lot, {
      type: 'PHYTO_DECIDED',
      occurredAt: decision.decidedAt,
      summary: `Dictamen fitosanitario de ${harvest.harvestBatchCode}: ${PHYTO_LABELS[input.decision]}`,
      data: { decision: input.decision, harvestBatchCode: harvest.harvestBatchCode, source: 'ERP' },
      resource: { type: 'phyto_decision', id: decision.id },
    })
    refreshLotStage(state, ctx, lot)
  }
  return harvest
}

const PHYTO_LABELS: Record<PhytoDecisionValue, string> = { APPROVED: 'aprobado', REJECTED: 'rechazado', QUARANTINE: 'en cuarentena' }

// ---------------------------------------------------------------------------
// Tanques (§4)
// ---------------------------------------------------------------------------

export const findTankIn = (state: TraceState, id: string, wineryId: string | null): FermentationTankResponse => {
  const t = state.tanks.find((x) => x.id === id)
  if (!t || (wineryId && t.wineryId !== wineryId)) throw notFound(`Cuba con identificador "${id}" no encontrada`)
  return t
}

/** Lote de un tanque (todo tanque tiene uno desde la Ola 2). */
function lotOfTank(state: TraceState, tank: FermentationTankResponse, writable = true): Lot {
  const lot = tank.lotId ? state.lots.find((l) => l.id === tank.lotId) : undefined
  if (!lot) throw notFound('El tanque no pertenece a ningún lote')
  if (writable) assertLotWritable(lot)
  return lot
}

/** Tanque lleno con pesajes de un mismo lote (§4.1). */
export function createTank(state: TraceState, ctx: TraceCtx, wineryId: string, body: CreateFermentationTankDto): FermentationTankResponse {
  const requested = body.inputs
  const harvests = requested.map((i) => findHarvestIn(state, i.harvestBatchId, wineryId))
  const startDay = dayOf(body.startDate)
  assertNotFuture(ctx, 'startDate', startDay)
  const lastIntake = harvests.map((h) => dayOf(h.intakeDate)).sort().at(-1) as string
  assertNotBefore('startDate', startDay, lastIntake)

  // Un tanque solo recibe uva de un lote (S-4).
  const lotIds = [...new Set([...(body.lotId ? [body.lotId] : []), ...harvests.map((h) => h.lotId).filter((id): id is string => Boolean(id))])]
  if (lotIds.length > 1 || (body.newLot && lotIds.length > 0)) {
    throw ruleError('TRC_MIXED_LOTS', 'Un tanque solo recibe uva de un lote', [
      violation('TRC_MIXED_LOTS', 'Entradas de lotes distintos', { field: 'inputs', meta: { lotIds } }),
    ])
  }
  let lot: Lot
  if (lotIds[0]) {
    lot = findLot(state, lotIds[0], wineryId, { writable: true })
  } else {
    // Uva sin lote: el lote nace del tanque (con `newLot` o, por compatibilidad con el ERP actual, solo).
    const first = harvests[0] as HarvestBatchResponse
    const terroir = harvestTerroir(state, first)
    lot = createLot(state, ctx, wineryId, body.newLot ?? { name: `${terroir.varietyName} ${first.harvestYear}`, harvestYear: first.harvestYear }, { field: 'newLot' })
  }
  assertStage(lot, ['ORIGIN', 'HARVEST', 'FERMENTING'], 'tanques nuevos')
  for (const h of harvests) {
    if (h.harvestYear !== lot.harvestYear) {
      throw ruleError('TRC_HARVEST_YEAR_MISMATCH', `El lote es de la añada ${lot.harvestYear}`, [
        violation('TRC_HARVEST_YEAR_MISMATCH', 'Pesaje de otra añada', { field: 'inputs', expected: lot.harvestYear, actual: h.harvestYear, meta: { harvestBatchId: h.id } }),
      ])
    }
  }

  // Dictamen exigido por la instantánea (R4): REJECTED y QUARANTINE nunca entran (S-2).
  const allowed = lot.rules.phytosanitary.requireApproved ? ['APPROVED'] : ['APPROVED', 'PENDING_INSPECTION']
  const phyto = harvests
    .filter((h) => !allowed.includes(h.phytosanitaryStatus))
    .map((h) =>
      violation('TRC_PHYTO_NOT_APPROVED', `El pesaje ${h.harvestBatchCode} está en ${h.phytosanitaryStatus}: no puede entrar a un tanque`, {
        field: 'inputs',
        rule: LOT_RULE_KEYS.requireApproved,
        expected: allowed,
        actual: h.phytosanitaryStatus,
        meta: { harvestBatchId: h.id, harvestBatchCode: h.harvestBatchCode, status: h.phytosanitaryStatus },
      }),
    )
  if (phyto.length > 0) throw ruleError('TRC_PHYTO_NOT_APPROVED', 'Uva sin dictamen fitosanitario aprobado', phyto)

  const inputs = harvests.map((h, i) => {
    const available = harvestAvailableKg(state, h)
    const kg = requested[i]?.kg ?? available
    if (kg > available + 1e-6 || available <= 0) {
      throw ruleError('TRC_VOLUME_EXCEEDS_AVAILABLE', `Del pesaje ${h.harvestBatchCode} quedan ${formatQuantity(available, 3)} kg`, [
        violation('TRC_VOLUME_EXCEEDS_AVAILABLE', 'Kilos por encima de lo disponible', {
          field: `inputs.${i}.kg`,
          expected: available,
          actual: kg,
          meta: { available, requested: kg, unit: 'kg', harvestBatchId: h.id },
        }),
      ])
    }
    return { harvestBatchId: h.id, kg }
  })
  if (body.capacityLiters !== undefined && body.volumeFilledLiters > body.capacityLiters) {
    throw ruleError('TRC_TANK_CAPACITY_EXCEEDED', `El tanque tiene ${formatQuantity(body.capacityLiters, 2)} L de capacidad`, [
      violation('TRC_TANK_CAPACITY_EXCEEDED', 'Llenado mayor que la capacidad', {
        field: 'volumeFilledLiters',
        expected: body.capacityLiters,
        actual: body.volumeFilledLiters,
        meta: { capacityLiters: body.capacityLiters },
      }),
    ])
  }
  const busy = state.tanks.find((t) => t.wineryId === wineryId && t.tankCode === body.tankCode && t.status !== 'CLEANED')
  if (busy) {
    throw stateError('TRC_TANK_CODE_IN_USE', `El tanque ${body.tankCode} está ocupado: límpialo antes de volver a llenarlo`, [
      violation('TRC_TANK_CODE_IN_USE', 'Tanque físico ocupado', { field: 'tankCode', meta: { tankId: busy.id, status: busy.status } }),
    ])
  }
  const product = assertDestination(lot, body.destinationType)

  const startDate = toInstant(body.startDate)
  const fermenting = body.startFermentation === true || body.status === 'FERMENTING'
  const tank: FermentationTankResponse = {
    id: ctx.newId('tank'),
    wineryId,
    harvestBatchId: (harvests[0] as HarvestBatchResponse).id,
    tankCode: body.tankCode,
    capacityLiters: body.capacityLiters ?? null,
    material: body.material ?? null,
    volumeFilledLiters: body.volumeFilledLiters,
    destinationType: body.destinationType ?? null,
    status: fermenting ? 'FERMENTING' : 'FILLING',
    startDate,
    endDate: null,
    createdAt: ctx.now,
    lotId: lot.id,
    finalVolumeLiters: null,
    inputs,
    // El historial empieza por el llenado; un tanque que nace fermentando no pasa por `start`.
    transitions: [{ status: fermenting ? 'FERMENTING' : 'FILLING', at: startDate, by: ctx.actor }],
  }
  for (const h of harvests) h.lotId = lot.id
  state.tanks.push(tank)
  const resource = { type: 'fermentation_tank', id: tank.id }
  if (product) {
    decideProductType(state, ctx, lot, product, startDate, resource)
    if (product === 'SINGANI') assertLotDo(state, ctx, lot)
  } else if (lot.productType === 'SINGANI') {
    assertLotDo(state, ctx, lot)
  }
  appendLotEvent(state, ctx, lot, {
    type: 'TANK_FILLED',
    occurredAt: startDate,
    summary: `Tanque ${tank.tankCode} lleno${tank.volumeFilledLiters !== null && tank.volumeFilledLiters !== undefined ? ` con ${formatQuantity(tank.volumeFilledLiters, 2)} L` : ''}`,
    data: { tankCode: tank.tankCode, volumeFilledLiters: tank.volumeFilledLiters ?? null, unit: 'L', kg: inputs.reduce((s, i) => s + i.kg, 0) },
    resource,
  })
  if (fermenting) {
    appendLotEvent(state, ctx, lot, { type: 'FERMENTATION_STARTED', occurredAt: startDate, summary: `Fermentación iniciada en ${tank.tankCode}`, data: { tankCode: tank.tankCode }, resource })
  }
  refreshLotStage(state, ctx, lot)
  return tank
}

const TRANSITION_FROM: Record<string, string> = { FERMENTING: 'FILLING', COMPLETED: 'FERMENTING', CLEANED: 'TRANSFERRED' }

function invalidTransition(tank: FermentationTankResponse, to: string): ApiError {
  const allowedFrom = TRANSITION_FROM[to]
  return stateError('TRC_TANK_INVALID_TRANSITION', `El tanque ${tank.tankCode} está ${tank.status}: solo pasa a ${to} desde ${allowedFrom}`, [
    violation('TRC_TANK_INVALID_TRANSITION', `El tanque ${tank.tankCode} está ${tank.status}: solo pasa a ${to} desde ${allowedFrom}`, { meta: { from: tank.status, to, allowedFrom } }),
  ])
}

/** Cambia el estado del tanque y lo anota en su historial (`transitions`). */
function moveTank(ctx: TraceCtx, tank: FermentationTankResponse, status: FermentationTankResponse['status'], at: string = ctx.now): void {
  recordTankTransition(tank, status, at, ctx.actor)
}

/** `FILLING → FERMENTING` (§4.2). */
export function startTank(state: TraceState, ctx: TraceCtx, tank: FermentationTankResponse, startedAt?: string): FermentationTankResponse {
  const lot = lotOfTank(state, tank)
  if (tank.status !== 'FILLING') throw invalidTransition(tank, 'FERMENTING')
  if (startedAt) {
    assertInstantNotFuture(ctx, 'startedAt', startedAt)
    assertNotBefore('startedAt', dayOf(startedAt), dayOf(tank.startDate))
  }
  moveTank(ctx, tank, 'FERMENTING', startedAt ? toInstant(startedAt) : ctx.now)
  appendLotEvent(state, ctx, lot, {
    type: 'FERMENTATION_STARTED',
    occurredAt: startedAt ? toInstant(startedAt) : ctx.now,
    summary: `Fermentación iniciada en ${tank.tankCode}`,
    data: { tankCode: tank.tankCode },
    resource: { type: 'fermentation_tank', id: tank.id },
  })
  refreshLotStage(state, ctx, lot)
  return tank
}

/** `FERMENTING → COMPLETED` con la bifurcación (§4.2–§4.3): destino coherente con el lote y, si es singani, su D.O. */
export function completeTank(state: TraceState, ctx: TraceCtx, tank: FermentationTankResponse, body: CompleteFermentationTankDto): FermentationTankResponse {
  const lot = lotOfTank(state, tank)
  if (tank.status !== 'FERMENTING') throw invalidTransition(tank, 'COMPLETED')
  const endDay = dayOf(body.endDate)
  assertNotFuture(ctx, 'endDate', endDay)
  assertNotBefore('endDate', endDay, dayOf(tank.startDate))
  const filled = tank.volumeFilledLiters ?? null
  if (filled !== null && body.finalVolumeLiters > filled + 1e-6) {
    throw ruleError('TRC_VOLUME_EXCEEDS_AVAILABLE', `El tanque se llenó con ${formatQuantity(filled, 2)} L`, [
      violation('TRC_VOLUME_EXCEEDS_AVAILABLE', 'El volumen final no puede superar el llenado', {
        field: 'finalVolumeLiters',
        expected: filled,
        actual: body.finalVolumeLiters,
        meta: { available: filled, requested: body.finalVolumeLiters, unit: 'L', tankId: tank.id },
      }),
    ])
  }
  const product = assertDestination(lot, body.destination, 'destination') as LotProductType
  const endDate = toInstant(body.endDate)
  const resource = { type: 'fermentation_tank', id: tank.id }
  decideProductType(state, ctx, lot, product, endDate, resource)
  if (product === 'SINGANI') assertLotDo(state, ctx, lot)
  moveTank(ctx, tank, 'COMPLETED', endDate)
  tank.endDate = endDate
  tank.finalVolumeLiters = body.finalVolumeLiters
  tank.destinationType = body.destination
  appendLotEvent(state, ctx, lot, {
    type: 'FERMENTATION_COMPLETED',
    occurredAt: endDate,
    summary: `Fermentación completada en ${tank.tankCode}: ${formatQuantity(body.finalVolumeLiters, 2)} L con destino ${product === 'WINE' ? 'vino' : 'singani'}`,
    data: { tankCode: tank.tankCode, finalVolumeLiters: body.finalVolumeLiters, unit: 'L', destinationType: body.destination },
    resource,
  })
  refreshLotStage(state, ctx, lot)
  return tank
}

/**
 * `TRANSFERRED → CLEANED`: libera el `tankCode` (S-7). Dos casos más, para que un código físico no
 * quede ocupado para siempre: el tanque de un lote descartado o rechazado se limpia desde cualquier
 * estado, y un tanque `COMPLETED` del que ya salió alguna destilación y al que le queda un remanente
 * se cierra aquí (pasa por `TRANSFERRED`; el remanente queda como `transferLossLiters`). No escribe
 * en la línea de tiempo del lote: queda en el historial del tanque y en la bitácora.
 */
export function cleanTank(state: TraceState, ctx: TraceCtx, tank: FermentationTankResponse, cleanedAt?: string): FermentationTankResponse {
  const lot = state.lots.find((l) => l.id === tank.lotId)
  const lotGone = lot?.stage === 'DISCARDED' || lot?.stage === 'REJECTED'
  // Completado, con alguna destilación ya salida y un remanente por cerrar; sin ninguna salida, el vino base sigue dentro.
  const drained = tank.status === 'COMPLETED' && state.productionBatches.some((p) => p.fermentationTankId === tank.id)
  if (tank.status === 'CLEANED' || (tank.status !== 'TRANSFERRED' && !lotGone && !drained)) throw invalidTransition(tank, 'CLEANED')
  if (cleanedAt) {
    assertInstantNotFuture(ctx, 'cleanedAt', cleanedAt)
    assertNotBefore('cleanedAt', dayOf(cleanedAt), dayOf(tank.endDate ?? tank.startDate))
  }
  const at = cleanedAt ? toInstant(cleanedAt) : ctx.now
  // Con remanente: el cierre (`TRANSFERRED`) queda en el historial y el resto, como merma de trasiego.
  if (drained) moveTank(ctx, tank, 'TRANSFERRED', at)
  moveTank(ctx, tank, 'CLEANED', at)
  if (lot && !lotGone && ctx.now > lot.updatedAt) lot.updatedAt = ctx.now
  return tank
}

/** Estados en los que un tanque admite lecturas y tratamientos (§4.4). */
function assertTankActive(tank: FermentationTankResponse): void {
  if (tank.status === 'FILLING' || tank.status === 'FERMENTING' || tank.status === 'COMPLETED') return
  throw stateError('TRC_TANK_NOT_ACTIVE', `El tanque ${tank.tankCode} está ${tank.status}: ya no admite lecturas ni tratamientos`, [
    violation('TRC_TANK_NOT_ACTIVE', 'Tanque cerrado', { meta: { status: tank.status } }),
  ])
}

/** Lectura de fermentación (solo inserción). En la línea de tiempo se agrupan por tanque y día. */
export function addLog(state: TraceState, ctx: TraceCtx, tank: FermentationTankResponse, body: CreateFermentationLogDto, userId: string): StoredLog {
  const lot = lotOfTank(state, tank)
  assertTankActive(tank)
  assertInstantNotFuture(ctx, 'recordedAt', body.recordedAt)
  assertNotBefore('recordedAt', dayOf(body.recordedAt), dayOf(tank.startDate))
  const log: StoredLog = {
    id: ctx.newId('log'),
    fermentationTankId: tank.id,
    temperatureCelsius: body.temperatureCelsius,
    specificGravity: body.specificGravity ?? null,
    phValue: body.phValue ?? null,
    co2Observations: body.co2Observations ?? null,
    recordedAt: toInstant(body.recordedAt),
    notes: body.notes ?? null,
    recordedByMemberId: ctx.actor?.membershipId ?? null,
    recordedByUserId: userId,
  }
  state.logs.push(log)
  groupReadings(state, ctx, lot, tank, dayOf(log.recordedAt))
  refreshLotStage(state, ctx, lot)
  return log
}

/** Un evento `FERMENTATION_READINGS` por tanque y día, con el resumen de sus lecturas. */
export function groupReadings(state: TraceState, ctx: TraceCtx, lot: Lot, tank: FermentationTankResponse, day: string): void {
  const readings = state.logs.filter((l) => l.fermentationTankId === tank.id && dayOf(l.recordedAt) === day && !isVoided(state, 'FERMENTATION_LOG', l.id))
  if (readings.length === 0) return
  const temps = readings.map((l) => l.temperatureCelsius)
  // A igual hora, la última registrada.
  const last = readings.reduce((a, b) => (a.recordedAt > b.recordedAt ? a : b))
  const data = { tankCode: tank.tankCode, day, readings: readings.length, minTemperatureC: Math.min(...temps), maxTemperatureC: Math.max(...temps), lastTemperatureC: last.temperatureCelsius, unit: '°C' }
  const summary = `${readings.length === 1 ? 'Lectura' : `${readings.length} lecturas`} en ${tank.tankCode}: ${String(last.temperatureCelsius).replace('.', ',')} °C`
  const existing = state.lotEvents.find((e) => e.lotId === lot.id && e.type === 'FERMENTATION_READINGS' && e.resource.id === tank.id && e.data.day === day)
  if (existing) {
    existing.data = data
    existing.summary = summary
    return
  }
  appendLotEvent(state, ctx, lot, { type: 'FERMENTATION_READINGS', occurredAt: toDateField(day), summary, data, resource: { type: 'fermentation_tank', id: tank.id } })
}

/** Tratamiento enológico (solo inserción), hasta `COMPLETED`. */
export function addTreatment(state: TraceState, ctx: TraceCtx, tank: FermentationTankResponse, body: CreateEnologicalTreatmentDto): StoredTreatment {
  const lot = lotOfTank(state, tank)
  assertTankActive(tank)
  assertInstantNotFuture(ctx, 'appliedAt', body.appliedAt)
  assertNotBefore('appliedAt', dayOf(body.appliedAt), dayOf(tank.startDate))
  const treatment: StoredTreatment = {
    id: ctx.newId('treatment'),
    fermentationTankId: tank.id,
    treatmentType: body.treatmentType,
    additiveName: body.additiveName,
    additiveSupplier: body.additiveSupplier ?? null,
    dosageAppliedGPerHl: body.dosageAppliedGPerHl,
    totalAppliedG: body.totalAppliedG ?? null,
    regulatoryAuthCode: body.regulatoryAuthCode,
    appliedAt: toInstant(body.appliedAt),
    notes: body.notes ?? null,
    authorizedByMemberId: ctx.actor?.membershipId,
  }
  state.treatments.push(treatment)
  appendLotEvent(state, ctx, lot, {
    type: 'TREATMENT_APPLIED',
    occurredAt: treatment.appliedAt,
    summary: `Tratamiento en ${tank.tankCode}: ${body.additiveName}`,
    data: { tankCode: tank.tankCode, treatmentType: body.treatmentType, additiveName: body.additiveName, regulatoryAuthCode: body.regulatoryAuthCode },
    resource: { type: 'enological_treatment', id: treatment.id },
  })
  refreshLotStage(state, ctx, lot)
  return treatment
}

/**
 * Solo un tanque `COMPLETED` es origen de una crianza o de una destilación (§5.1, §5.2): sin
 * completar (`FILLING`/`FERMENTING`) aún no tiene volumen final ni destino decidido, y
 * `TRANSFERRED`/`CLEANED` ya no tiene volumen que transferir → 409 `TRC_TANK_NOT_COMPLETED`.
 */
function assertTankIsSource(tank: FermentationTankResponse): void {
  if (tank.status === 'COMPLETED') return
  const pending = tank.status === 'FILLING' || tank.status === 'FERMENTING'
  throw stateError(
    'TRC_TANK_NOT_COMPLETED',
    pending ? `El tanque ${tank.tankCode} está ${tank.status}: completa la fermentación antes de transferirlo` : `El tanque ${tank.tankCode} está ${tank.status}: ya no tiene volumen que transferir`,
    [violation('TRC_TANK_NOT_COMPLETED', pending ? 'Tanque sin completar' : 'Tanque ya transferido', { field: 'fermentationTankId', meta: { status: tank.status, tankId: tank.id } })],
  )
}

/** `COMPLETED → TRANSFERRED` (automática): al crear la crianza del tanque, al agotarse su volumen o con `closeTank`. */
function transferTank(ctx: TraceCtx, tank: FermentationTankResponse, destination: 'WINE_AGING' | 'SINGANI_DIST'): void {
  tank.destinationType = destination
  moveTank(ctx, tank, 'TRANSFERRED')
}

// ---------------------------------------------------------------------------
// Crianza del vino (§5.1)
// ---------------------------------------------------------------------------

export const findAgingIn = (state: TraceState, id: string, wineryId: string | null): WineAgingResponse => {
  const a = state.wineAgings.find((x) => x.id === id)
  if (!a || (wineryId && a.wineryId !== wineryId)) throw notFound(`Lote de crianza con identificador "${id}" no encontrado`)
  return a
}

export function createAging(state: TraceState, ctx: TraceCtx, wineryId: string, body: CreateWineAgingBatchDto): WineAgingResponse {
  const tank = findTankIn(state, body.fermentationTankId, wineryId)
  const lot = lotOfTank(state, tank)
  // Como el backend: una cuba solo pasa una vez a crianza.
  if (state.wineAgings.some((a) => a.fermentationTankId === tank.id)) {
    throw new ApiError(409, 'FERMENTATION_TANK_ALREADY_TRANSFERRED', `La cuba ${tank.tankCode} ya ha sido transferida a un lote de crianza previo`)
  }
  assertStage(lot, ['FERMENTING', 'AGING'], 'crianzas')
  assertTankIsSource(tank)
  const product = assertDestination(lot, tank.destinationType ?? 'WINE_AGING', 'fermentationTankId')
  if (product !== 'WINE') {
    throw ruleError('TRC_DESTINATION_MISMATCH', `El tanque ${tank.tankCode} tiene destino ${tank.destinationType}: no admite crianza`, [
      violation('TRC_DESTINATION_MISMATCH', 'Destino incoherente con la crianza', { field: 'fermentationTankId', expected: 'WINE_AGING', actual: tank.destinationType }),
    ])
  }
  const minimum = lot.rules.wine.minAgingMonths
  if (body.plannedMonths < minimum) {
    throw ruleError('TRC_AGING_BELOW_MINIMUM', `La crianza mínima del lote es de ${minimum} meses`, [
      violation('TRC_AGING_BELOW_MINIMUM', `Crianza de ${body.plannedMonths} meses bajo el mínimo de ${minimum}`, {
        field: 'plannedMonths',
        rule: LOT_RULE_KEYS.minAgingMonths,
        expected: minimum,
        actual: body.plannedMonths,
      }),
    ])
  }
  const available = tankAvailableLiters(state, tank)
  if (available !== null && body.volumeLiters > available + 1e-6) {
    throw ruleError('TRC_VOLUME_EXCEEDS_AVAILABLE', `Del tanque ${tank.tankCode} quedan ${formatQuantity(available, 2)} L`, [
      violation('TRC_VOLUME_EXCEEDS_AVAILABLE', 'Litros por encima de lo disponible', {
        field: 'volumeLiters',
        expected: available,
        actual: body.volumeLiters,
        meta: { available, requested: body.volumeLiters, unit: 'L', tankId: tank.id },
      }),
    ])
  }
  const startDay = body.startDate ? dayOf(body.startDate) : ctx.today
  assertNotFuture(ctx, 'startDate', startDay)
  assertNotBefore('startDate', startDay, dayOf(tank.endDate ?? tank.startDate))
  const aging: WineAgingResponse = {
    id: ctx.newId('aging'),
    wineryId,
    fermentationTankId: tank.id,
    containerType: body.containerType,
    containerMaterial: body.containerMaterial ?? null,
    containerCode: body.containerCode ?? null,
    barrelUseCycle: body.barrelUseCycle ?? null,
    volumeLiters: body.volumeLiters,
    plannedMonths: body.plannedMonths,
    lockUntilDate: toDateField(addMonthsYmd(startDay, Math.max(body.plannedMonths, minimum))),
    agingStatus: 'AGING',
    notes: body.notes ?? null,
    createdAt: ctx.now,
    lotId: lot.id,
    startDate: startDay,
    containerCount: body.containerCount ?? null,
  }
  state.wineAgings.push(aging)
  const resource = { type: 'wine_aging_batch', id: aging.id }
  decideProductType(state, ctx, lot, 'WINE', toDateField(startDay), resource)
  // Una crianza por tanque: lo que no se traslada queda como merma de trasiego.
  transferTank(ctx, tank, 'WINE_AGING')
  appendLotEvent(state, ctx, lot, {
    type: 'AGING_STARTED',
    occurredAt: toDateField(startDay),
    summary: `Crianza en ${aging.containerType} por ${aging.plannedMonths} meses: ${formatQuantity(aging.volumeLiters ?? 0, 2)} L`,
    data: { plannedMonths: aging.plannedMonths, volumeLiters: aging.volumeLiters, unit: 'L', unlockDate: aging.lockUntilDate.slice(0, 10) },
    resource,
  })
  refreshLotStage(state, ctx, lot)
  return aging
}

/** `AGING | READY → DISCARDED`: deja de contar como fuente abierta del embotellado. */
export function discardAging(state: TraceState, ctx: TraceCtx, aging: WineAgingResponse, body: { reason: string; discardedLiters?: number }): WineAgingResponse {
  const lot = aging.lotId ? findLot(state, aging.lotId, null, { writable: true }) : null
  if (aging.agingStatus !== 'AGING' && aging.agingStatus !== 'READY') {
    throw stateError('TRC_INVALID_STAGE', `La crianza está ${aging.agingStatus}: no se puede descartar`, [
      violation('TRC_INVALID_STAGE', 'Crianza ya cerrada', { meta: { status: aging.agingStatus, allowed: ['AGING', 'READY'] } }),
    ])
  }
  const available = aging.volumeLiters ?? 0
  if (body.discardedLiters !== undefined && body.discardedLiters > available + 1e-6) {
    throw ruleError('TRC_VOLUME_EXCEEDS_AVAILABLE', `La crianza tiene ${formatQuantity(available, 2)} L`, [
      violation('TRC_VOLUME_EXCEEDS_AVAILABLE', 'Litros por encima de lo disponible', {
        field: 'discardedLiters',
        expected: available,
        actual: body.discardedLiters,
        meta: { available, requested: body.discardedLiters, unit: 'L' },
      }),
    ])
  }
  aging.agingStatus = 'DISCARDED'
  aging.notes = [aging.notes, `Descartada: ${body.reason}`].filter(Boolean).join(' · ')
  if (lot) {
    refreshLotStage(state, ctx, lot)
    // Interno: los motivos y las mermas no son públicos (S-22).
    appendLotEvent(state, ctx, lot, {
      type: 'LOT_DISCARDED',
      occurredAt: ctx.now,
      visibility: 'INTERNAL',
      summary: `Crianza descartada (${formatQuantity(body.discardedLiters ?? available, 2)} L): ${body.reason}`,
      data: { scope: 'SOURCE', sourceType: 'WINE_AGING', discardedLiters: body.discardedLiters ?? available, unit: 'L', reason: body.reason },
      resource: { type: 'wine_aging_batch', id: aging.id },
    })
  }
  return aging
}

// ---------------------------------------------------------------------------
// Destilación y reposo del singani (§5.2)
// ---------------------------------------------------------------------------

export const findProductionIn = (state: TraceState, id: string, wineryId: string | null): ProductionBatchResponse => {
  const p = state.productionBatches.find((x) => x.id === id)
  if (!p || (wineryId && p.wineryId !== wineryId)) throw notFound(`Lote de producción con identificador "${id}" no encontrado`)
  return p
}

function massBalance(field: string, input: number, total: number): ApiError {
  return ruleError('TRC_MASS_BALANCE_EXCEEDED', `Los cortes suman ${formatQuantity(total, 3)} L y la entrada fue de ${formatQuantity(input, 3)} L`, [
    violation('TRC_MASS_BALANCE_EXCEEDED', 'Cortes mayores que la entrada', { field, expected: input, actual: total, meta: { inputLiters: input, outputLiters: total } }),
  ])
}

/**
 * Destilación (§5.2): abre el lote de destilación desde un tanque `COMPLETED` con destino singani.
 * La D.O. del lote se comprueba con su instantánea. Los cortes, el grado del corazón y el reposo
 * llegan con el cierre (`POST …/close`).
 */
export function createDistillation(state: TraceState, ctx: TraceCtx, wineryId: string, body: CreateDistillationBatchDto): ProductionBatchResponse {
  const tank = findTankIn(state, body.fermentationTankId, wineryId)
  const lot = lotOfTank(state, tank)
  assertTankIsSource(tank)
  assertStage(lot, ['FERMENTING', 'DISTILLING', 'RESTING'], 'destilaciones')
  const product = assertDestination(lot, tank.destinationType ?? 'SINGANI_DIST', 'fermentationTankId')
  if (product !== 'SINGANI') {
    throw ruleError('TRC_DESTINATION_MISMATCH', `El tanque ${tank.tankCode} tiene destino ${tank.destinationType}: no admite destilación`, [
      violation('TRC_DESTINATION_MISMATCH', 'Destino incoherente con la destilación', { field: 'fermentationTankId', expected: 'SINGANI_DIST', actual: tank.destinationType }),
    ])
  }
  const startDay = dayOf(body.processStartDate)
  decideProductType(state, ctx, lot, 'SINGANI', toDateField(startDay), { type: 'fermentation_tank', id: tank.id })
  assertLotDo(state, ctx, lot)
  // Inicio no futuro ni anterior al fin de la fermentación.
  assertNotFuture(ctx, 'processStartDate', startDay)
  assertNotBefore('processStartDate', startDay, dayOf(tank.endDate ?? tank.startDate))
  const available = tankAvailableLiters(state, tank)
  if (available !== null && body.inputVolumeLiters > available + 1e-6) {
    throw ruleError('TRC_VOLUME_EXCEEDS_AVAILABLE', `Del tanque ${tank.tankCode} quedan ${formatQuantity(available, 2)} L`, [
      violation('TRC_VOLUME_EXCEEDS_AVAILABLE', 'Litros por encima de lo disponible', {
        field: 'inputVolumeLiters',
        expected: available,
        actual: body.inputVolumeLiters,
        meta: { available, requested: body.inputVolumeLiters, unit: 'L', tankId: tank.id },
      }),
    ])
  }
  const production: ProductionBatchResponse = {
    id: ctx.newId('production'),
    wineryId,
    fermentationTankId: tank.id,
    processType: 'SINGANI_DISTILLATION',
    equipmentIdentifier: body.equipmentIdentifier,
    processStartDate: toDateField(startDay),
    processEndDate: null,
    inputVolumeLiters: body.inputVolumeLiters,
    outputVolumeLiters: null,
    wasteVolumeLiters: null,
    initialAlcoholPercentage: body.initialAlcoholPercentage ?? null,
    // D.O. calculada sobre el lote (acaba de comprobarse, EA-03).
    isDoEligible: true,
    mandatoryRestUntil: null,
    // El reposo se abre al cerrar la destilación.
    restStatus: 'NOT_REQUIRED',
    additionalParams: null,
    notes: body.notes ?? null,
    createdAt: ctx.now,
    lotId: lot.id,
    headsLiters: null,
    heartLiters: null,
    tailsLiters: null,
    vinasseLiters: null,
    heartAbvPercent: null,
  }
  state.productionBatches.push(production)
  appendLotEvent(state, ctx, lot, {
    type: 'DISTILLATION_STARTED',
    occurredAt: production.processStartDate,
    stage: 'DISTILLING',
    summary: `Destilación en ${body.equipmentIdentifier} de ${formatQuantity(body.inputVolumeLiters, 3)} L`,
    data: { inputVolumeLiters: body.inputVolumeLiters, unit: 'L', equipmentIdentifier: body.equipmentIdentifier },
    resource: { type: 'production_batch', id: production.id },
  })
  // → TRANSFERRED al agotarse el tanque o con `closeTank` (§4.2).
  const remaining = tankAvailableLiters(state, tank)
  if (body.closeTank === true || (remaining !== null && remaining <= 1e-6)) transferTank(ctx, tank, 'SINGANI_DIST')
  refreshLotStage(state, ctx, lot)
  return production
}

/** Cierre de la destilación con sus cortes (§5.2): balance de masa y apertura del reposo. */
export function closeDistillation(state: TraceState, ctx: TraceCtx, production: ProductionBatchResponse, body: CloseDistillationDto): ProductionBatchResponse {
  const lot = production.lotId ? findLot(state, production.lotId, null, { writable: true }) : null
  if (production.restStatus === 'DISCARDED' || production.restStatus === 'BOTTLED') {
    throw stateError('TRC_INVALID_STAGE', `La destilación está ${production.restStatus}`, [violation('TRC_INVALID_STAGE', 'Destilación ya cerrada', { meta: { status: production.restStatus } })])
  }
  if (production.processEndDate) {
    throw stateError('TRC_DISTILLATION_ALREADY_CLOSED', 'La destilación ya está cerrada', [
      violation('TRC_DISTILLATION_ALREADY_CLOSED', 'Destilación ya cerrada', { meta: { processEndDate: production.processEndDate.slice(0, 10) } }),
    ])
  }
  const endDay = dayOf(body.processEndDate)
  assertNotFuture(ctx, 'processEndDate', endDay)
  assertNotBefore('processEndDate', endDay, dayOf(production.processStartDate))
  const input = production.inputVolumeLiters ?? null
  if (input === null) {
    throw ruleError('TRC_VOLUME_MISSING', 'La destilación no tiene registrado el volumen de entrada: no se puede verificar el balance de masa', [
      violation('TRC_VOLUME_MISSING', 'Volumen de entrada sin registrar', { field: 'inputVolumeLiters', meta: { field: 'inputVolumeLiters' } }),
    ])
  }
  const total = body.cuts.headsLiters + body.cuts.heartLiters + body.cuts.tailsLiters + (body.vinasseLiters ?? 0)
  if (total > input + 1e-6) throw massBalance('cuts', input, total)
  const minRest = lot?.rules.singani.minRestDays ?? 180
  const restUntil = addDaysYmd(endDay, minRest)
  production.processEndDate = toDateField(endDay)
  production.headsLiters = body.cuts.headsLiters
  production.heartLiters = body.cuts.heartLiters
  production.tailsLiters = body.cuts.tailsLiters
  production.vinasseLiters = body.vinasseLiters ?? null
  production.heartAbvPercent = body.heartAbvPercent
  production.outputVolumeLiters = body.cuts.heartLiters
  production.wasteVolumeLiters = Math.round((body.cuts.headsLiters + body.cuts.tailsLiters) * 1000) / 1000
  production.mandatoryRestUntil = toDateField(restUntil)
  production.restStatus = 'RESTING'
  if (body.notes) production.notes = body.notes
  if (lot) {
    refreshLotStage(state, ctx, lot)
    appendLotEvent(state, ctx, lot, {
      type: 'DISTILLATION_CLOSED',
      occurredAt: production.processEndDate,
      summary: `Destilación cerrada: corazón de ${formatQuantity(body.cuts.heartLiters, 3)} L al ${String(body.heartAbvPercent).replace('.', ',')} %; reposo hasta ${restUntil}`,
      data: { ...body.cuts, heartAbvPercent: body.heartAbvPercent, vinasseLiters: body.vinasseLiters ?? null, restUntil, unit: 'L' },
      resource: { type: 'production_batch', id: production.id },
    })
    // Cierre tardío con el reposo ya cumplido: el candado se libera en el momento.
    if (restUntil <= ctx.today) releaseLocks(state, { ...ctx, actor: null }, lot.id)
  }
  return production
}

/** `→ DISCARDED`: deja de contar como fuente abierta del embotellado. */
export function discardDistillation(state: TraceState, ctx: TraceCtx, production: ProductionBatchResponse, reason: string): ProductionBatchResponse {
  const lot = production.lotId ? findLot(state, production.lotId, null, { writable: true }) : null
  if (production.restStatus === 'BOTTLED' || production.restStatus === 'DISCARDED') {
    throw stateError('TRC_INVALID_STAGE', `La destilación está ${production.restStatus}: no se puede descartar`, [
      violation('TRC_INVALID_STAGE', 'Destilación ya cerrada', { meta: { status: production.restStatus, allowed: ['NOT_REQUIRED', 'RESTING', 'READY'] } }),
    ])
  }
  production.restStatus = 'DISCARDED'
  production.notes = [production.notes, `Descartada: ${reason}`].filter(Boolean).join(' · ')
  if (lot) {
    refreshLotStage(state, ctx, lot)
    appendLotEvent(state, ctx, lot, {
      type: 'LOT_DISCARDED',
      occurredAt: ctx.now,
      visibility: 'INTERNAL',
      summary: `Destilación descartada: ${reason}`,
      data: { scope: 'SOURCE', sourceType: 'PRODUCTION_BATCH', reason },
      resource: { type: 'production_batch', id: production.id },
    })
  }
  return production
}

/** `GET /v1/production-batches/{id}/rest-status`: reposo con la instantánea del lote y el reloj del servidor. */
export function restStatusOf(state: TraceState, ctx: Pick<TraceCtx, 'today'>, p: ProductionBatchResponse): RestStatusResponse {
  const lot = state.lots.find((l) => l.id === p.lotId)
  const lock = lot ? restLockOf(p, lot.rules, ctx.today) : null
  if (!p.processEndDate || !lock) {
    return { id: p.id, restStatus: p.restStatus, processEndDate: p.processEndDate ?? null, mandatoryRestUntil: p.mandatoryRestUntil ?? null, daysElapsed: 0, daysRemaining: 0, isRestCompleted: false }
  }
  return {
    id: p.id,
    restStatus: lock.released && p.restStatus === 'RESTING' ? 'READY' : p.restStatus,
    processEndDate: p.processEndDate,
    mandatoryRestUntil: toDateField(lock.unlockDate),
    daysElapsed: Math.max(0, daysBetween(dayOf(p.processEndDate), ctx.today)),
    daysRemaining: lock.daysRemaining,
    isRestCompleted: lock.released,
  }
}

/** Destilaciones abiertas del lote que aún no tienen corazón registrado (para avisos de la UI). */
export const openDistillations = (state: TraceState, lotId: string) => lotProductions(state, lotId).filter((p) => !p.processEndDate && p.restStatus !== 'DISCARDED')

/** Detalle de error de un campo (para los handlers). */
export const fieldDetail = (field: string, message: string): ApiErrorDetail => ({ field, message })

export { distillationHeart, laPazDate }
