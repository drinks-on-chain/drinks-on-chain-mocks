import type { ApiErrorDetail } from '../../shared/envelope'
import { ApiError } from '../handlers/errors'
import type {
  BatchLabAnalysisResponse,
  BottleCodeExport,
  BottlingBatchResponse,
  Correction,
  CorrectionTargetType,
  CreateLotDto,
  DoEvaluation,
  EnologicalTreatmentRecord,
  FermentationLogRecord,
  FermentationTankResponse,
  HarvestBatchResponse,
  Lot,
  LotAttachment,
  LotDossier,
  LotEventType,
  LotLockInfo,
  LotProductType,
  LotRules,
  LotStageCode,
  LotSummary,
  MaturityAnalysis,
  PhytoDecision,
  ProductionBatchResponse,
  StoredLotEvent,
  TerroirResponse,
  TraceActor,
  WineAgingResponse,
  WineryResponse,
} from '../schemas'
import { PUBLIC_LOT_EVENT_TYPES, TERMINAL_LOT_STAGES } from '../schemas/lots'
import { mockBottleCode } from './bottle-code'
import { dateOnly, dayOf, daysBetween, laPazDate } from './dates'
import { agingLock, deriveLotStage, doRulesFromLot, doViolations, evaluateDo, nextLock, readyDateFromLocks, restLock, type DoRules } from './domain'
import { buildLotRules, formatQuantity, violation, type SettingsSnapshot } from './rules'

// Estado y operaciones básicas del lote del servidor (contrato de la Ola 2 §1–§2). Todo lo de
// `src/erp/trace/` es puro: trabaja sobre un `TraceState` (las colecciones de la base en memoria
// de los handlers o las del generador de fixtures) y un `TraceCtx` (reloj, autor e ids), sin msw.
// Así el generador de fixtures recorre los mismos servicios que los handlers y los datos de
// demostración cumplen, por construcción, las reglas que luego se les aplican.

/** Lectura guardada (fila de la semilla; las altas guardan además la persona que la registró). */
export type StoredLog = FermentationLogRecord & { recordedByUserId?: string }
/** Tratamiento guardado (las altas guardan además el miembro que lo autorizó). */
export type StoredTreatment = EnologicalTreatmentRecord & { authorizedByMemberId?: string }
/** Adjunto del lote sin la URL firmada (se calcula al responder). */
export type StoredAttachment = Omit<LotAttachment, 'url' | 'urlExpiresAt'> & { lotId: string }
/** Expediente con los bytes canónicos que se hashearon al cerrarlo. */
export type StoredDossier = LotDossier & { canonical?: string }
/** Exportación ZIP de códigos con su lote y su rango. */
export type StoredBottleExport = BottleCodeExport & { lotId: string; fromSerial: number; toSerial: number; imageFormat: 'SVG' | 'PNG'; polls: number }

/** Código de botella anulado (con o sin sustituto). */
export interface VoidedBottleCode {
  serial: number
  code: string
  generation: number
  at: string
  by: TraceActor
  reason: string
  replacedBy: string | null
}

/**
 * Códigos de botella de un lote. No se guarda un registro por botella: el código de la serie `n`
 * es `mockBottleCode(lotId, n, generación)`; solo se guardan las series sustituidas, los códigos
 * anulados y los rangos exportados.
 */
export interface BottleLot {
  lotId: string
  bottlingBatchId: string
  /** Botellas embotelladas (series `1…total`). */
  total: number
  /** Generación vigente de las series cuyo código se sustituyó (las demás, 0). */
  generations: Record<string, number>
  voided: VoidedBottleCode[]
  /** Todos los códigos activos anulados de una vez (lote descartado). */
  allVoided: { at: string; by: TraceActor | null; reason: string } | null
  /** Rangos exportados (CSV o ZIP) con su fecha. */
  exports: { fromSerial: number; toSerial: number; at: string }[]
}

/** Colecciones de la trazabilidad. La base de los handlers (`ErpDb`) las contiene todas. */
export interface TraceState {
  wineries: WineryResponse[]
  terroirs: TerroirResponse[]
  harvestBatches: HarvestBatchResponse[]
  tanks: FermentationTankResponse[]
  logs: StoredLog[]
  treatments: StoredTreatment[]
  wineAgings: WineAgingResponse[]
  productionBatches: ProductionBatchResponse[]
  bottlings: BottlingBatchResponse[]
  labAnalyses: BatchLabAnalysisResponse[]
  lots: Lot[]
  lotEvents: StoredLotEvent[]
  maturityAnalyses: MaturityAnalysis[]
  phytoDecisions: PhytoDecision[]
  corrections: Correction[]
  attachments: StoredAttachment[]
  dossiers: StoredDossier[]
  bottleLots: BottleLot[]
  bottleExports: StoredBottleExport[]
  /** Registros anulados por una corrección `VOID` (`TIPO:id`): dejan de contar. */
  voidedRecords: string[]
}

/** Colecciones nuevas de la Ola 2, vacías. */
export function emptyTraceCollections(): Pick<
  TraceState,
  'lots' | 'lotEvents' | 'maturityAnalyses' | 'phytoDecisions' | 'corrections' | 'attachments' | 'dossiers' | 'bottleLots' | 'bottleExports' | 'voidedRecords'
> {
  return { lots: [], lotEvents: [], maturityAnalyses: [], phytoDecisions: [], corrections: [], attachments: [], dossiers: [], bottleLots: [], bottleExports: [], voidedRecords: [] }
}

/** Contexto de una operación: reloj del servidor, autor e identificadores. */
export interface TraceCtx {
  /** Instante actual (ISO sin milisegundos). Todo candado se evalúa con él, nunca con una fecha enviada. */
  now: string
  /** Día de hoy en America/La_Paz (`YYYY-MM-DD`). */
  today: string
  /** Membresía de la bodega que actúa; `null` = sistema. */
  actor: TraceActor | null
  /** Id nuevo de un recurso (`lot`, `harvest`, `lot-event`…). */
  newId: (kind: string) => string
  /** Base del QR: `{passportBaseUrl}/b/{código}` (OP-06). */
  passportBaseUrl: string
  /** Instantánea de la configuración vigente de una bodega (parámetros `appliesAt: 'LOT'`). */
  snapshot: (wineryId: string) => SettingsSnapshot
  /** Prefijo de lote de la bodega (ORG-05). */
  lotPrefix: (wineryId: string) => string
}

/** Contexto con otro reloj (los registros del generador de fixtures ocurren en su fecha). */
export function ctxAt(ctx: TraceCtx, now: string, actor: TraceActor | null = ctx.actor): TraceCtx {
  return { ...ctx, now, today: laPazDate(now), actor }
}

// ---------------------------------------------------------------------------
// Errores de reglas (contrato §0 y §13)
// ---------------------------------------------------------------------------

/** 422: regla de negocio incumplida. */
export const ruleError = (code: string, message: string, details: ApiErrorDetail[] = []) =>
  new ApiError(422, code, message, details.length > 0 ? details : null)

/** 409: acción no permitida en el estado actual del recurso. */
export const stateError = (code: string, message: string, details: ApiErrorDetail[] = []) =>
  new ApiError(409, code, message, details.length > 0 ? details : null)

/** 404 del lote (inexistente o de otra bodega: nunca 403). */
export const lotNotFound = () => new ApiError(404, 'TRC_LOT_NOT_FOUND', 'Lote no encontrado')

/**
 * Lanza el código de la primera violación (en el orden de las reglas del contrato) con todas en
 * `details`. No hace nada si la lista está vacía.
 */
export function throwViolations(violations: ApiErrorDetail[], message?: string, status: 409 | 422 = 422): void {
  const first = violations[0]
  if (!first) return
  throw new ApiError(status, first.code ?? 'UNPROCESSABLE_ENTITY', message ?? first.message, violations)
}

/** Fecha no futura (reloj del servidor): 422 `TRC_DATE_IN_FUTURE`. */
export function assertNotFuture(ctx: TraceCtx, field: string, day: string): void {
  if (day <= ctx.today) return
  throw ruleError('TRC_DATE_IN_FUTURE', 'La fecha no puede ser futura', [
    violation('TRC_DATE_IN_FUTURE', 'Fecha futura', { field, expected: ctx.today, actual: day }),
  ])
}

/** Fecha no anterior a la etapa previa: 422 `TRC_DATE_BEFORE_PREVIOUS_STAGE`. */
export function assertNotBefore(field: string, day: string, minimum: string): void {
  if (day >= minimum) return
  throw ruleError('TRC_DATE_BEFORE_PREVIOUS_STAGE', 'Fecha anterior a la etapa previa', [
    violation('TRC_DATE_BEFORE_PREVIOUS_STAGE', 'Fecha anterior a la etapa previa', { field, expected: minimum, actual: day, meta: { field, minimum } }),
  ])
}

// ---------------------------------------------------------------------------
// Lecturas de la cadena
// ---------------------------------------------------------------------------

const byText = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b))

export const isVoided = (state: TraceState, type: CorrectionTargetType, id: string) => state.voidedRecords.includes(`${type}:${id}`)
export const correctionsOf = (state: TraceState, type: CorrectionTargetType | string, id: string) =>
  state.corrections.filter((c) => c.target.id === id && (c.target.type === type || RESOURCE_TARGETS[type] === c.target.type))

/** Tipo de recurso de la línea de tiempo → tipo de corrección. */
const RESOURCE_TARGETS: Record<string, CorrectionTargetType> = {
  terroir: 'TERROIR',
  harvest_batch: 'HARVEST_BATCH',
  maturity_analysis: 'MATURITY_ANALYSIS',
  phyto_decision: 'PHYTO_DECISION',
  fermentation_tank: 'FERMENTATION_TANK',
  fermentation_log: 'FERMENTATION_LOG',
  enological_treatment: 'TREATMENT',
  wine_aging_batch: 'WINE_AGING',
  production_batch: 'PRODUCTION_BATCH',
  bottling_batch: 'BOTTLING',
  lab_analysis: 'LAB_ANALYSIS',
}

export const lotHarvests = (state: TraceState, lotId: string) => state.harvestBatches.filter((h) => h.lotId === lotId).sort(byText((h) => h.intakeDate))
export const lotTanks = (state: TraceState, lotId: string) => state.tanks.filter((t) => t.lotId === lotId).sort(byText((t) => t.startDate))
export const lotAgings = (state: TraceState, lotId: string) => state.wineAgings.filter((a) => a.lotId === lotId).sort(byText((a) => a.createdAt))
export const lotProductions = (state: TraceState, lotId: string) =>
  state.productionBatches.filter((p) => p.lotId === lotId).sort(byText((p) => p.processStartDate))
export const lotBottling = (state: TraceState, lotId: string) => state.bottlings.find((b) => b.lotId === lotId) ?? null
export const lotDossier = (state: TraceState, lotId: string) => state.dossiers.find((d) => d.lotId === lotId) ?? null
export const bottleLotOf = (state: TraceState, lotId: string) => state.bottleLots.find((b) => b.lotId === lotId) ?? null

/** Análisis de laboratorio del lote que cuentan (sin los anulados), del más antiguo al más reciente. */
export const lotLabs = (state: TraceState, lotId: string) =>
  state.labAnalyses.filter((l) => l.lotId === lotId && !isVoided(state, 'LAB_ANALYSIS', l.id)).sort(byText((l) => l.createdAt))

/** Análisis vigente del lote: el último sin sustituir. */
export const currentLab = (state: TraceState, lotId: string) =>
  lotLabs(state, lotId)
    .filter((l) => !l.supersededAt)
    .at(-1) ?? null

/** Parcela de un pesaje tal como era al pesar (o como está hoy si no hay instantánea). */
export function harvestTerroir(state: TraceState, h: HarvestBatchResponse): { id: string; parcelName: string; altitudeMasl: number; varietyName: string } {
  const t = state.terroirs.find((x) => x.id === h.terroirId)
  return {
    id: h.terroirId,
    parcelName: h.terroirSnapshot?.parcelName ?? t?.parcelName ?? '',
    altitudeMasl: h.terroirSnapshot?.altitudeMasl ?? t?.altitudeMasl ?? 0,
    varietyName: h.terroirSnapshot?.varietyName ?? t?.varietyName ?? '',
  }
}

/** Kilos netos de un pesaje que aún no entraron a un tanque. */
export function harvestAvailableKg(state: TraceState, h: HarvestBatchResponse): number {
  const used = state.tanks.reduce((sum, t) => sum + (t.inputs ?? []).filter((i) => i.harvestBatchId === h.id).reduce((s, i) => s + i.kg, 0), 0)
  return Math.max(0, Math.round((h.netWeightKg - used) * 1000) / 1000)
}

/** ¿Entró ya el pesaje a algún tanque? */
export const harvestInTank = (state: TraceState, harvestId: string) => state.tanks.some((t) => (t.inputs ?? []).some((i) => i.harvestBatchId === harvestId))

/** Litros de un tanque: el volumen final si se registró; si no, el llenado. */
export const tankLiters = (t: FermentationTankResponse): number | null => t.finalVolumeLiters ?? t.volumeFilledLiters ?? null

/** Litros que aún quedan en un tanque (final o llenado − crianza − destilaciones). */
export function tankAvailableLiters(state: TraceState, tank: FermentationTankResponse): number | null {
  const liters = tankLiters(tank)
  if (liters === null) return null
  const drawn =
    state.wineAgings.filter((a) => a.fermentationTankId === tank.id).reduce((s, a) => s + (a.volumeLiters ?? 0), 0) +
    state.productionBatches.filter((p) => p.fermentationTankId === tank.id).reduce((s, p) => s + (p.inputVolumeLiters ?? 0), 0)
  return Math.max(0, Math.round((liters - drawn) * 1000) / 1000)
}

/** Corazón de una destilación: `heartLiters` (Ola 2) o `outputVolumeLiters` (legado), con su grado. */
export function distillationHeart(p: ProductionBatchResponse): { liters: number | null; abv: number | null } {
  return { liters: p.heartLiters ?? p.outputVolumeLiters ?? null, abv: p.heartAbvPercent ?? p.initialAlcoholPercentage ?? null }
}

export const isAgingOpen = (a: WineAgingResponse) => a.agingStatus === 'AGING' || a.agingStatus === 'READY'
export const isProductionOpen = (p: ProductionBatchResponse) => p.restStatus !== 'BOTTLED' && p.restStatus !== 'DISCARDED'

/** Día de inicio de una crianza: `startDate` o, en los registros anteriores, su fecha de alta en La Paz. */
export const agingStartDay = (a: WineAgingResponse): string => (a.startDate ? dayOf(a.startDate) : laPazDate(a.createdAt))

export function agingLockOf(a: WineAgingResponse, rules: LotRules, today: string): LotLockInfo {
  return agingLock({ id: a.id, startDate: agingStartDay(a), plannedMonths: a.plannedMonths, storedUnlockDate: dateOnly(a.lockUntilDate) }, rules, today)
}

export function restLockOf(p: ProductionBatchResponse, rules: LotRules, today: string): LotLockInfo | null {
  return restLock(
    { id: p.id, processEndDate: p.processEndDate ? dateOnly(p.processEndDate) : null, storedUnlockDate: p.mandatoryRestUntil ? dateOnly(p.mandatoryRestUntil) : null },
    rules,
    today,
  )
}

/** Candados del lote con su instantánea y el día de hoy (reloj del servidor). */
export function lotLocks(state: TraceState, lot: Lot, today: string): LotLockInfo[] {
  const locks: LotLockInfo[] = []
  for (const a of lotAgings(state, lot.id)) if (a.agingStatus !== 'DISCARDED') locks.push(agingLockOf(a, lot.rules, today))
  for (const p of lotProductions(state, lot.id)) {
    if (p.restStatus === 'DISCARDED') continue
    const lock = restLockOf(p, lot.rules, today)
    if (lock) locks.push(lock)
  }
  return locks
}

// ---------------------------------------------------------------------------
// Códigos de botella: totales
// ---------------------------------------------------------------------------

/** Generación vigente del código de una serie. */
export const bottleGeneration = (bl: BottleLot, serial: number): number => bl.generations[String(serial)] ?? 0
/** Código vigente de una serie. */
export const bottleCodeOf = (bl: BottleLot, serial: number): string => mockBottleCode(bl.lotId, serial, bottleGeneration(bl, serial))

/** ¿Está anulado el código vigente de la serie? */
export function isSerialVoided(bl: BottleLot, serial: number): boolean {
  if (bl.allVoided) return true
  const generation = bottleGeneration(bl, serial)
  return bl.voided.some((v) => v.serial === serial && v.generation === generation)
}

/** Totales de los códigos de un lote (`BottleCodesSummaryDto`). */
export function bottleCodesSummary(bl: BottleLot | null): { total: number; active: number; voided: number; firstSerial: number | null; lastSerial: number | null } {
  if (!bl) return { total: 0, active: 0, voided: 0, firstSerial: null, lastSerial: null }
  const replaced = bl.voided.filter((v) => v.replacedBy !== null).length
  const retired = bl.allVoided ? bl.total : new Set(bl.voided.filter((v) => v.replacedBy === null).map((v) => v.serial)).size
  return { total: bl.total + replaced, active: bl.total - retired, voided: replaced + retired, firstSerial: bl.total > 0 ? 1 : null, lastSerial: bl.total > 0 ? bl.total : null }
}

// ---------------------------------------------------------------------------
// Lote: creación, etapa, vistas y línea de tiempo
// ---------------------------------------------------------------------------

/** Lote de la bodega; inexistente o de otra → 404 `TRC_LOT_NOT_FOUND`. `writable`: etapa terminal → 409 `TRC_LOT_TERMINAL`. */
export function findLot(state: TraceState, id: string, wineryId: string | null, options: { writable?: boolean } = {}): Lot {
  const lot = state.lots.find((l) => l.id === id)
  if (!lot || (wineryId && lot.wineryId !== wineryId)) throw lotNotFound()
  if (options.writable) assertLotWritable(lot)
  return lot
}

export function assertLotWritable(lot: Lot): void {
  if (!TERMINAL_LOT_STAGES.includes(lot.stage)) return
  throw stateError('TRC_LOT_TERMINAL', `El lote está ${lot.stage}: ya no admite cambios`, [
    violation('TRC_LOT_TERMINAL', 'Lote en una etapa terminal', { meta: { stage: lot.stage } }),
  ])
}

/** Etapas en las que el lote admite una etapa de proceso: si no, 409 `TRC_INVALID_STAGE`. */
export function assertStage(lot: Lot, allowed: readonly LotStageCode[], action: string): void {
  if (allowed.includes(lot.stage)) return
  throw stateError('TRC_INVALID_STAGE', `El lote está en etapa ${lot.stage}: no admite ${action}`, [
    violation('TRC_INVALID_STAGE', `Etapa del lote sin ${action}`, { meta: { stage: lot.stage, allowed } }),
  ])
}

function nextSequence(existing: readonly string[], prefix: string): number {
  const used = existing.filter((code) => code.startsWith(prefix)).map((code) => Number(code.split('-').at(-1))).filter((n) => Number.isInteger(n))
  return (used.length > 0 ? Math.max(...used) : 0) + 1
}

/** Referencia interna `{lotPrefix}-L{año}-{NNN}` (secuencia por bodega y año). */
export function nextLotReference(state: TraceState, ctx: TraceCtx, wineryId: string, year: number): string {
  const prefix = `${ctx.lotPrefix(wineryId)}-L${year}-`
  return `${prefix}${String(nextSequence(state.lots.filter((l) => l.wineryId === wineryId).map((l) => l.reference), prefix)).padStart(3, '0')}`
}

/** Código de lote `{lotPrefix}-{año}-{WINE|SINGANI}-{NNN}`: secuencia por bodega y año, común a los productos (S-13). */
export function nextLotCode(state: TraceState, ctx: TraceCtx, wineryId: string, year: number, productType: LotProductType): string {
  const prefix = `${ctx.lotPrefix(wineryId)}-${year}-`
  const seq = nextSequence(state.bottlings.filter((b) => b.wineryId === wineryId).map((b) => b.internationalLotCode), prefix)
  return `${prefix}${productType}-${String(seq).padStart(3, '0')}`
}

/** Código de vendimia `HARV-{año}-{parcela}-{NNN}`: secuencia por bodega y año (EA-07). */
export function nextHarvestCode(state: TraceState, wineryId: string, year: number, parcelName: string): string {
  const slug = (parcelName.split('·').at(-1)?.trim().split(/\s+/).at(-1) ?? 'LOTE')
    .normalize('NFD')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
  const used = state.harvestBatches
    .filter((h) => h.wineryId === wineryId && h.harvestBatchCode.startsWith(`HARV-${year}-`))
    .map((h) => Number(h.harvestBatchCode.split('-').at(-1)))
    .filter((n) => Number.isInteger(n))
  const seq = (used.length > 0 ? Math.max(...used) : 0) + 1
  return `HARV-${year}-${slug || 'LOTE'}-${String(seq).padStart(3, '0')}`
}

export interface LotEventInput {
  type: LotEventType
  /** Fecha del hecho (declarada). */
  occurredAt: string
  /** Etapa tras el evento (por defecto, la del lote). */
  stage?: LotStageCode
  actor?: TraceActor | null
  summary: string
  data?: Record<string, unknown>
  resource: { type: string; id: string }
  recordedAt?: string
}

/** Añade un evento a la línea de tiempo del lote, con `seq` consecutivo. */
export function appendLotEvent(state: TraceState, ctx: TraceCtx, lot: Lot, input: LotEventInput): StoredLotEvent {
  const recordedAt = input.recordedAt ?? ctx.now
  const seq = state.lotEvents.filter((e) => e.lotId === lot.id).reduce((max, e) => Math.max(max, e.seq), 0) + 1
  const event: StoredLotEvent = {
    lotId: lot.id,
    id: ctx.newId('lot-event'),
    seq,
    type: input.type,
    occurredAt: input.occurredAt,
    recordedAt,
    lateEntry: daysBetween(dayOf(input.occurredAt), laPazDate(recordedAt)) > 7,
    stage: input.stage ?? lot.stage,
    actor: input.actor === undefined ? ctx.actor : input.actor,
    summary: input.summary,
    data: input.data ?? {},
    resource: input.resource,
    visibility: PUBLIC_LOT_EVENT_TYPES.includes(input.type) ? 'PUBLIC' : 'INTERNAL',
    corrected: false,
  }
  state.lotEvents.push(event)
  return event
}

/** Etapa del lote según sus registros (§2.2). */
export function computeStage(state: TraceState, lot: Lot): LotStageCode {
  return deriveLotStage({
    discarded: lot.discarded !== null,
    dossierClosed: lotDossier(state, lot.id)?.status === 'CLOSED',
    productType: lot.productType,
    harvestStatuses: lotHarvests(state, lot.id).map((h) => h.phytosanitaryStatus),
    tanks: lotTanks(state, lot.id).length,
    agings: lotAgings(state, lot.id).map((a) => ({ discarded: a.agingStatus === 'DISCARDED' })),
    distillations: lotProductions(state, lot.id).map((p) => ({ closed: Boolean(p.processEndDate), discarded: p.restStatus === 'DISCARDED' })),
    bottled: lotBottling(state, lot.id) !== null,
  })
}

/**
 * Recalcula la etapa tras una escritura y marca el lote como actualizado. Si todos sus pesajes
 * quedaron rechazados, lo anota en la línea de tiempo (`LOT_REJECTED`, S-5).
 */
export function refreshLotStage(state: TraceState, ctx: TraceCtx, lot: Lot, at: string = ctx.now): LotStageCode {
  const stage = computeStage(state, lot)
  if (stage !== lot.stage) {
    lot.stage = stage
    lot.stageChangedAt = at
    if (stage === 'REJECTED') {
      appendLotEvent(state, ctx, lot, {
        type: 'LOT_REJECTED',
        occurredAt: at,
        actor: null,
        summary: 'Lote rechazado: todos sus pesajes tienen dictamen negativo',
        resource: { type: 'lot', id: lot.id },
      })
    }
  }
  if (at > lot.updatedAt) lot.updatedAt = at
  return stage
}

function projectedBottles(state: TraceState, lot: Lot): { bottles: number | null; basis: 'DECLARED' | 'MUST' | 'BASE_WINE' | 'DISTILLATE' | 'BOTTLED' } {
  const bottleLot = bottleLotOf(state, lot.id)
  if (lotBottling(state, lot.id)) return { bottles: bottleCodesSummary(bottleLot).active, basis: 'BOTTLED' }
  const factor = 1 - lot.rules.bottling.maxLossPercent / 100
  const format = lot.plannedFormatCl
  if (format && format > 0) {
    const perBottle = format / 100
    if (lot.productType === 'SINGANI') {
      const hearts = lotProductions(state, lot.id)
        .filter((p) => p.restStatus !== 'DISCARDED' && p.processEndDate)
        .map(distillationHeart)
      if (lot.targetAbvPercent && hearts.length > 0 && hearts.every((h) => h.liters !== null && h.abv !== null)) {
        const pure = hearts.reduce((s, h) => s + ((h.liters as number) * (h.abv as number)) / 100, 0)
        return { bottles: Math.floor((((pure * 100) / lot.targetAbvPercent) * factor) / perBottle), basis: 'DISTILLATE' }
      }
    } else if (lot.productType === 'WINE') {
      const aging = lotAgings(state, lot.id)
        .filter((a) => a.agingStatus !== 'DISCARDED')
        .map((a) => a.volumeLiters ?? null)
      if (aging.length > 0 && aging.every((v) => v !== null)) {
        return { bottles: Math.floor(((aging as number[]).reduce((s, v) => s + v, 0) * factor) / perBottle), basis: 'BASE_WINE' }
      }
      const tanks = lotTanks(state, lot.id)
      const liters = tanks.map(tankLiters)
      if (tanks.length > 0 && liters.every((v) => v !== null)) {
        const basis = tanks.every((t) => t.finalVolumeLiters !== null) ? 'BASE_WINE' : 'MUST'
        return { bottles: Math.floor(((liters as number[]).reduce((s, v) => s + v, 0) * factor) / perBottle), basis }
      }
    }
  }
  return { bottles: lot.estimatedBottles ?? null, basis: 'DECLARED' }
}

/** Proyección de botellas del lote y la etapa de la que sale (S-19). */
export const lotProjection = projectedBottles

/** D.O. del lote con su instantánea: sobre todos sus pesajes (o las parcelas previstas si aún no hay ninguno). */
export function lotDenomination(state: TraceState, lot: Lot, evaluatedAt: string): DoEvaluation {
  if (lot.productType !== 'SINGANI') return { status: 'NOT_APPLICABLE', checks: [], rulesSource: 'LOT_SNAPSHOT', evaluatedAt }
  const harvests = lotHarvests(state, lot.id)
  const terroirs =
    harvests.length > 0
      ? harvests.map((h) => harvestTerroir(state, h))
      : state.terroirs.filter((t) => lot.plannedTerroirIds.includes(t.id)).map((t) => ({ id: t.id, altitudeMasl: t.altitudeMasl, varietyName: t.varietyName }))
  return evaluateDo(terroirs, doRulesFromLot(lot.rules), 'LOT_SNAPSHOT', evaluatedAt)
}

/** Resumen del lote (`LotSummaryDto`) con sus campos calculados al día de hoy. */
export function toLotSummary(state: TraceState, lot: Lot, ctx: Pick<TraceCtx, 'today'>): LotSummary {
  const harvests = lotHarvests(state, lot.id)
  const count = (status: string) => harvests.filter((h) => h.phytosanitaryStatus === status).length
  const lab = currentLab(state, lot.id)
  const bottled = lotBottling(state, lot.id) !== null
  const locks = lotLocks(state, lot, ctx.today)
  return {
    id: lot.id,
    wineryId: lot.wineryId,
    reference: lot.reference,
    lotCode: lot.lotCode,
    name: lot.name,
    productType: lot.productType,
    stage: lot.stage,
    stageChangedAt: lot.stageChangedAt,
    awaitingBifurcation: lot.stage === 'FERMENTING' && lotTanks(state, lot.id).some((t) => t.status === 'COMPLETED' && !t.destinationType),
    harvestYear: lot.harvestYear,
    estimatedBottles: lot.estimatedBottles,
    projectedBottles: projectedBottles(state, lot).bottles,
    bottles: bottled ? bottleCodesSummary(bottleLotOf(state, lot.id)).active : null,
    nextLock: nextLock(locks),
    phyto: { pending: count('PENDING_INSPECTION'), quarantine: count('QUARANTINE'), approved: count('APPROVED'), rejected: count('REJECTED') },
    labStatus: lab?.conformityStatus ?? 'NOT_RECORDED',
    dossierStatus: lotDossier(state, lot.id)?.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    complianceIssuesOpen: lot.complianceIssues.filter((i) => !i.resolvedAt).length,
    createdAt: lot.createdAt,
    updatedAt: lot.updatedAt,
  }
}

/** Detalle del lote (`LotDto`) con sus campos calculados al día de hoy. */
export function toLotView(state: TraceState, lot: Lot, ctx: Pick<TraceCtx, 'today' | 'now'>): Lot {
  const locks = lotLocks(state, lot, ctx.today)
  const readyByLock = readyDateFromLocks(locks)
  return {
    ...toLotSummary(state, lot, ctx),
    plannedTerroirIds: [...lot.plannedTerroirIds],
    plannedFormatCl: lot.plannedFormatCl,
    targetAbvPercent: lot.targetAbvPercent,
    targetReadyDate: lot.targetReadyDate,
    estimatedReadyDate: readyByLock ?? lot.targetReadyDate,
    estimatedReadyBasis: readyByLock ? 'LOCK' : lot.targetReadyDate ? 'DECLARED' : null,
    estimatedBottlesHistory: lot.estimatedBottlesHistory,
    locks,
    rules: lot.rules,
    denomination: lotDenomination(state, lot, ctx.now),
    complianceIssues: lot.complianceIssues,
    links: {
      harvestBatchIds: lotHarvests(state, lot.id).map((h) => h.id),
      tankIds: lotTanks(state, lot.id).map((t) => t.id),
      wineAgingBatchIds: lotAgings(state, lot.id).map((a) => a.id),
      productionBatchIds: lotProductions(state, lot.id).map((p) => p.id),
      bottlingBatchId: lotBottling(state, lot.id)?.id ?? null,
      labAnalysisIds: state.labAnalyses.filter((l) => l.lotId === lot.id).sort(byText((l) => l.createdAt)).map((l) => l.id),
    },
    discarded: lot.discarded,
    notes: lot.notes,
    createdBy: lot.createdBy,
  }
}

/** `productType` del cuerpo: solo `WINE` o `SINGANI` en el MVP (S-1); otro → 422 `TRC_PRODUCT_NOT_SUPPORTED`. */
export function parseProductType(value: string | undefined | null, field = 'productType'): LotProductType | null {
  if (value === undefined || value === null) return null
  if (value === 'WINE' || value === 'SINGANI') return value
  throw ruleError('TRC_PRODUCT_NOT_SUPPORTED', `El lote solo admite vino o singani (recibido: ${value})`, [
    violation('TRC_PRODUCT_NOT_SUPPORTED', 'Tipo de producto no admitido', { field, expected: ['WINE', 'SINGANI'], actual: value }),
  ])
}

export interface CreateLotOptions {
  /** Id fijo (lotes migrados: UUID v5 de `lot:{harvestBatchId}`; fixtures). */
  id?: string
  origin?: LotRules['origin']
  /** Fecha de alta (lotes migrados: la del pesaje). */
  createdAt?: string
  /** Prefijo de los campos en los errores (`newLot` cuando el lote nace del pesaje o del tanque). */
  field?: string
  summary?: string
}

/**
 * Crea un lote con la instantánea de las reglas vigentes (§2.3–§2.4): tipo admitido, añada no
 * futura, parcelas previstas de la bodega y, si es singani, su D.O. con la instantánea recién tomada.
 */
export function createLot(state: TraceState, ctx: TraceCtx, wineryId: string, body: Omit<CreateLotDto, 'productType'> & { productType?: string | null }, options: CreateLotOptions = {}): Lot {
  const at = (name: string) => (options.field ? `${options.field}.${name}` : name)
  const productType = parseProductType(body.productType, at('productType'))
  const year = Number(ctx.today.slice(0, 4))
  if (body.harvestYear > year) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', [
      { field: at('harvestYear'), message: `La añada no puede ser posterior al año actual (${year})` },
    ])
  }
  const plannedIds = [...new Set(body.plannedTerroirIds ?? [])]
  const planned = plannedIds.map((id) => state.terroirs.find((t) => t.id === id && t.wineryId === wineryId))
  const missing = plannedIds.filter((_, i) => !planned[i])
  if (missing.length > 0) {
    throw new ApiError(
      422,
      'VALIDATION_ERROR',
      'Los datos enviados no son válidos',
      missing.map((id) => ({ field: at('plannedTerroirIds'), message: `La parcela ${id} no existe en esta bodega` })),
    )
  }
  const rules = buildLotRules(ctx.snapshot(wineryId), options.origin ?? 'LOT_CREATION')
  if (productType === 'SINGANI' && planned.length > 0) {
    const terroirs = planned as TerroirResponse[]
    const evaluation = evaluateDo(terroirs.map((t) => ({ id: t.id, altitudeMasl: t.altitudeMasl, varietyName: t.varietyName })), doRulesFromLot(rules), 'LOT_SNAPSHOT', ctx.now)
    if (evaluation.status === 'NOT_ELIGIBLE') {
      const names = Object.fromEntries(terroirs.map((t) => [t.id, t.parcelName]))
      throw ruleError(
        'TRC_DO_TERROIR_NOT_ELIGIBLE',
        'Una parcela prevista no es apta para la D.O. Singani',
        doViolations(evaluation, 'TRC_DO_TERROIR_NOT_ELIGIBLE', names).map((d) => ({ ...d, field: at('plannedTerroirIds') })),
      )
    }
  }
  const createdAt = options.createdAt ?? ctx.now
  const id = options.id ?? ctx.newId('lot')
  const base: Lot = {
    id,
    wineryId,
    reference: nextLotReference(state, ctx, wineryId, body.harvestYear),
    lotCode: null,
    name: body.name.trim(),
    productType,
    stage: 'ORIGIN',
    stageChangedAt: createdAt,
    awaitingBifurcation: false,
    harvestYear: body.harvestYear,
    estimatedBottles: body.estimatedBottles ?? null,
    projectedBottles: body.estimatedBottles ?? null,
    bottles: null,
    nextLock: null,
    phyto: { pending: 0, quarantine: 0, approved: 0, rejected: 0 },
    labStatus: 'NOT_RECORDED',
    dossierStatus: 'OPEN',
    complianceIssuesOpen: 0,
    createdAt,
    updatedAt: createdAt,
    plannedTerroirIds: plannedIds,
    plannedFormatCl: body.plannedFormatCl ?? null,
    targetAbvPercent: body.targetAbvPercent ?? null,
    targetReadyDate: body.targetReadyDate ?? null,
    estimatedReadyDate: body.targetReadyDate ?? null,
    estimatedReadyBasis: body.targetReadyDate ? 'DECLARED' : null,
    estimatedBottlesHistory:
      body.estimatedBottles !== undefined ? [{ value: body.estimatedBottles, at: createdAt, by: options.origin === 'MIGRATION' ? null : ctx.actor, reason: null }] : [],
    locks: [],
    rules,
    denomination: { status: 'NOT_APPLICABLE', checks: [], rulesSource: 'LOT_SNAPSHOT', evaluatedAt: ctx.now },
    complianceIssues: [],
    links: { harvestBatchIds: [], tankIds: [], wineAgingBatchIds: [], productionBatchIds: [], bottlingBatchId: null, labAnalysisIds: [] },
    discarded: null,
    notes: body.notes ?? null,
    createdBy: options.origin === 'MIGRATION' ? null : ctx.actor,
  }
  state.lots.push(base)
  appendLotEvent(state, ctx, base, {
    type: 'LOT_CREATED',
    occurredAt: createdAt,
    recordedAt: createdAt,
    actor: base.createdBy,
    summary: options.summary ?? `Lote ${base.reference} creado: ${base.name}`,
    data: { reference: base.reference, productType, harvestYear: base.harvestYear, estimatedBottles: base.estimatedBottles, rulesTakenAt: rules.takenAt },
    resource: { type: 'lot', id },
  })
  return base
}

/** Reglas D.O. vigentes de una bodega (parcelas: `rulesSource: EFFECTIVE_SETTINGS`). */
export function effectiveDoRules(ctx: TraceCtx, wineryId: string): DoRules {
  return doRulesFromLot(buildLotRules(ctx.snapshot(wineryId), 'LOT_CREATION'))
}

/** Aptitud D.O. de una parcela con los valores vigentes de su bodega (§3.1). */
export function terroirDoEvaluation(ctx: TraceCtx, t: TerroirResponse): DoEvaluation {
  return evaluateDo([{ id: t.id, altitudeMasl: t.altitudeMasl, varietyName: t.varietyName }], effectiveDoRules(ctx, t.wineryId), 'EFFECTIVE_SETTINGS', ctx.now)
}

/**
 * Tarea diaria `trace.locks.release` (§15): pasa a `READY` las crianzas y destilaciones con el
 * candado cumplido según la instantánea y lo anota en la línea de tiempo (`LOCK_RELEASED`, actor
 * sistema). Idempotente; nunca es la única defensa: el embotellado recalcula el candado.
 */
export function releaseLocks(state: TraceState, ctx: TraceCtx, onlyLotId?: string): number {
  let released = 0
  for (const lot of state.lots) {
    if (onlyLotId && lot.id !== onlyLotId) continue
    if (TERMINAL_LOT_STAGES.includes(lot.stage) || lot.stage === 'BOTTLED') continue
    for (const a of lotAgings(state, lot.id)) {
      if (a.agingStatus !== 'AGING') continue
      const lock = agingLockOf(a, lot.rules, ctx.today)
      if (!lock.released) continue
      a.agingStatus = 'READY'
      released++
      appendLotEvent(state, ctx, lot, {
        type: 'LOCK_RELEASED',
        occurredAt: `${lock.unlockDate}T04:05:00Z`,
        actor: null,
        summary: `Crianza cumplida: ${lock.rule.applied} meses desde el ${agingStartDay(a)}`,
        data: { kind: 'AGING', unlockDate: lock.unlockDate, sourceId: a.id },
        resource: { type: 'wine_aging_batch', id: a.id },
      })
    }
    for (const p of lotProductions(state, lot.id)) {
      if (p.restStatus !== 'RESTING') continue
      const lock = restLockOf(p, lot.rules, ctx.today)
      if (!lock?.released) continue
      p.restStatus = 'READY'
      released++
      appendLotEvent(state, ctx, lot, {
        type: 'LOCK_RELEASED',
        occurredAt: `${lock.unlockDate}T04:05:00Z`,
        actor: null,
        summary: `Reposo cumplido: ${lock.rule.applied} días tras la destilación`,
        data: { kind: 'REST', unlockDate: lock.unlockDate, sourceId: p.id },
        resource: { type: 'production_batch', id: p.id },
      })
    }
  }
  return released
}

/** Añade una incidencia de cumplimiento abierta al lote. */
export function addComplianceIssue(
  ctx: TraceCtx,
  lot: Lot,
  issue: { code: string; message: string; source: 'MIGRATION' | 'CORRECTION' | 'RULES_REEVALUATION'; details: ApiErrorDetail[] },
): void {
  lot.complianceIssues.push({ id: ctx.newId('compliance-issue'), ...issue, detectedAt: ctx.now, resolvedAt: null })
}

export { formatQuantity }
