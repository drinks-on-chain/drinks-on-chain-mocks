import type { ApiErrorDetail } from '../../shared/envelope'
import { sha256Hex } from '../../shared/crypto'
import { ApiError } from '../handlers/errors'
import type {
  BatchLabAnalysisResponse,
  BottleUnit,
  BottlingBalance,
  BottlingBatchResponse,
  CreateBatchLabAnalysisDto,
  CreateLotBottlingDto,
  CreateLotLabAnalysisDto,
  Lot,
  LotLockInfo,
  LotProductType,
  ProductionBatchResponse,
  WineAgingResponse,
} from '../schemas'
import { BOTTLE_CODES_CSV_COLUMNS } from '../schemas/bottle-codes'
import { formatBottleCode, isValidBottleCode, mockBottleCode, normalizeBottleCode } from './bottle-code'
import { dayOf, toDateField } from './dates'
import { bottlingBalanceViolations, computeBottlingBalance, computeLabConformity, methanolToAnhydrous, type BottlingBalanceInput } from './domain'
import { assertOwnFile } from './records'
import { formatQuantity, violation } from './rules'
import {
  agingLockOf,
  appendLotEvent,
  assertLotWritable,
  assertNotBefore,
  assertNotFuture,
  bottleCodeOf,
  bottleGeneration,
  bottleLotOf,
  distillationHeart,
  isAgingOpen,
  isProductionOpen,
  isSerialVoided,
  lotAgings,
  lotBottling,
  lotDossier,
  lotLabs,
  lotProductions,
  nextLotCode,
  refreshLotStage,
  restLockOf,
  stateError,
  throwViolations,
  type BottleLot,
  type TraceCtx,
  type TraceState,
} from './state'

// Embotellado seguro (contrato de la Ola 2 §6), códigos de botella (§7) y laboratorio con
// conformidad calculada (§8). Puerto de `bottling-engine.ts` del backend: mismas reglas y orden.

export interface BottlingSourceRef {
  kind: 'AGING' | 'REST'
  id: string
  /** Litros que entran (por defecto, todo lo disponible de la fuente). */
  liters?: number
}

export interface BottlingRequest {
  sources: BottlingSourceRef[]
  /** Ruta legada: el tipo enviado (se compara con el derivado, EA-01). */
  declaredProductType?: string
  bottlingDate: string
  packagingFormatCl: number
  totalBottlesPackaged: number
  finalAlcoholAbv: number
  waterDilutionLiters?: number
  leftover?: { liters: number; disposition: 'RETAINED' | 'DISCARDED'; notes?: string }
  bottleType?: string
  labelDesignKey?: string
  labelDesignUrl?: string
}

export interface BottlingEvaluation {
  valid: boolean
  productType: LotProductType | null
  balance: BottlingBalance
  violations: ApiErrorDetail[]
  locks: LotLockInfo[]
  bottlingDay: string
  availableLiters: number | null
}

/** URL del pasaporte: `{PASSPORT_BASE_URL}/b/{código}` (OP-06, ERP-16). */
export const passportUrl = (baseUrl: string, code: string): string => `${baseUrl.replace(/\/+$/, '')}/b/${encodeURIComponent(code)}`

/** Fuentes abiertas del lote (ni embotelladas ni descartadas). */
export function openSources(state: TraceState, lotId: string): BottlingSourceRef[] {
  return [
    ...lotAgings(state, lotId).filter(isAgingOpen).map((a) => ({ kind: 'AGING' as const, id: a.id })),
    ...lotProductions(state, lotId).filter(isProductionOpen).map((p) => ({ kind: 'REST' as const, id: p.id })),
  ]
}

/** Cuerpo de `POST /v1/lots/{id}/bottling` → petición del motor (sin `sources`, todas las abiertas del lote). */
export function lotBottlingRequest(state: TraceState, lot: Lot, body: CreateLotBottlingDto): BottlingRequest {
  const sources: BottlingSourceRef[] = body.sources
    ? body.sources.map((s) => (s.wineAgingBatchId ? { kind: 'AGING', id: s.wineAgingBatchId, liters: s.liters } : { kind: 'REST', id: s.productionBatchId as string, liters: s.liters }))
    : openSources(state, lot.id)
  return {
    sources,
    bottlingDate: body.bottlingDate,
    packagingFormatCl: body.packagingFormatCl,
    totalBottlesPackaged: body.totalBottlesPackaged,
    finalAlcoholAbv: body.finalAlcoholAbv,
    waterDilutionLiters: body.waterDilutionLiters,
    leftover: body.leftover,
    bottleType: body.bottleType,
    labelDesignKey: body.labelDesignKey,
    labelDesignUrl: body.labelDesignUrl,
  }
}

/** Un embotellado por lote (S-10): 409 `TRC_LOT_ALREADY_BOTTLED`. */
export function assertNotBottled(state: TraceState, lot: Lot): void {
  const existing = lotBottling(state, lot.id)
  if (!existing) return
  throw stateError('TRC_LOT_ALREADY_BOTTLED', `El lote ya se embotelló (${existing.internationalLotCode}): solo admite un embotellado`, [
    violation('TRC_LOT_ALREADY_BOTTLED', 'Segundo embotellado del lote', { meta: { bottlingBatchId: existing.id, lotCode: existing.internationalLotCode } }),
  ])
}

type SourceRow = {
  kind: 'AGING' | 'REST'
  id: string
  lotId: string | null
  status: string
  discarded: boolean
  liters: number | null
  heartAbv: number | null
  lock: LotLockInfo | null
  closed: boolean
}

/**
 * Reglas del embotellado seguro (§6.2), en su orden: tipo derivado del origen (EA-01), candados con
 * el reloj del servidor y la instantánea, fuentes pendientes, balance de volumen con la merma de
 * la instantánea (EA-02), balance de alcohol, vino sin agua e incidencias abiertas. No escribe
 * nada: la usan la vista previa y el alta.
 */
export function evaluateBottling(state: TraceState, ctx: TraceCtx, lot: Lot, request: BottlingRequest): BottlingEvaluation {
  const violations: ApiErrorDetail[] = []
  const bottlingDay = dayOf(request.bottlingDate)
  const requested: SourceRow[] = []
  for (const ref of request.sources) {
    const field = ref.kind === 'AGING' ? 'wineAgingBatchId' : 'productionBatchId'
    if (ref.kind === 'AGING') {
      const a: WineAgingResponse | undefined = state.wineAgings.find((x) => x.id === ref.id && x.wineryId === lot.wineryId)
      if (!a) {
        violations.push(violation('TRC_BOTTLING_SOURCE_INVALID', 'La fuente no existe en esta bodega', { field, meta: { sourceId: ref.id } }))
        continue
      }
      requested.push({ kind: 'AGING', id: a.id, lotId: a.lotId, status: a.agingStatus, discarded: a.agingStatus === 'DISCARDED', liters: a.volumeLiters ?? null, heartAbv: null, lock: agingLockOf(a, lot.rules, ctx.today), closed: true })
    } else {
      const p: ProductionBatchResponse | undefined = state.productionBatches.find((x) => x.id === ref.id && x.wineryId === lot.wineryId)
      if (!p) {
        violations.push(violation('TRC_BOTTLING_SOURCE_INVALID', 'La fuente no existe en esta bodega', { field, meta: { sourceId: ref.id } }))
        continue
      }
      const heart = distillationHeart(p)
      requested.push({ kind: 'REST', id: p.id, lotId: p.lotId, status: p.restStatus, discarded: p.restStatus === 'DISCARDED', liters: heart.liters, heartAbv: heart.abv, lock: restLockOf(p, lot.rules, ctx.today), closed: Boolean(p.processEndDate) })
    }
  }

  // 1. Tipo derivado del origen (EA-01)
  const kinds = new Set(requested.map((s) => s.kind))
  let productType: LotProductType | null = null
  if (kinds.size > 1) {
    violations.push(violation('TRC_BOTTLING_SOURCE_INVALID', 'Un embotellado no mezcla crianzas y destilaciones', { field: 'sources', meta: { sourceIds: requested.map((s) => s.id) } }))
  } else if (kinds.size === 1) {
    productType = kinds.has('AGING') ? 'WINE' : 'SINGANI'
  }
  if (productType && lot.productType && productType !== lot.productType) {
    violations.push(violation('TRC_BOTTLING_SOURCE_INVALID', `El lote es ${lot.productType} y la fuente es de ${productType}`, { field: 'sources', expected: lot.productType, actual: productType }))
  }
  if (request.declaredProductType !== undefined && productType && request.declaredProductType !== productType) {
    violations.push(
      violation('TRC_PRODUCT_TYPE_MISMATCH', `El tipo de producto se deriva del origen: ${productType === 'WINE' ? 'crianza → WINE' : 'destilación → SINGANI'}`, {
        field: 'productType',
        expected: productType,
        actual: request.declaredProductType,
      }),
    )
  }
  for (const s of requested) {
    if (s.lotId !== lot.id) {
      violations.push(violation('TRC_BOTTLING_SOURCE_INVALID', 'La fuente es de otro lote', { field: 'sources', meta: { sourceId: s.id } }))
    } else if (s.discarded || s.status === 'BOTTLED') {
      violations.push(violation('TRC_BOTTLING_SOURCE_INVALID', `La fuente está ${s.status}`, { field: 'sources', meta: { sourceId: s.id, status: s.status } }))
    } else if (s.kind === 'REST' && !s.closed) {
      violations.push(violation('TRC_BOTTLING_SOURCE_INVALID', 'La destilación aún no está cerrada', { field: 'sources', meta: { sourceId: s.id } }))
    }
  }

  // Fecha del embotellado: no futura
  if (bottlingDay > ctx.today) {
    violations.push(violation('TRC_DATE_IN_FUTURE', 'La fecha de embotellado no puede ser futura', { field: 'bottlingDate', expected: ctx.today, actual: bottlingDay }))
  }

  // 2. Candados: liberados hoy (reloj del servidor) y a la fecha del embotellado
  const locks = requested.flatMap((s) => (s.lock ? [s.lock] : []))
  for (const lock of locks) {
    if (!lock.released || lock.unlockDate > bottlingDay) {
      const label = lock.kind === 'REST' ? `Reposo mínimo de ${lock.rule.applied} días` : `Crianza de ${lock.rule.applied} meses`
      violations.push(
        violation('TRC_LOCK_NOT_RELEASED', `${label}: disponible el ${lock.unlockDate}${lock.daysRemaining > 0 ? ` (faltan ${lock.daysRemaining} días)` : ''}`, {
          field: 'bottlingDate',
          rule: lock.rule.settingKey,
          expected: lock.unlockDate,
          actual: lock.released ? bottlingDay : ctx.today,
          meta: { sourceId: lock.sourceId, kind: lock.kind, unlockDate: lock.unlockDate, daysRemaining: lock.daysRemaining },
        }),
      )
    }
  }

  // 3. Fuentes abiertas del lote sin incluir (S-10: un embotellado por lote)
  const included = new Set(requested.map((s) => s.id))
  const pending = openSources(state, lot.id)
    .map((s) => s.id)
    .filter((id) => !included.has(id))
  if (pending.length > 0) {
    violations.push(
      violation('TRC_BOTTLING_SOURCES_PENDING', 'El lote tiene fuentes abiertas que no entran en el embotellado: inclúyelas o descártalas antes', {
        field: 'sources',
        meta: { sourceIds: pending },
      }),
    )
  }

  // 4–6. Balance de volumen, merma, alcohol y agua
  const liters = requested.map((s) => request.sources.find((r) => r.id === s.id)?.liters ?? s.liters)
  const missing = requested.filter((_, i) => liters[i] === null || liters[i] === undefined)
  requested.forEach((s, i) => {
    const want = request.sources.find((r) => r.id === s.id)?.liters
    if (want !== undefined && s.liters !== null && want > s.liters + 1e-6) {
      violations.push(
        violation('TRC_VOLUME_EXCEEDS_AVAILABLE', `La fuente tiene ${formatQuantity(s.liters, 3)} L`, {
          field: `sources.${i}.liters`,
          expected: s.liters,
          actual: want,
          meta: { sourceId: s.id, available: s.liters, requested: want, unit: 'L' },
        }),
      )
    }
  })
  const available = liters.reduce<number>((sum, l) => sum + (l ?? 0), 0)
  const heartPure =
    requested.length > 0 && requested.every((s) => s.kind === 'REST' && s.heartAbv !== null)
      ? requested.reduce((sum, s, i) => sum + ((liters[i] ?? 0) * (s.heartAbv ?? 0)) / 100, 0)
      : null
  const input: BottlingBalanceInput = {
    productType: productType ?? lot.productType ?? 'WINE',
    availableLiters: available,
    waterDilutionLiters: request.waterDilutionLiters ?? 0,
    bottles: request.totalBottlesPackaged,
    formatCl: request.packagingFormatCl,
    leftoverLiters: request.leftover?.liters ?? 0,
    maxLossPercent: lot.rules.bottling.maxLossPercent,
    finalAbv: request.finalAlcoholAbv,
    pureAlcoholAvailableLiters: heartPure,
  }
  const balance = computeBottlingBalance(input)
  if (missing.length > 0) {
    violations.push(
      violation('TRC_VOLUME_MISSING', 'La fuente no tiene volumen registrado: no se puede verificar el balance', { field: 'sources', meta: { sourceIds: missing.map((s) => s.id) } }),
    )
  } else if (requested.length > 0) {
    violations.push(...bottlingBalanceViolations(input, balance))
  }

  // 7. Incidencias de cumplimiento abiertas
  const issues = lot.complianceIssues.filter((i) => !i.resolvedAt).map((i) => i.id)
  if (issues.length > 0) {
    violations.push(violation('TRC_COMPLIANCE_ISSUES_OPEN', 'El lote tiene incidencias de cumplimiento abiertas: corrígelas antes de embotellar', { meta: { issueIds: issues } }))
  }

  return { valid: violations.length === 0, productType, balance, violations, locks, bottlingDay, availableLiters: missing.length > 0 ? null : available }
}

/** Asigna las series `1…total` del lote: si un código determinista ya existe en la plataforma, pasa a la generación siguiente. */
export function allocateBottleLot(state: TraceState, lotId: string, bottlingBatchId: string, total: number): BottleLot {
  const taken = bottleIndex(state)
  const generations: Record<string, number> = {}
  for (let serial = 1; serial <= total; serial++) {
    let generation = 0
    while (taken.has(mockBottleCode(lotId, serial, generation))) generation++
    if (generation > 0) generations[String(serial)] = generation
  }
  const bottleLot: BottleLot = { lotId, bottlingBatchId, total, generations, voided: [], allVoided: null, exports: [] }
  state.bottleLots.push(bottleLot)
  return bottleLot
}

/**
 * Registra el embotellado ya evaluado (§6.2.8): código de lote sin carreras, URL del QR, fuentes y
 * tanques a estados terminales, lote a `BOTTLED` y un código por botella.
 */
export function executeBottling(state: TraceState, ctx: TraceCtx, lot: Lot, request: BottlingRequest, evaluation: BottlingEvaluation): BottlingBatchResponse {
  const productType = evaluation.productType as LotProductType
  const lotCode = nextLotCode(state, ctx, lot.wineryId, Number(evaluation.bottlingDay.slice(0, 4)), productType)
  const single = request.sources.length === 1 ? request.sources[0] : undefined
  const labelKey = request.labelDesignKey ?? request.labelDesignUrl ?? null
  const bottling: BottlingBatchResponse = {
    id: ctx.newId('bottling'),
    wineryId: lot.wineryId,
    wineAgingBatchId: single?.kind === 'AGING' ? single.id : null,
    productionBatchId: single?.kind === 'REST' ? single.id : null,
    productType,
    internationalLotCode: lotCode,
    finalAlcoholAbv: request.finalAlcoholAbv,
    waterDilutionLiters: request.waterDilutionLiters ?? null,
    totalBottlesPackaged: request.totalBottlesPackaged,
    packagingFormatCl: request.packagingFormatCl,
    bottleType: request.bottleType ?? null,
    labelDesignUrl: request.labelDesignUrl ?? null,
    bottlingDate: toDateField(evaluation.bottlingDay),
    releasedByMemberId: ctx.actor?.membershipId ?? null,
    blockchainAnchorTxHash: null,
    // El hash que vale es el del expediente (§10): ya no se calcula aquí.
    blockchainDataHash: null,
    isAnchoredOnChain: false,
    anchoredAt: null,
    qrBatchUrl: passportUrl(ctx.passportBaseUrl, lotCode),
    createdAt: ctx.now,
    lotId: lot.id,
    balance: evaluation.balance,
    leftover: request.leftover ? { liters: request.leftover.liters, disposition: request.leftover.disposition, notes: request.leftover.notes ?? null } : null,
    labelDesign: labelKey ? { key: labelKey, url: request.labelDesignUrl ?? null } : null,
  }
  state.bottlings.push(bottling)

  // Estados terminales de las fuentes y sus tanques
  const tankIds = new Set<string>()
  for (const ref of request.sources) {
    if (ref.kind === 'AGING') {
      const a = state.wineAgings.find((x) => x.id === ref.id)
      if (a) {
        a.agingStatus = 'BOTTLED'
        tankIds.add(a.fermentationTankId)
      }
    } else {
      const p = state.productionBatches.find((x) => x.id === ref.id)
      if (p) {
        p.restStatus = 'BOTTLED'
        tankIds.add(p.fermentationTankId)
      }
    }
  }
  for (const tank of state.tanks) {
    if (tankIds.has(tank.id) && (tank.status === 'FILLING' || tank.status === 'FERMENTING' || tank.status === 'COMPLETED')) tank.status = 'TRANSFERRED'
  }
  lot.lotCode = lotCode
  refreshLotStage(state, ctx, lot)
  const resource = { type: 'bottling_batch', id: bottling.id }
  appendLotEvent(state, ctx, lot, {
    type: 'BOTTLED',
    occurredAt: bottling.bottlingDate,
    summary: `Embotellado de ${formatQuantity(request.totalBottlesPackaged)} botellas de ${request.packagingFormatCl} cL al ${String(request.finalAlcoholAbv).replace('.', ',')} % (${lotCode})`,
    data: { lotCode, bottles: request.totalBottlesPackaged, formatCl: request.packagingFormatCl, finalAlcoholAbv: request.finalAlcoholAbv, balance: evaluation.balance },
    resource,
  })
  allocateBottleLot(state, lot.id, bottling.id, request.totalBottlesPackaged)
  appendLotEvent(state, ctx, lot, {
    type: 'BOTTLE_CODES_GENERATED',
    occurredAt: ctx.now,
    summary: `${formatQuantity(request.totalBottlesPackaged)} códigos de botella generados`,
    data: { count: request.totalBottlesPackaged },
    resource,
  })
  return bottling
}

/** Embotella el lote: evalúa las reglas y, si alguna falla, responde 422 con todas las violaciones. */
export function bottleLot(state: TraceState, ctx: TraceCtx, lot: Lot, request: BottlingRequest): BottlingBatchResponse {
  assertLotWritable(lot)
  assertNotBottled(state, lot)
  if (request.sources.length === 0) {
    throw stateError('TRC_INVALID_STAGE', `El lote está en etapa ${lot.stage}: aún no tiene nada que embotellar`, [
      violation('TRC_INVALID_STAGE', 'Lote sin crianzas ni destilaciones abiertas', { meta: { stage: lot.stage, allowed: ['AGING', 'RESTING'] } }),
    ])
  }
  if (request.labelDesignKey) assertOwnFile(lot.wineryId, 'labelDesignKey', request.labelDesignKey)
  const evaluation = evaluateBottling(state, ctx, lot, request)
  throwViolations(evaluation.violations)
  return executeBottling(state, ctx, lot, request, evaluation)
}

// ---------------------------------------------------------------------------
// Códigos de botella (§7)
// ---------------------------------------------------------------------------

interface BottleRef {
  lotId: string
  serial: number
  generation: number
}

const indexCache = new WeakMap<BottleLot[], { signature: string; index: Map<string, BottleRef> }>()

/** Índice código → botella de toda la plataforma (códigos vigentes y anulados). Se recalcula si cambian los lotes. */
export function bottleIndex(state: TraceState): Map<string, BottleRef> {
  const signature = state.bottleLots.map((b) => `${b.lotId}:${b.total}:${b.voided.length}:${Object.keys(b.generations).length}`).join('|')
  const cached = indexCache.get(state.bottleLots)
  if (cached?.signature === signature) return cached.index
  const index = new Map<string, BottleRef>()
  for (const bl of state.bottleLots) {
    for (let serial = 1; serial <= bl.total; serial++) {
      const generation = bottleGeneration(bl, serial)
      index.set(mockBottleCode(bl.lotId, serial, generation), { lotId: bl.lotId, serial, generation })
    }
    for (const v of bl.voided) index.set(v.code, { lotId: bl.lotId, serial: v.serial, generation: v.generation })
  }
  indexCache.set(state.bottleLots, { signature, index })
  return index
}

/** Botella de un código ya normalizado, con su lote. */
export function findBottle(state: TraceState, code: string): { ref: BottleRef; bottleLot: BottleLot; lot: Lot } | null {
  const ref = bottleIndex(state).get(code)
  if (!ref) return null
  const bl = bottleLotOf(state, ref.lotId)
  const lot = state.lots.find((l) => l.id === ref.lotId)
  return bl && lot ? { ref, bottleLot: bl, lot } : null
}

function exportsOf(bl: BottleLot, serial: number): { count: number; first: string | null } {
  const hits = bl.exports.filter((e) => serial >= e.fromSerial && serial <= e.toSerial)
  return { count: hits.length, first: hits.length > 0 ? hits.map((e) => e.at).sort()[0]! : null }
}

/** `BottleUnitDto` de una serie y generación. */
export function bottleUnit(ctx: Pick<TraceCtx, 'passportBaseUrl'>, lot: Lot, bl: BottleLot, serial: number, generation = bottleGeneration(bl, serial)): BottleUnit {
  const code = mockBottleCode(bl.lotId, serial, generation)
  const own = bl.voided.find((v) => v.serial === serial && v.generation === generation)
  const voided = own
    ? { at: own.at, by: own.by, reason: own.reason, replacedBy: own.replacedBy }
    : bl.allVoided && bl.allVoided.by
      ? { at: bl.allVoided.at, by: bl.allVoided.by, reason: bl.allVoided.reason, replacedBy: null }
      : null
  const previous = generation > 0 ? bl.voided.find((v) => v.serial === serial && v.replacedBy === code) : undefined
  const exported = exportsOf(bl, serial)
  return {
    code,
    codeFormatted: formatBottleCode(code),
    serial,
    lotId: lot.id,
    lotCode: lot.lotCode ?? '',
    status: voided || bl.allVoided ? 'VOIDED' : 'ACTIVE',
    qrUrl: passportUrl(ctx.passportBaseUrl, code),
    voided,
    replaces: previous?.code ?? null,
    exportsCount: exported.count,
    firstExportedAt: exported.first,
  }
}

function assertBottled(state: TraceState, lot: Lot): BottleLot {
  const bl = bottleLotOf(state, lot.id)
  if (bl && lotBottling(state, lot.id)) return bl
  throw stateError('TRC_LOT_NOT_BOTTLED', 'El lote aún no está embotellado: no tiene códigos de botella', [
    violation('TRC_LOT_NOT_BOTTLED', 'Lote sin embotellar', { meta: { stage: lot.stage } }),
  ])
}

/** Rango de series `fromSerial…toSerial` dentro de `1…N`; inválido → 422 `VALIDATION_ERROR`. */
export function serialRange(bl: BottleLot, fromSerial?: number, toSerial?: number): { from: number; to: number } {
  const from = fromSerial ?? 1
  const to = toSerial ?? bl.total
  const details: ApiErrorDetail[] = []
  if (from < 1 || from > bl.total) details.push({ field: 'fromSerial', message: `fromSerial debe estar entre 1 y ${bl.total}` })
  if (to < 1 || to > bl.total) details.push({ field: 'toSerial', message: `toSerial debe estar entre 1 y ${bl.total}` })
  if (details.length === 0 && from > to) details.push({ field: 'fromSerial', message: 'fromSerial no puede ser mayor que toSerial' })
  if (details.length > 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', details)
  return { from, to }
}

/** Códigos del lote por número de serie (los anulados y sustituidos, antes del vigente de su serie). */
export function listBottleUnits(
  state: TraceState,
  ctx: Pick<TraceCtx, 'passportBaseUrl'>,
  lot: Lot,
  filter: { status?: 'ACTIVE' | 'VOIDED'; fromSerial?: number; toSerial?: number } = {},
): BottleUnit[] {
  const bl = assertBottled(state, lot)
  const { from, to } = serialRange(bl, filter.fromSerial, filter.toSerial)
  const replacedBySerial = new Map<number, number[]>()
  for (const v of bl.voided) {
    if (v.replacedBy === null) continue
    replacedBySerial.set(v.serial, [...(replacedBySerial.get(v.serial) ?? []), v.generation])
  }
  const units: BottleUnit[] = []
  for (let serial = from; serial <= to; serial++) {
    for (const generation of (replacedBySerial.get(serial) ?? []).sort((a, b) => a - b)) units.push(bottleUnit(ctx, lot, bl, serial, generation))
    units.push(bottleUnit(ctx, lot, bl, serial))
  }
  return filter.status ? units.filter((u) => u.status === filter.status) : units
}

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV de los códigos vigentes del rango (`text/csv; charset=utf-8`, CRLF); deja constancia del rango exportado. */
export function exportBottleCodesCsv(state: TraceState, ctx: TraceCtx, lot: Lot, fromSerial?: number, toSerial?: number): { body: string; rows: number; from: number; to: number } {
  const bl = assertBottled(state, lot)
  const { from, to } = serialRange(bl, fromSerial, toSerial)
  const bottling = lotBottling(state, lot.id) as BottlingBatchResponse
  const lines = [BOTTLE_CODES_CSV_COLUMNS.join(',')]
  for (let serial = from; serial <= to; serial++) {
    if (isSerialVoided(bl, serial)) continue
    const code = bottleCodeOf(bl, serial)
    lines.push([serial, code, formatBottleCode(code), passportUrl(ctx.passportBaseUrl, code), lot.lotCode, lot.name, lot.productType, bottling.bottlingDate.slice(0, 10)].map(csvCell).join(','))
  }
  bl.exports.push({ fromSerial: from, toSerial: to, at: ctx.now })
  return { body: `${lines.join('\r\n')}\r\n`, rows: lines.length - 1, from, to }
}

/**
 * Anula un código de botella (§7.2). `replace: true` emite un código nuevo con la misma serie
 * (etiqueta dañada); con el expediente cerrado solo se anula sin sustituto (S-14).
 */
export function voidBottleCode(state: TraceState, ctx: TraceCtx, wineryId: string, rawCode: string, body: { reason: string; replace?: boolean }): BottleUnit {
  const code = normalizeBottleCode(rawCode)
  const found = isValidBottleCode(code) ? findBottle(state, code) : null
  if (!found || found.lot.wineryId !== wineryId) throw new ApiError(404, 'TRC_BOTTLE_CODE_NOT_FOUND', 'Código de botella no encontrado')
  const { ref, bottleLot: bl, lot } = found
  if (lot.stage === 'DISCARDED') assertLotWritable(lot)
  if (bl.allVoided || bl.voided.some((v) => v.code === code)) {
    throw stateError('TRC_BOTTLE_CODE_ALREADY_VOIDED', 'El código ya estaba anulado', [violation('TRC_BOTTLE_CODE_ALREADY_VOIDED', 'Código anulado', { meta: { code } })])
  }
  const dossier = lotDossier(state, lot.id)
  if (body.replace && dossier?.status === 'CLOSED') {
    throw stateError('TRC_DOSSIER_CLOSED', 'Con el expediente cerrado un código se puede anular, pero no sustituir', [
      violation('TRC_DOSSIER_CLOSED', 'Expediente cerrado', { field: 'replace', meta: { closedAt: dossier.closedAt } }),
    ])
  }
  if (!ctx.actor) throw new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Solo un miembro de la bodega puede anular códigos')
  let replacedBy: string | null = null
  if (body.replace) {
    const taken = bottleIndex(state)
    let generation = ref.generation + 1
    while (taken.has(mockBottleCode(bl.lotId, ref.serial, generation))) generation++
    bl.generations[String(ref.serial)] = generation
    replacedBy = mockBottleCode(bl.lotId, ref.serial, generation)
  }
  bl.voided.push({ serial: ref.serial, code, generation: ref.generation, at: ctx.now, by: ctx.actor, reason: body.reason, replacedBy })
  appendLotEvent(state, ctx, lot, {
    type: 'BOTTLE_CODE_VOIDED',
    occurredAt: ctx.now,
    summary: `Código de la botella n.º ${formatQuantity(ref.serial)} anulado${replacedBy ? ' y sustituido' : ''}: ${body.reason}`,
    data: { serial: ref.serial, replaced: replacedBy !== null, reason: body.reason },
    resource: { type: 'bottle_unit', id: bl.bottlingBatchId },
  })
  if (ctx.now > lot.updatedAt) lot.updatedAt = ctx.now
  return bottleUnit(ctx, lot, bl, ref.serial, ref.generation)
}

// ---------------------------------------------------------------------------
// Laboratorio (§8)
// ---------------------------------------------------------------------------

/** Huella simulada de un archivo por su clave (los mocks no guardan los archivos). */
export const fileSha256 = (key: string): string => sha256Hex(`file:${key}`)

type LabBody = Omit<CreateLotLabAnalysisDto, 'laboratoryReportKey' | 'laboratoryReportPdfUrl'> & { laboratoryReportKey?: string; laboratoryReportPdfUrl?: string }

/**
 * Análisis de laboratorio del lote: la conformidad se calcula con los límites y las unidades de la
 * instantánea (EA-08) y un análisis nuevo sustituye al anterior (reanálisis, sin 409).
 */
export function registerLab(state: TraceState, ctx: TraceCtx, lot: Lot, body: LabBody | CreateBatchLabAnalysisDto): BatchLabAnalysisResponse {
  const bottling = lotBottling(state, lot.id)
  const dossier = lotDossier(state, lot.id)
  if (dossier?.status === 'CLOSED') {
    throw stateError('TRC_DOSSIER_CLOSED', 'El expediente del lote está cerrado: ya no admite análisis', [
      violation('TRC_DOSSIER_CLOSED', 'Expediente cerrado', { meta: { closedAt: dossier.closedAt } }),
    ])
  }
  assertLotWritable(lot)
  if (!bottling) {
    throw stateError('TRC_LOT_NOT_BOTTLED', 'El laboratorio se registra sobre el lote embotellado', [violation('TRC_LOT_NOT_BOTTLED', 'Lote sin embotellar', { meta: { stage: lot.stage } })])
  }
  const testDay = dayOf(body.testPerformedAt)
  assertNotFuture(ctx, 'testPerformedAt', testDay)
  assertNotBefore('testPerformedAt', testDay, dayOf(bottling.bottlingDate))
  const abv = body.actualAlcoholAbv
  const converted = body.methanolContentMgL !== undefined ? methanolToAnhydrous(body.methanolContentMgL, abv) : null
  if (body.methanolMg100mlAa !== undefined && converted !== null && Math.abs(body.methanolMg100mlAa - converted) > Math.max(converted, body.methanolMg100mlAa) * 0.01) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', [
      { field: 'methanolMg100mlAa', message: `El metanol en mg/L de producto (${body.methanolContentMgL}) equivale a ${converted} mg/100 mL de alcohol anhidro y se indicó ${body.methanolMg100mlAa}: revisa las unidades` },
    ])
  }
  const key = 'laboratoryReportKey' in body ? body.laboratoryReportKey : undefined
  if (key) assertOwnFile(lot.wineryId, 'laboratoryReportKey', key)
  const legacyUrl = body.laboratoryReportPdfUrl
  const methanolAa = body.methanolMg100mlAa ?? converted
  const conformity = computeLabConformity({
    productType: lot.productType,
    values: { actualAlcoholAbv: abv, volatileAcidityAceticGl: body.volatileAcidityAceticGl, methanolMg100mlAa: methanolAa, copperContentMgL: body.copperContentMgL ?? null },
    limits: lot.rules.lab.limits,
    labeledAbv: bottling.finalAlcoholAbv,
    rulesTakenAt: lot.rules.takenAt,
  })
  for (const previous of lotLabs(state, lot.id)) previous.supersededAt ??= ctx.now
  const reportKey = key ?? legacyUrl ?? ''
  const lab: BatchLabAnalysisResponse = {
    id: ctx.newId('lab'),
    bottlingBatchId: bottling.id,
    certifiedLaboratoryName: body.certifiedLaboratoryName,
    accreditedLabCertificationCode: body.accreditedLabCertificationCode,
    analysisRequestDate: body.analysisRequestDate ? toDateField(dayOf(body.analysisRequestDate)) : null,
    testPerformedAt: toDateField(testDay),
    actualAlcoholAbv: abv,
    totalAlcoholAbv: body.totalAlcoholAbv ?? null,
    totalAcidityTartaricGl: body.totalAcidityTartaricGl,
    volatileAcidityAceticGl: body.volatileAcidityAceticGl,
    freeSulfurDioxideMgL: body.freeSulfurDioxideMgL ?? null,
    totalSulfurDioxideMgL: body.totalSulfurDioxideMgL ?? null,
    reducingSugarsGl: body.reducingSugarsGl ?? null,
    totalDryExtractGl: body.totalDryExtractGl ?? null,
    sugarFreeDryExtractGl: body.sugarFreeDryExtractGl ?? null,
    overpressureBar: body.overpressureBar ?? null,
    methanolContentMgL: body.methanolContentMgL ?? null,
    copperContentMgL: body.copperContentMgL ?? null,
    additionalParams: body.additionalParams ?? null,
    laboratoryReportPdfUrl: legacyUrl ?? reportKey,
    // Calculado: el valor enviado se ignora (EA-08).
    conformsToSenasagStandards: conformity.status === 'CONFORMING',
    conformsToEuStandards: body.conformsToEuStandards ?? false,
    conformsToUsaStandards: body.conformsToUsaStandards ?? false,
    reviewedByMemberId: ctx.actor?.membershipId ?? null,
    createdAt: ctx.now,
    lotId: lot.id,
    methanolMg100mlAa: methanolAa,
    conformityStatus: conformity.status,
    supersededAt: null,
    conformity,
    recordedBy: ctx.actor,
    report: { key: reportKey, sha256: key ? fileSha256(key) : null, url: legacyUrl ?? null },
  }
  state.labAnalyses.push(lab)
  appendLotEvent(state, ctx, lot, {
    type: 'LAB_REGISTERED',
    occurredAt: lab.testPerformedAt,
    summary: `Análisis de laboratorio de ${lab.certifiedLaboratoryName}: ${LAB_STATUS_LABELS[conformity.status]}`,
    data: { conformity: conformity.status, laboratory: lab.certifiedLaboratoryName },
    resource: { type: 'lab_analysis', id: lab.id },
  })
  refreshLotStage(state, ctx, lot)
  return lab
}

export const LAB_STATUS_LABELS = { CONFORMING: 'conforme', NON_CONFORMING: 'no conforme', INCOMPLETE: 'incompleto' } as const
