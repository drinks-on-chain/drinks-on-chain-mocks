import { dossierAnchorView } from '../../chain/views'
import { canonicalJson, sha256Hex } from '../../shared/crypto'
import type { ApiErrorDetail } from '../../shared/envelope'
import { ApiError } from '../handlers/errors'
import type {
  CanonicalDossier,
  ChangeLotAttachmentVisibilityDto,
  Correction,
  CorrectionTargetType,
  CreateLotAttachmentDto,
  CreateLotCorrectionDto,
  DossierPreview,
  Lot,
  LotAttachment,
  LotDossier,
  TerroirResponse,
  TraceActor,
} from '../schemas'
import { CORRECTABLE_FIELDS, DOSSIER_HASH_ALGORITHM, DOSSIER_SCHEMA_VERSION, VOIDABLE_TARGET_TYPES } from '../schemas/lot-views'
import { bottlingInputOf, reviewLot, type IntegrityIssue } from './backfill'
import { BOTTLE_MERKLE_ALGORITHM, merkleLeaf, merkleLevels, merkleProof, mockBottleCode, mockBottleSalt, type MerkleStep } from './bottle-code'
import { addDaysYmd, addMonthsYmd, dayOf, toDateField } from './dates'
import { computeBottlingBalance, computeLabConformity, methanolToAnhydrous } from './domain'
import { allHarvestAnalyses, allHarvestDecisions, assertOwnFile, groupReadings, harvestDecisions, syncHarvest } from './records'
import { violation } from './rules'
import {
  addComplianceIssue,
  agingLockOf,
  agingStartDay,
  allLotLabs,
  appendLotEvent,
  assertLotWritable,
  bottleCodesSummary,
  bottleGeneration,
  bottleLotOf,
  currentLab,
  fileSha256,
  harvestInTank,
  isAgingOpen,
  isProductionOpen,
  isVoided,
  lotAgings,
  lotBottling,
  lotDossier,
  lotHarvests,
  lotLabs,
  lotProductions,
  lotTanks,
  refreshLotStage,
  restLockOf,
  ruleError,
  stateError,
  voidedAtOf,
  type BottleLot,
  type StoredAttachment,
  type StoredDossier,
  type TraceCtx,
  type TraceState,
} from './state'

// Correcciones compensatorias (contrato de la Ola 2 §9), archivos del lote (§11.5) y expediente
// con hash canónico (§10), como los pasos 2.7–2.9 del backend (`corrections.service.ts`,
// `lot-attachments.service.ts`, `domain/dossier.ts`, `domain/merkle.ts`).

/** 409 `TRC_DOSSIER_CLOSED` con `meta: { closedAt, hash }` (`dossierClosedError` del backend). */
export function dossierClosedError(dossier: { closedAt: string | null; hash: string | null } | null, message = 'El expediente del lote está cerrado: ya no admite registros', field?: string): ApiError {
  return stateError('TRC_DOSSIER_CLOSED', message, [violation('TRC_DOSSIER_CLOSED', 'Expediente cerrado', { ...(field && { field }), meta: { closedAt: dossier?.closedAt ?? null, hash: dossier?.hash ?? null } })])
}

/**
 * 409 `TRC_DOSSIER_CLOSED` si el expediente ya está cerrado. Para las escrituras que el contrato
 * marca con ese código (laboratorio §8.1, correcciones §9, archivos §11.5, sustituir un código §7.2
 * y un segundo cierre §10): se comprueba **antes** que la etapa del lote, que respondería
 * `TRC_LOT_TERMINAL` (el código de las demás escrituras sobre un lote `CERTIFIED`).
 */
export function assertDossierOpen(state: TraceState, lot: Lot, message?: string): void {
  const dossier = lotDossier(state, lot.id)
  if (dossier?.status === 'CLOSED') throw dossierClosedError(dossier, message)
}

// ---------------------------------------------------------------------------
// Correcciones (§9)
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>

/** Registro corregible del lote y cómo recalcular lo que depende de él. */
function findTarget(state: TraceState, lot: Lot, type: CorrectionTargetType, id: string): { record: AnyRecord; after: (ctx: TraceCtx) => void } | null {
  const noop = () => undefined
  switch (type) {
    case 'HARVEST_BATCH': {
      const h = lotHarvests(state, lot.id).find((x) => x.id === id)
      if (!h) return null
      return {
        record: h as AnyRecord,
        after: () => {
          // Derivados: el neto y, si toda la uva del pesaje estaba en un solo tanque, su entrada.
          const before = h.netWeightKg
          h.netWeightKg = Math.round((h.grossWeightKg - h.tareWeightKg) * 1000) / 1000
          const inputs = state.tanks.flatMap((t) => (t.inputs ?? []).filter((i) => i.harvestBatchId === h.id))
          if (inputs.length === 1 && Math.abs(inputs[0]!.kg - before) < 1e-6) inputs[0]!.kg = h.netWeightKg
        },
      }
    }
    case 'MATURITY_ANALYSIS': {
      const m = state.maturityAnalyses.find((x) => x.id === id)
      const h = m ? lotHarvests(state, lot.id).find((x) => x.id === m.harvestBatchId) : undefined
      return m && h ? { record: m as AnyRecord, after: () => syncHarvest(state, h) } : null
    }
    case 'PHYTO_DECISION': {
      const d = state.phytoDecisions.find((x) => x.id === id)
      const h = d ? lotHarvests(state, lot.id).find((x) => x.id === d.harvestBatchId) : undefined
      return d && h ? { record: d as AnyRecord, after: () => syncHarvest(state, h) } : null
    }
    case 'FERMENTATION_TANK': {
      const t = lotTanks(state, lot.id).find((x) => x.id === id)
      return t ? { record: t as AnyRecord, after: noop } : null
    }
    case 'FERMENTATION_LOG': {
      const l = state.logs.find((x) => x.id === id)
      const t = l ? lotTanks(state, lot.id).find((x) => x.id === l.fermentationTankId) : undefined
      return l && t ? { record: l as AnyRecord, after: (ctx) => groupReadings(state, ctx, lot, t, dayOf(l.recordedAt)) } : null
    }
    case 'TREATMENT': {
      const tr = state.treatments.find((x) => x.id === id)
      return tr && lotTanks(state, lot.id).some((t) => t.id === tr.fermentationTankId) ? { record: tr as AnyRecord, after: noop } : null
    }
    case 'WINE_AGING': {
      const a = lotAgings(state, lot.id).find((x) => x.id === id)
      if (!a) return null
      return {
        record: a as AnyRecord,
        after: () => {
          if (a.startDate) a.lockUntilDate = toDateField(addMonthsYmd(dayOf(a.startDate), Math.max(a.plannedMonths, lot.rules.wine.minAgingMonths)))
        },
      }
    }
    case 'PRODUCTION_BATCH': {
      const p = lotProductions(state, lot.id).find((x) => x.id === id)
      if (!p) return null
      return {
        record: p as AnyRecord,
        after: () => {
          if (p.heartLiters !== null) p.outputVolumeLiters = p.heartLiters
          if (p.headsLiters !== null || p.tailsLiters !== null) p.wasteVolumeLiters = Math.round(((p.headsLiters ?? 0) + (p.tailsLiters ?? 0)) * 1000) / 1000
          if (p.processEndDate) p.mandatoryRestUntil = toDateField(addDaysYmd(dayOf(p.processEndDate), lot.rules.singani.minRestDays))
        },
      }
    }
    case 'BOTTLING': {
      const b = lotBottling(state, lot.id)
      if (!b || b.id !== id) return null
      return {
        record: b as AnyRecord,
        after: () => {
          const { input } = bottlingInputOf(state, lot, b)
          if (input) b.balance = computeBottlingBalance(input)
        },
      }
    }
    case 'LAB_ANALYSIS': {
      const l = state.labAnalyses.find((x) => x.id === id && x.lotId === lot.id)
      const b = lotBottling(state, lot.id)
      if (!l) return null
      return {
        record: l as AnyRecord,
        after: () => {
          if (l.methanolContentMgL !== null && l.methanolContentMgL !== undefined) l.methanolMg100mlAa = methanolToAnhydrous(l.methanolContentMgL, l.actualAlcoholAbv)
          const conformity = computeLabConformity({
            productType: lot.productType,
            values: { actualAlcoholAbv: l.actualAlcoholAbv, volatileAcidityAceticGl: l.volatileAcidityAceticGl, methanolMg100mlAa: l.methanolMg100mlAa, copperContentMgL: l.copperContentMgL ?? null },
            limits: lot.rules.lab.limits,
            labeledAbv: b?.finalAlcoholAbv ?? null,
            rulesTakenAt: lot.rules.takenAt,
          })
          l.conformity = conformity
          l.conformityStatus = conformity.status
          l.conformsToSenasagStandards = conformity.status === 'CONFORMING'
        },
      }
    }
    case 'TERROIR':
      return null
  }
}

const DATE_FIELDS = new Set(['intakeDate', 'measuredAt', 'recordedAt', 'appliedAt', 'startDate', 'endDate', 'processStartDate', 'processEndDate', 'testPerformedAt'])
const TEXT_FIELDS = new Set(['notes', 'additiveName', 'additiveSupplier', 'co2Observations', 'bottleType'])

/**
 * Reglas de un embotellado **ya hecho** (`BOTTLED_RULE_CODES` del backend): no se puede deshacer,
 * así que una corrección que las incumple no se rechaza; queda registrada y abre una incidencia
 * `CORRECTION` que bloquea el cierre del expediente.
 */
const BOTTLED_RULE_CODES: readonly string[] = [
  'TRC_LOCK_NOT_RELEASED',
  'TRC_BOTTLING_EXCEEDS_VOLUME',
  'TRC_BOTTLING_LOSS_ABOVE_TOLERANCE',
  'TRC_ALCOHOL_BALANCE_EXCEEDED',
  'TRC_DILUTION_NOT_ALLOWED',
  'TRC_VOLUME_MISSING',
  'TRC_BOTTLING_SOURCE_INVALID',
  'TRC_BOTTLING_SOURCES_PENDING',
]

function checkValue(field: string, value: unknown): string | null {
  if (DATE_FIELDS.has(field)) return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : 'Debe ser una fecha (YYYY-MM-DD o ISO 8601)'
  if (TEXT_FIELDS.has(field)) return value === null || typeof value === 'string' ? null : 'Debe ser un texto'
  if (field === 'leftover') return value === null || (typeof value === 'object' && typeof (value as AnyRecord).liters === 'number') ? null : 'Debe ser { liters, disposition, notes } o null'
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? null : 'Debe ser un número mayor o igual que 0'
}

const issueKey = (i: IntegrityIssue) => `${i.code}:${i.details.map((d) => JSON.stringify(d.meta ?? {})).join('|')}`

/**
 * Corrección compensatoria: ningún registro se edita ni se borra; se guarda el valor anterior y el
 * nuevo (`AMEND`) o el registro deja de contar (`VOID`), con motivo. Vuelve a validar las reglas
 * del lote con su instantánea: si el resultado incumple una regla que antes cumplía → 422
 * `TRC_CORRECTION_BREAKS_RULES`; si resuelve una incidencia, la marca `resolvedAt`.
 */
export function correctLot(state: TraceState, ctx: TraceCtx, lot: Lot, body: CreateLotCorrectionDto): Correction {
  assertDossierOpen(state, lot)
  if (lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED') throw dossierClosedError(null)
  // Un lote rechazado solo admite anular un dictamen: así se deshace un rechazo erróneo (§3.4).
  const rejectedVoid = lot.stage === 'REJECTED' && body.target.type === 'PHYTO_DECISION' && body.kind === 'VOID'
  if (lot.stage === 'DISCARDED' || (lot.stage === 'REJECTED' && !rejectedVoid)) {
    throw stateError('TRC_LOT_TERMINAL', `El lote está en etapa ${lot.stage}: no admite correcciones`, [violation('TRC_LOT_TERMINAL', `Etapa terminal: ${lot.stage}`, { meta: { stage: lot.stage } })])
  }
  if (!ctx.actor) throw new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Solo un miembro de la bodega puede corregir registros')
  const target = findTarget(state, lot, body.target.type, body.target.id)
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'El registro que se corrige no existe en este lote')
  const { record } = target
  const changes: Correction['changes'] = []
  const before = reviewLot(state, ctx, lot)

  if (body.kind === 'VOID') {
    if (!VOIDABLE_TARGET_TYPES.includes(body.target.type)) {
      throw ruleError('TRC_CORRECTION_FIELD_NOT_CORRECTABLE', 'Este registro no se puede anular: corrige sus campos', [
        violation('TRC_CORRECTION_FIELD_NOT_CORRECTABLE', 'Registro no anulable', { field: 'kind', meta: { field: 'kind', targetType: body.target.type } }),
      ])
    }
    if (isVoided(state, body.target.type, body.target.id)) throw new ApiError(409, 'CONFLICT', 'El registro ya estaba anulado')
    if (body.target.type === 'PHYTO_DECISION' && harvestInTank(state, record.harvestBatchId as string)) {
      throw stateError('TRC_PHYTO_DECISION_FINAL', 'La uva ya entró a un tanque: su dictamen no cambia', [
        violation('TRC_PHYTO_DECISION_FINAL', 'Dictamen final', { meta: { harvestBatchId: record.harvestBatchId, inTank: true } }),
      ])
    }
    const wasCurrent = body.target.type === 'LAB_ANALYSIS' && !record.supersededAt
    state.voidedRecords.push(`${body.target.type}:${body.target.id}`)
    if (wasCurrent) {
      // Anular el análisis vigente devuelve la vigencia al anterior.
      const previous = lotLabs(state, lot.id).at(-1)
      if (previous) previous.supersededAt = null
    }
  } else {
    const allowed = CORRECTABLE_FIELDS[body.target.type]
    const fields = Object.keys(body.changes ?? {})
    const notAllowed = fields.filter((f) => !allowed.includes(f))
    if (notAllowed.length > 0) {
      throw ruleError(
        'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
        `Campos no corregibles: ${notAllowed.join(', ')}`,
        notAllowed.map((f) => violation('TRC_CORRECTION_FIELD_NOT_CORRECTABLE', `El campo ${f} no se puede corregir`, { field: `changes.${f}`, expected: allowed, meta: { field: f } })),
      )
    }
    const invalid = fields.map((f) => [f, checkValue(f, (body.changes as AnyRecord)[f])] as const).filter(([, error]) => error !== null)
    if (invalid.length > 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', invalid.map(([f, error]) => ({ field: `changes.${f}`, message: error as string })))
    }
    const netBefore = body.target.type === 'HARVEST_BATCH' ? (record.netWeightKg as number) : null
    for (const field of fields) {
      const raw = (body.changes as AnyRecord)[field]
      const value = DATE_FIELDS.has(field) && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && field !== 'startDate' ? toDateField(raw) : raw
      // Solo cuenta lo que cambia de verdad.
      if (JSON.stringify(record[field] ?? null) === JSON.stringify(value ?? null)) continue
      changes.push({ field, before: record[field] ?? null, after: value ?? null })
      record[field] = value
    }
    if (changes.length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', [{ field: 'changes', message: 'La corrección no cambia ningún valor del registro' }])
    }
    target.after(ctx)
    // Valor derivado: el neto del pesaje queda también en la corrección.
    if (netBefore !== null && record.netWeightKg !== netBefore) changes.push({ field: 'netWeightKg', before: netBefore, after: record.netWeightKg as number })
  }
  if (body.kind === 'VOID') target.after(ctx)

  // El resultado no puede incumplir una regla que antes se cumplía (`compareIntegrity` del backend):
  // lo que la corrección introduce se rechaza, salvo las reglas de un embotellado ya hecho.
  const after = reviewLot(state, ctx, lot)
  const known = new Set(before.map(issueKey))
  const introduced = after.filter((i) => !known.has(issueKey(i)))
  const rejected = introduced.filter((i) => !BOTTLED_RULE_CODES.includes(i.code))
  if (rejected.length > 0) {
    throw ruleError('TRC_CORRECTION_BREAKS_RULES', 'La corrección dejaría el lote incumpliendo una regla', rejected.flatMap((i) => i.details))
  }
  const correction: Correction = { id: ctx.newId('correction'), lotId: lot.id, target: body.target, kind: body.kind, changes, reason: body.reason, createdAt: ctx.now, createdBy: ctx.actor }
  state.corrections.push(correction)
  // De un embotellado ya hecho: el dato corregido es el verdadero; queda una incidencia que bloquea el cierre.
  const openedIssueIds: string[] = []
  for (const issue of introduced.filter((i) => BOTTLED_RULE_CODES.includes(i.code))) {
    addComplianceIssue(ctx, lot, { ...issue, source: 'CORRECTION' })
    openedIssueIds.push(lot.complianceIssues.at(-1)!.id)
  }
  // Incidencias que la corrección resuelve: las de un código que se incumplía antes y ya no.
  const previous = new Set(before.map((i) => i.code))
  const remaining = new Set(after.map((i) => i.code))
  const resolvedIssueIds: string[] = []
  for (const issue of lot.complianceIssues) {
    if (issue.resolvedAt || !previous.has(issue.code) || remaining.has(issue.code)) continue
    issue.resolvedAt = ctx.now
    resolvedIssueIds.push(issue.id)
  }
  for (const event of state.lotEvents) if (event.lotId === lot.id && event.resource.id === body.target.id) event.corrected = true
  appendLotEvent(state, ctx, lot, {
    type: 'CORRECTION',
    occurredAt: ctx.now,
    summary: `${body.kind === 'VOID' ? 'Anulación' : 'Corrección'} de ${TARGET_LABELS[body.target.type]}: ${body.reason}`,
    data: { correctionId: correction.id, target: body.target, targetType: body.target.type, kind: body.kind, fields: changes.map((c) => c.field), reason: body.reason, openedIssueIds, resolvedIssueIds },
    resource: { type: 'correction', id: correction.id },
  })
  refreshLotStage(state, ctx, lot)
  return correction
}

/**
 * Ejecuta una escritura que puede dejar de incumplir una regla (descartar una fuente abierta de un
 * lote ya embotellado) y resuelve las incidencias abiertas cuyo código se incumplía antes y ya no.
 */
export function withIssueReevaluation<T>(state: TraceState, ctx: TraceCtx, lot: Lot | null, write: () => T): T {
  if (!lot) return write()
  const previous = new Set(reviewLot(state, ctx, lot).map((i) => i.code))
  const result = write()
  const remaining = new Set(reviewLot(state, ctx, lot).map((i) => i.code))
  for (const issue of lot.complianceIssues) if (!issue.resolvedAt && previous.has(issue.code) && !remaining.has(issue.code)) issue.resolvedAt = ctx.now
  return result
}

const TARGET_LABELS: Record<CorrectionTargetType, string> = {
  TERROIR: 'la parcela',
  HARVEST_BATCH: 'el pesaje',
  MATURITY_ANALYSIS: 'el análisis de madurez',
  PHYTO_DECISION: 'el dictamen fitosanitario',
  FERMENTATION_TANK: 'el tanque',
  FERMENTATION_LOG: 'la lectura',
  TREATMENT: 'el tratamiento',
  WINE_AGING: 'la crianza',
  PRODUCTION_BATCH: 'la destilación',
  BOTTLING: 'el embotellado',
  LAB_ANALYSIS: 'el análisis de laboratorio',
}

/**
 * Corrección de una parcela usada (§3.1): `altitudeMasl`, `varietyName` y `rawMaterialType` solo
 * cambian por aquí. Reevalúa la D.O. de los lotes abiertos que la usan: el que deja de cumplir
 * recibe una incidencia `TRC_DO_NOT_ELIGIBLE` con `source: 'RULES_REEVALUATION'`.
 */
export function correctTerroir(state: TraceState, ctx: TraceCtx, terroir: TerroirResponse, body: { changes: Record<string, unknown>; reason: string }): Correction {
  if (!ctx.actor) throw new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Solo un miembro de la bodega puede corregir parcelas')
  const allowed = CORRECTABLE_FIELDS.TERROIR
  const fields = Object.keys(body.changes)
  const notAllowed = fields.filter((f) => !allowed.includes(f))
  if (notAllowed.length > 0) {
    throw ruleError(
      'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
      `Campos no corregibles: ${notAllowed.join(', ')}`,
      notAllowed.map((f) => violation('TRC_CORRECTION_FIELD_NOT_CORRECTABLE', `El campo ${f} no se puede corregir`, { field: `changes.${f}`, expected: allowed, meta: { field: f } })),
    )
  }
  const details: ApiErrorDetail[] = []
  if (fields.length === 0) details.push({ field: 'changes', message: 'Indica los campos que se corrigen y su valor nuevo' })
  if ('altitudeMasl' in body.changes && (typeof body.changes.altitudeMasl !== 'number' || body.changes.altitudeMasl < 0)) details.push({ field: 'changes.altitudeMasl', message: 'Debe ser un número mayor o igual que 0' })
  for (const f of ['varietyName', 'rawMaterialType']) {
    if (f in body.changes && (typeof body.changes[f] !== 'string' || !(body.changes[f] as string).trim())) details.push({ field: `changes.${f}`, message: 'Debe ser un texto no vacío' })
  }
  if (details.length > 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', details)
  const record = terroir as AnyRecord
  const changes = fields.map((field) => ({ field, before: record[field] ?? null, after: body.changes[field] ?? null }))
  for (const field of fields) record[field] = body.changes[field]
  // La corrección dice cómo era la parcela: también en los pesajes que la usaron.
  const harvests = state.harvestBatches.filter((h) => h.terroirId === terroir.id)
  for (const h of harvests) {
    if (h.terroirSnapshot) h.terroirSnapshot = { ...h.terroirSnapshot, altitudeMasl: terroir.altitudeMasl, varietyName: terroir.varietyName, rawMaterialType: terroir.rawMaterialType }
  }
  const correction: Correction = { id: ctx.newId('correction'), lotId: null, target: { type: 'TERROIR', id: terroir.id }, kind: 'AMEND', changes, reason: body.reason, createdAt: ctx.now, createdBy: ctx.actor }
  state.corrections.push(correction)
  const lotIds = new Set(harvests.map((h) => h.lotId).filter((id): id is string => Boolean(id)))
  for (const lot of state.lots) {
    if (!lotIds.has(lot.id) || ['CERTIFIED', 'ANCHORED', 'DISCARDED', 'REJECTED'].includes(lot.stage)) continue
    const issue = reviewLot(state, ctx, lot).find((i) => i.code === 'TRC_DO_NOT_ELIGIBLE')
    const open = lot.complianceIssues.find((i) => i.code === 'TRC_DO_NOT_ELIGIBLE' && !i.resolvedAt)
    if (issue && !open) addComplianceIssue(ctx, lot, { ...issue, source: 'RULES_REEVALUATION' })
    if (!issue && open) open.resolvedAt = ctx.now
    appendLotEvent(state, ctx, lot, {
      type: 'CORRECTION',
      occurredAt: ctx.now,
      summary: `Corrección de la parcela ${terroir.parcelName} (${fields.join(', ')}): ${body.reason}`,
      data: { targetType: 'TERROIR', kind: 'AMEND', fields },
      resource: { type: 'correction', id: correction.id },
    })
    refreshLotStage(state, ctx, lot)
  }
  return correction
}

// ---------------------------------------------------------------------------
// Archivos privados del lote (§11.5)
// ---------------------------------------------------------------------------

const MIME_BY_EXTENSION: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const mimeOf = (key: string) => MIME_BY_EXTENSION[key.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream'
/** Tamaño simulado y estable de un archivo (los mocks no guardan los archivos). */
const sizeOf = (key: string) => 20_000 + (parseInt(fileSha256(key).slice(0, 6), 16) % 480_000)

/** URL firmada de 15 min (la misma forma que `POST /v1/uploads`). */
export function signedFileUrl(ctx: Pick<TraceCtx, 'now'>, key: string): { url: string; expiresAt: string } {
  const expires = Date.parse(ctx.now) + 15 * 60_000
  return { url: `/mocks/uploads/${key}?expires=${Math.floor(expires / 1000)}&signature=mock`, expiresAt: new Date(expires).toISOString().replace(/\.\d{3}Z$/, 'Z') }
}

export function toAttachment(ctx: Pick<TraceCtx, 'now'>, a: StoredAttachment): LotAttachment {
  const signed = signedFileUrl(ctx, a.key)
  return { id: a.id, kind: a.kind, title: a.title, key: a.key, mimeType: a.mimeType, sizeBytes: a.sizeBytes, sha256: a.sha256, visibility: a.visibility, url: signed.url, urlExpiresAt: signed.expiresAt, createdAt: a.createdAt, createdBy: a.createdBy }
}

const VISIBILITY_LABEL = { PUBLIC: 'público', PRIVATE: 'privado' } as const

/** Adjunta al lote un archivo ya subido con `POST /v1/uploads`. Por defecto `PRIVATE`; la etiqueta nace `PUBLIC` (S-20). */
export function addAttachment(state: TraceState, ctx: TraceCtx, lot: Lot, body: CreateLotAttachmentDto): StoredAttachment {
  assertDossierOpen(state, lot, 'El expediente del lote está cerrado: ya no admite archivos')
  assertLotWritable(lot)
  if (!ctx.actor) throw new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Solo un miembro de la bodega puede adjuntar archivos')
  assertOwnFile(lot.wineryId, 'key', body.key)
  const attachment: StoredAttachment = {
    id: ctx.newId('lot-attachment'),
    lotId: lot.id,
    kind: body.kind,
    title: body.title,
    key: body.key,
    mimeType: mimeOf(body.key),
    sizeBytes: sizeOf(body.key),
    sha256: fileSha256(body.key, state),
    visibility: body.visibility ?? (body.kind === 'LABEL' ? 'PUBLIC' : 'PRIVATE'),
    createdAt: ctx.now,
    createdBy: ctx.actor,
  }
  state.attachments.push(attachment)
  appendLotEvent(state, ctx, lot, {
    type: 'FILE_ATTACHED',
    occurredAt: ctx.now,
    summary: `Archivo adjuntado: ${body.title} (${VISIBILITY_LABEL[attachment.visibility]})`,
    data: { action: 'ATTACHED', kind: body.kind, title: body.title, visibility: attachment.visibility, sha256: attachment.sha256 },
    resource: { type: 'lot_attachment', id: attachment.id },
  })
  refreshLotStage(state, ctx, lot)
  return attachment
}

/**
 * Archivos del lote: los adjuntos y, además, los informes de dictamen y de laboratorio registrados
 * con su `key` (§3.4 y §8), que aparecen aquí también.
 */
export function lotAttachments(state: TraceState, lot: Lot): StoredAttachment[] {
  const own = state.attachments.filter((a) => a.lotId === lot.id)
  const keys = new Set(own.map((a) => a.key))
  const derived: StoredAttachment[] = []
  // Los informes de un dictamen o de un análisis anulado no se listan; los de registros anteriores a la Ola 2 no tienen autor.
  const add = (id: string, kind: 'PHYTO_REPORT' | 'LAB_REPORT', title: string, key: string, at: string, by: TraceActor | null | undefined) => {
    if (keys.has(key) || !key.startsWith('org/')) return
    keys.add(key)
    derived.push({ id, lotId: lot.id, kind, title, key, mimeType: mimeOf(key), sizeBytes: sizeOf(key), sha256: fileSha256(key, state), visibility: 'PRIVATE', createdAt: at, createdBy: by ?? null })
  }
  for (const h of lotHarvests(state, lot.id)) {
    for (const d of harvestDecisions(state, h.id)) if (d.inspectionReport) add(d.id, 'PHYTO_REPORT', `Informe de inspección de ${h.harvestBatchCode}`, d.inspectionReport.key, d.recordedAt, d.decidedBy)
  }
  for (const l of lotLabs(state, lot.id)) if (l.report) add(l.id, 'LAB_REPORT', `Informe de ${l.certifiedLaboratoryName}`, l.report.key, l.createdAt, l.recordedBy)
  return [...own, ...derived].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * Cambia la visibilidad de un adjunto. Como en el backend, queda como un evento `FILE_ATTACHED`
 * con `data.action = 'VISIBILITY_CHANGED'` en la línea de tiempo (la vigente es la del último);
 * repetir la visibilidad vigente no registra nada.
 */
export function changeAttachmentVisibility(state: TraceState, ctx: TraceCtx, lot: Lot, attachmentId: string, body: ChangeLotAttachmentVisibilityDto): { attachment: StoredAttachment; changed: boolean } {
  const attachment = state.attachments.find((a) => a.id === attachmentId && a.lotId === lot.id)
  if (!attachment) throw new ApiError(404, 'NOT_FOUND', 'Archivo no encontrado en este lote')
  const previous = attachment.visibility
  if (previous === body.visibility) return { attachment, changed: false }
  attachment.visibility = body.visibility
  appendLotEvent(state, ctx, lot, {
    type: 'FILE_ATTACHED',
    occurredAt: ctx.now,
    summary: `Visibilidad del archivo «${attachment.title}»: ${VISIBILITY_LABEL[previous]} → ${VISIBILITY_LABEL[body.visibility]}`,
    data: { action: 'VISIBILITY_CHANGED', attachmentId: attachment.id, kind: attachment.kind, previous, visibility: body.visibility },
    resource: { type: 'lot_attachment', id: attachment.id },
  })
  if (ctx.now > lot.updatedAt) lot.updatedAt = ctx.now
  return { attachment, changed: true }
}

// ---------------------------------------------------------------------------
// Expediente y hash canónico (§10; `domain/dossier.ts` y `domain/merkle.ts` del backend)
// ---------------------------------------------------------------------------

/** Decimal como cadena de escala fija (`"18400.000"`), o `null`. Sin `-0.000`. */
export function fixed(value: number | null | undefined, scale: number): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const text = value.toFixed(scale)
  return Number(text) === 0 ? (0).toFixed(scale) : text
}

/** Instante en ISO 8601 UTC con milisegundos, como en el expediente del backend. */
const instant = (value: string | null | undefined): string | null => (value ? new Date(Date.parse(value)).toISOString() : null)
/** Personas del expediente: membresía y rol, sin nombres ni correos. */
const actorRef = (a: TraceActor | null | undefined) => (a ? { membershipId: a.membershipId, role: a.role } : null)

/** Orden estable: por `key` (fecha ISO o texto) y después por id, con comparación binaria. */
function byKeyThenId<T extends { id: string }>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** Campos de texto libre que no van en el expediente público: de su corrección queda solo el campo. */
const FREE_TEXT_FIELD = /(^|\.)(notes|reason|discardReason|voidReason)$/i

/** ¿Estaba vigente y activo el código de la serie al cerrar el expediente? */
function leafOf(bl: BottleLot, serial: number, closedAt: string | null): { serial: number; code: string; salt: string } | null {
  if (bl.allVoided && (!closedAt || bl.allVoided.at <= closedAt)) return null
  const generation = bottleGeneration(bl, serial)
  const voided = bl.voided.find((v) => v.serial === serial && v.generation === generation)
  if (voided && (!closedAt || voided.at <= closedAt)) return null
  return { serial, code: mockBottleCode(bl.lotId, serial, generation), salt: mockBottleSalt(bl.lotId, serial, generation) }
}

const merkleCache = new WeakMap<BottleLot, { signature: string; serials: number[]; levels: string[][] }>()

/**
 * Árbol Merkle de los códigos del lote (`sha256-merkle/serial-code-salt`): hojas
 * `SHA-256("{serie}:{código}:{sal}")` de los códigos **activos al cerrar**, por serie; cada nivel
 * empareja de izquierda a derecha con `SHA-256(izquierdo ‖ derecho)` sobre los bytes; el nodo sin
 * pareja sube tal cual; sin hojas, `SHA-256("")`. Los códigos anulados después del cierre siguen
 * en el árbol (tras el cierre no se emiten códigos nuevos).
 */
export function bottleMerkleTree(bl: BottleLot, closedAt: string | null): { serials: number[]; levels: string[][]; root: string; count: number } {
  const signature = `${bl.total}:${bl.voided.length}:${bl.allVoided?.at ?? ''}:${closedAt ?? ''}`
  let cached = merkleCache.get(bl)
  if (cached?.signature !== signature) {
    const leaves: string[] = []
    const serials: number[] = []
    for (let serial = 1; serial <= bl.total; serial++) {
      const leaf = leafOf(bl, serial, closedAt)
      if (!leaf) continue
      serials.push(serial)
      leaves.push(merkleLeaf(leaf))
    }
    cached = { signature, serials, levels: merkleLevels(leaves) }
    merkleCache.set(bl, cached)
  }
  return { serials: cached.serials, levels: cached.levels, root: cached.levels.at(-1)?.[0] ?? sha256Hex(''), count: cached.serials.length }
}

/**
 * Prueba Merkle de una botella frente a la raíz del expediente cerrado: `null` si el expediente
 * no está cerrado, si el código no entró en la raíz (anulado o sustituido antes del cierre) o si
 * las hojas no reproducen la raíz guardada. Un código anulado **después** del cierre la conserva.
 */
export function bottleMerkleProof(state: TraceState, lot: Lot, serial: number, generation: number): { salt: string; path: MerkleStep[] } | null {
  const dossier = lotDossier(state, lot.id)
  const bl = bottleLotOf(state, lot.id)
  if (!bl || dossier?.status !== 'CLOSED' || !dossier.bottleCodes || generation !== bottleGeneration(bl, serial)) return null
  const tree = bottleMerkleTree(bl, dossier.closedAt)
  if (tree.root !== dossier.bottleCodes.merkleRoot) return null
  const index = tree.serials.indexOf(serial)
  if (index < 0) return null
  return { salt: mockBottleSalt(bl.lotId, serial, generation), path: merkleProof(tree.levels, index) }
}

/** Autor del evento de la línea de tiempo que registró un recurso (los registros no guardan su autor). */
function recorderOf(state: TraceState, lotId: string, resourceId: string): TraceActor | null {
  return state.lotEvents.filter((e) => e.lotId === lotId && e.resource.id === resourceId).sort((a, b) => a.seq - b.seq)[0]?.actor ?? null
}

/** Cuándo se descartó una crianza o una destilación (su evento o, si se descartó con el lote, el del lote). */
function discardedAtOf(state: TraceState, lot: Lot, sourceId: string, discarded: boolean): string | null {
  if (!discarded) return null
  const own = state.lotEvents.find((e) => e.lotId === lot.id && e.type === 'LOT_DISCARDED' && e.resource.id === sourceId)
  return instant(own?.occurredAt ?? lot.discarded?.at ?? null)
}

/**
 * Contenido canónico del expediente, `doc-dossier/1` (`buildCanonicalDossier` del backend): las
 * medidas como cadenas de escala fija con la escala de su columna, instantes en ISO 8601 con
 * milisegundos, fechas `YYYY-MM-DD`, listas ordenadas por fecha e id, personas como
 * `{ membershipId, role }`, sin textos libres ni claves de archivos, los registros anulados
 * marcados con `voidedAt` y los códigos de botella solo como raíz Merkle. Las propiedades sin dato
 * van con `null`. Con `closedAt: null` es la vista previa: no cambia mientras no cambien los registros.
 */
export function buildCanonicalDossier(state: TraceState, lot: Lot, closing: { closedAt: string; closedBy: TraceActor | null } | null, lotPrefix: string | null): CanonicalDossier {
  const winery = state.wineries.find((w) => w.id === lot.wineryId)
  const bl = bottleLotOf(state, lot.id)
  const tree = bl ? bottleMerkleTree(bl, closing?.closedAt ?? null) : null

  const harvests = byKeyThenId(lotHarvests(state, lot.id), (h) => dayOf(h.intakeDate)).map((h) => {
    const terroir = state.terroirs.find((t) => t.id === h.terroirId)
    return {
      id: h.id,
      code: h.harvestBatchCode,
      intakeDate: dayOf(h.intakeDate),
      harvestYear: h.harvestYear,
      grossWeightKg: fixed(h.grossWeightKg, 3),
      tareWeightKg: fixed(h.tareWeightKg, 3),
      netWeightKg: fixed(h.netWeightKg, 3),
      temperatureAtIntakeC: fixed(h.temperatureAtIntakeC, 2),
      phytosanitaryStatus: h.phytosanitaryStatus,
      terroir: {
        id: h.terroirId,
        parcelName: h.terroirSnapshot?.parcelName ?? terroir?.parcelName ?? '',
        altitudeMasl: fixed(h.terroirSnapshot?.altitudeMasl ?? terroir?.altitudeMasl, 2),
        varietyName: h.terroirSnapshot?.varietyName ?? terroir?.varietyName ?? '',
        rawMaterialType: h.terroirSnapshot?.rawMaterialType ?? terroir?.rawMaterialType ?? '',
        takenAt: instant(h.terroirSnapshot?.takenAt),
      },
      recordedAt: instant(h.createdAt),
      recordedBy: actorRef(recorderOf(state, lot.id, h.id)),
      maturityAnalyses: byKeyThenId(allHarvestAnalyses(state, h.id), (m) => instant(m.measuredAt) as string).map((m) => ({
        id: m.id,
        brixDegrees: fixed(m.brixDegrees, 2),
        ph: fixed(m.ph, 2),
        acidityGl: fixed(m.acidityGl, 3),
        measuredAt: instant(m.measuredAt),
        recordedAt: instant(m.recordedAt),
        recordedBy: actorRef(m.recordedBy),
        source: m.source,
        voidedAt: instant(voidedAtOf(state, 'MATURITY_ANALYSIS', m.id)),
      })),
      phytoDecisions: byKeyThenId(allHarvestDecisions(state, h.id), (d) => instant(d.decidedAt) as string).map((d) => ({
        id: d.id,
        decision: d.decision,
        decidedAt: instant(d.decidedAt),
        recordedAt: instant(d.recordedAt),
        decidedBy: actorRef(d.decidedBy),
        inspectionReportSha256: d.inspectionReport?.sha256 ?? null,
        source: d.source,
        voidedAt: instant(voidedAtOf(state, 'PHYTO_DECISION', d.id)),
      })),
    }
  })

  const tanks = byKeyThenId(lotTanks(state, lot.id), (t) => instant(t.startDate) as string).map((t) => ({
    id: t.id,
    tankCode: t.tankCode,
    material: t.material ?? null,
    capacityLiters: fixed(t.capacityLiters, 2),
    volumeFilledLiters: fixed(t.volumeFilledLiters, 2),
    finalVolumeLiters: fixed(t.finalVolumeLiters, 2),
    destinationType: t.destinationType ?? null,
    status: t.status,
    startDate: instant(t.startDate),
    endDate: instant(t.endDate),
    recordedAt: instant(t.createdAt),
    recordedBy: actorRef(recorderOf(state, lot.id, t.id)),
    inputs: [...(t.inputs ?? [])]
      .sort((a, b) => (a.harvestBatchId < b.harvestBatchId ? -1 : a.harvestBatchId > b.harvestBatchId ? 1 : 0))
      .map((i) => ({ harvestBatchId: i.harvestBatchId, kg: fixed(i.kg, 3) })),
    readings: byKeyThenId(
      state.logs.filter((l) => l.fermentationTankId === t.id),
      (l) => instant(l.recordedAt) as string,
    ).map((l) => ({
      id: l.id,
      recordedAt: instant(l.recordedAt),
      temperatureCelsius: fixed(l.temperatureCelsius, 2),
      specificGravity: fixed(l.specificGravity, 4),
      phValue: fixed(l.phValue, 2),
      voidedAt: instant(voidedAtOf(state, 'FERMENTATION_LOG', l.id)),
    })),
    treatments: byKeyThenId(
      state.treatments.filter((x) => x.fermentationTankId === t.id),
      (x) => instant(x.appliedAt) as string,
    ).map((x) => ({
      id: x.id,
      treatmentType: x.treatmentType,
      additiveName: x.additiveName,
      dosageAppliedGPerHl: fixed(x.dosageAppliedGPerHl, 4),
      totalAppliedG: fixed(x.totalAppliedG, 4),
      regulatoryAuthCode: x.regulatoryAuthCode,
      appliedAt: instant(x.appliedAt),
      voidedAt: instant(voidedAtOf(state, 'TREATMENT', x.id)),
    })),
  }))

  const agings = byKeyThenId(lotAgings(state, lot.id), agingStartDay).map((a) => ({
    id: a.id,
    fermentationTankId: a.fermentationTankId,
    containerType: a.containerType,
    containerMaterial: a.containerMaterial ?? null,
    containerCount: a.containerCount ?? null,
    barrelUseCycle: a.barrelUseCycle ?? null,
    volumeLiters: fixed(a.volumeLiters, 2),
    plannedMonths: a.plannedMonths,
    startDate: agingStartDay(a),
    unlockDate: agingLockOf(a, lot.rules, agingStartDay(a)).unlockDate,
    status: a.agingStatus,
    discardedAt: discardedAtOf(state, lot, a.id, a.agingStatus === 'DISCARDED'),
    recordedAt: instant(a.createdAt),
    recordedBy: actorRef(recorderOf(state, lot.id, a.id)),
  }))

  const distillations = byKeyThenId(lotProductions(state, lot.id), (p) => dayOf(p.processStartDate)).map((p) => {
    const end = p.processEndDate ? dayOf(p.processEndDate) : null
    return {
      id: p.id,
      fermentationTankId: p.fermentationTankId,
      processType: p.processType,
      equipmentIdentifier: p.equipmentIdentifier,
      processStartDate: dayOf(p.processStartDate),
      processEndDate: end,
      inputVolumeLiters: fixed(p.inputVolumeLiters, 3),
      headsLiters: fixed(p.headsLiters, 3),
      heartLiters: fixed(p.heartLiters ?? p.outputVolumeLiters, 3),
      tailsLiters: fixed(p.tailsLiters, 3),
      vinasseLiters: fixed(p.vinasseLiters, 3),
      heartAbvPercent: fixed(p.heartAbvPercent ?? p.initialAlcoholPercentage, 2),
      restUntil: restLockOf(p, lot.rules, end ?? dayOf(p.processStartDate))?.unlockDate ?? null,
      status: p.restStatus,
      discardedAt: discardedAtOf(state, lot, p.id, p.restStatus === 'DISCARDED'),
      recordedAt: instant(p.createdAt),
      recordedBy: actorRef(recorderOf(state, lot.id, p.id)),
    }
  })

  const b = lotBottling(state, lot.id)
  // El balance se recalcula con los registros vigentes y el volumen entero de las fuentes embotelladas.
  const input = b ? bottlingInputOf(state, lot, b).input : null
  const balance = input ? computeBottlingBalance(input) : null
  const bottling = b
    ? {
        id: b.id,
        lotCode: b.internationalLotCode,
        productType: b.productType,
        bottlingDate: dayOf(b.bottlingDate),
        packagingFormatCl: b.packagingFormatCl,
        totalBottlesPackaged: b.totalBottlesPackaged,
        finalAlcoholAbv: fixed(b.finalAlcoholAbv, 2),
        waterDilutionLiters: fixed(b.waterDilutionLiters, 3),
        bottleType: b.bottleType ?? null,
        leftover: b.leftover ? { liters: fixed(b.leftover.liters, 3), disposition: b.leftover.disposition } : null,
        balance: balance
          ? {
              availableLiters: fixed(balance.availableLiters, 3) as string,
              waterDilutionLiters: fixed(balance.waterDilutionLiters, 3) as string,
              bottledLiters: fixed(balance.bottledLiters, 3) as string,
              leftoverLiters: fixed(balance.leftoverLiters, 3) as string,
              lossLiters: fixed(balance.lossLiters, 3) as string,
              lossPercent: fixed(balance.lossPercent, 2) as string,
              pureAlcohol: balance.pureAlcohol
                ? { availableLiters: fixed(balance.pureAlcohol.availableLiters, 3) as string, bottledLiters: fixed(balance.pureAlcohol.bottledLiters, 3) as string }
                : null,
            }
          : null,
        recordedAt: instant(b.createdAt),
        recordedBy: actorRef(recorderOf(state, lot.id, b.id)),
      }
    : null

  const current = currentLab(state, lot.id)?.id ?? null
  const labAnalyses = byKeyThenId(allLotLabs(state, lot.id), (l) => instant(l.createdAt) as string).map((l) => ({
    id: l.id,
    laboratoryName: l.certifiedLaboratoryName,
    certificationCode: l.accreditedLabCertificationCode,
    analysisRequestDate: l.analysisRequestDate ? dayOf(l.analysisRequestDate) : null,
    testPerformedAt: dayOf(l.testPerformedAt),
    actualAlcoholAbv: fixed(l.actualAlcoholAbv, 2),
    totalAlcoholAbv: fixed(l.totalAlcoholAbv, 2),
    totalAcidityTartaricGl: fixed(l.totalAcidityTartaricGl, 3),
    volatileAcidityAceticGl: fixed(l.volatileAcidityAceticGl, 3),
    freeSulfurDioxideMgL: fixed(l.freeSulfurDioxideMgL, 3),
    totalSulfurDioxideMgL: fixed(l.totalSulfurDioxideMgL, 3),
    reducingSugarsGl: fixed(l.reducingSugarsGl, 3),
    totalDryExtractGl: fixed(l.totalDryExtractGl, 3),
    sugarFreeDryExtractGl: fixed(l.sugarFreeDryExtractGl, 3),
    overpressureBar: fixed(l.overpressureBar, 2),
    methanolContentMgL: fixed(l.methanolContentMgL, 3),
    methanolMg100mlAa: fixed(l.methanolMg100mlAa, 3),
    copperContentMgL: fixed(l.copperContentMgL, 3),
    conformityStatus: l.conformityStatus ?? null,
    conformity: l.conformity ?? null,
    current: l.id === current,
    supersededAt: instant(l.supersededAt),
    voidedAt: instant(voidedAtOf(state, 'LAB_ANALYSIS', l.id)),
    recordedAt: instant(l.createdAt),
    recordedBy: actorRef(l.recordedBy),
  }))

  const corrections = byKeyThenId(
    state.corrections.filter((c) => c.lotId === lot.id),
    (c) => instant(c.createdAt) as string,
  ).map((c) => ({
    id: c.id,
    target: { type: c.target.type, id: c.target.id },
    kind: c.kind,
    // Los textos libres no son públicos: queda constancia del campo.
    changes: c.changes.map((change) => (FREE_TEXT_FIELD.test(change.field) ? { field: change.field } : { field: change.field, before: change.before ?? null, after: change.after ?? null })),
    createdAt: instant(c.createdAt),
    createdBy: actorRef(c.createdBy),
  }))

  const attachments = byKeyThenId(
    state.attachments.filter((a) => a.lotId === lot.id),
    (a) => instant(a.createdAt) as string,
  ).map((a) => ({ kind: a.kind, sha256: a.sha256 }))

  return {
    schema: DOSSIER_SCHEMA_VERSION,
    closedAt: instant(closing?.closedAt),
    closedBy: actorRef(closing?.closedBy),
    winery: { id: lot.wineryId, lotPrefix, tradeName: winery?.commercialName ?? '' },
    lot: {
      id: lot.id,
      reference: lot.reference,
      lotCode: lot.lotCode,
      name: lot.name,
      productType: lot.productType,
      harvestYear: lot.harvestYear,
      createdAt: instant(lot.createdAt) as string,
      createdBy: actorRef(lot.createdBy),
      bottledAt: b ? dayOf(b.bottlingDate) : null,
    },
    // La instantánea de reglas, tal como se guardó.
    rules: JSON.parse(JSON.stringify(lot.rules)) as Record<string, unknown>,
    harvests,
    tanks,
    agings,
    distillations,
    bottling,
    labAnalyses,
    corrections,
    attachments,
    bottleCodes: tree ? { count: tree.count, merkleRoot: tree.root, algorithm: BOTTLE_MERKLE_ALGORITHM } : null,
  }
}

/** Bytes canónicos (JSON canónico RFC 8785, UTF-8) del expediente y su huella SHA-256. */
export function sealDossier(state: TraceState, lot: Lot, closing: { closedAt: string; closedBy: TraceActor | null } | null, lotPrefix: string | null): { canonical: string; hash: string } {
  const canonical = canonicalJson(buildCanonicalDossier(state, lot, closing, lotPrefix))
  return { canonical, hash: sha256Hex(canonical) }
}

const LAB_REQUIREMENT_MESSAGES: Record<string, string> = {
  CONFORMING: 'El análisis de laboratorio vigente es conforme',
  NOT_RECORDED: 'Falta el análisis de laboratorio del lote',
  INCOMPLETE: 'El análisis de laboratorio vigente está incompleto: faltan parámetros exigidos',
  NON_CONFORMING: 'El análisis de laboratorio vigente no es conforme',
}

/** Lo que cada requisito sin cumplir añade a `meta` en el 422 `TRC_DOSSIER_NOT_READY`. */
function requirementMeta(state: TraceState, lot: Lot, key: string): Record<string, unknown> {
  if (key === 'LAB_CONFORMING') return { labStatus: currentLab(state, lot.id)?.conformityStatus ?? 'NOT_RECORDED' }
  if (key === 'NO_OPEN_COMPLIANCE_ISSUES') return { issueIds: lot.complianceIssues.filter((i) => !i.resolvedAt).map((i) => i.id) }
  if (key === 'NO_OPEN_SOURCES') return { sourceIds: [...lotAgings(state, lot.id).filter(isAgingOpen), ...lotProductions(state, lot.id).filter(isProductionOpen)].map((s) => s.id) }
  return {}
}

/**
 * Requisitos del cierre del expediente (§10), en el orden del contrato (`dossierRequirements` del
 * backend). `hashPreview` de la vista previa es la huella del documento con `closedAt` y `closedBy`
 * en `null` (no cambia mientras no cambien los registros del lote); con el expediente cerrado, la
 * definitiva.
 */
export function dossierRequirements(state: TraceState, lot: Lot): DossierPreview['requirements'] {
  const bottling = lotBottling(state, lot.id)
  const bl = bottleLotOf(state, lot.id)
  const labStatus = currentLab(state, lot.id)?.conformityStatus ?? 'NOT_RECORDED'
  const openIssues = lot.complianceIssues.filter((i) => !i.resolvedAt).length
  const openSources = lotAgings(state, lot.id).filter(isAgingOpen).length + lotProductions(state, lot.id).filter(isProductionOpen).length
  const bottled = bottling !== null
  const active = bottleCodesSummary(bl).active
  const codesReady = bottled && bl !== null && active > 0 && bl.total === bottling.totalBottlesPackaged
  const codesMessage = !bottled
    ? 'Los códigos de botella se generan al embotellar'
    : codesReady
      ? `${active} códigos de botella activos`
      : active === 0
        ? 'El lote no tiene ningún código de botella activo'
        : `Hay códigos para ${bl?.total ?? 0} de las ${bottling.totalBottlesPackaged} botellas`
  return [
    { key: 'BOTTLED', met: bottled, message: bottled ? 'El lote está embotellado' : 'El lote aún no está embotellado' },
    { key: 'LAB_CONFORMING', met: labStatus === 'CONFORMING', message: LAB_REQUIREMENT_MESSAGES[labStatus] ?? LAB_REQUIREMENT_MESSAGES.NOT_RECORDED! },
    { key: 'BOTTLE_CODES_READY', met: codesReady, message: codesMessage },
    {
      key: 'NO_OPEN_COMPLIANCE_ISSUES',
      met: openIssues === 0,
      message: openIssues === 0 ? 'Sin incidencias de cumplimiento abiertas' : `${openIssues} incidencias de cumplimiento abiertas: corrígelas o descarta el lote`,
    },
    {
      key: 'NO_OPEN_SOURCES',
      met: openSources === 0,
      message: openSources === 0 ? 'Sin crianzas ni destilaciones abiertas' : `${openSources} crianzas o destilaciones abiertas: descártalas antes de cerrar`,
    },
  ]
}

/** `GET /v1/lots/{id}/dossier/preview`. */
export function dossierPreview(state: TraceState, ctx: Pick<TraceCtx, 'lotPrefix'>, lot: Lot): DossierPreview {
  const requirements = dossierRequirements(state, lot)
  const closed = lotDossier(state, lot.id)
  return {
    ready: requirements.every((r) => r.met),
    requirements,
    hashPreview: closed?.status === 'CLOSED' ? closed.hash : sealDossier(state, lot, null, ctx.lotPrefix(lot.wineryId)).hash,
  }
}

/** Expediente del lote (`OPEN` mientras no se cierre). */
export function dossierOf(state: TraceState, lot: Lot): LotDossier {
  const stored = lotDossier(state, lot.id)
  if (stored) {
    const dossier: StoredDossier = { ...stored, anchor: dossierAnchorView(state.chain, lot.id) }
    delete dossier.canonical
    return dossier
  }
  return { lotId: lot.id, schema: DOSSIER_SCHEMA_VERSION, status: 'OPEN', hash: null, algorithm: DOSSIER_HASH_ALGORITHM, closedAt: null, closedBy: null, bottleCodes: null, anchor: null }
}

/**
 * Bytes canónicos del expediente: los que se hashearon al cerrarlo (tal como se guardaron) o, con
 * el expediente abierto, la vista previa (`closedAt` y `closedBy` en `null`).
 */
export function dossierCanonical(state: TraceState, ctx: Pick<TraceCtx, 'lotPrefix'>, lot: Lot): string {
  const stored = lotDossier(state, lot.id)
  if (stored?.status === 'CLOSED' && stored.closedAt) {
    stored.canonical ??= sealDossier(state, lot, { closedAt: stored.closedAt, closedBy: stored.closedBy }, ctx.lotPrefix(lot.wineryId)).canonical
    return stored.canonical
  }
  return sealDossier(state, lot, null, ctx.lotPrefix(lot.wineryId)).canonical
}

/**
 * Cierra el expediente: hash SHA-256 del contenido canónico, raíz Merkle de los códigos y lote a
 * `CERTIFIED` (la Ola 3 lo ancla). Tras el cierre el lote solo admite anular códigos sin sustituto.
 */
export function closeDossier(state: TraceState, ctx: TraceCtx, lot: Lot): StoredDossier {
  assertDossierOpen(state, lot)
  assertLotWritable(lot)
  const preview = dossierPreview(state, ctx, lot)
  if (!preview.ready) {
    throw ruleError(
      'TRC_DOSSIER_NOT_READY',
      'El expediente aún no se puede cerrar',
      preview.requirements.filter((r) => !r.met).map((r) => violation('TRC_DOSSIER_NOT_READY', r.message, { meta: { requirement: r.key, ...requirementMeta(state, lot, r.key) } })),
    )
  }
  const bl = bottleLotOf(state, lot.id) as BottleLot
  const tree = bottleMerkleTree(bl, ctx.now)
  const sealed = sealDossier(state, lot, { closedAt: ctx.now, closedBy: ctx.actor }, ctx.lotPrefix(lot.wineryId))
  const dossier: StoredDossier = {
    lotId: lot.id,
    schema: DOSSIER_SCHEMA_VERSION,
    status: 'CLOSED',
    hash: sealed.hash,
    algorithm: DOSSIER_HASH_ALGORITHM,
    closedAt: ctx.now,
    closedBy: ctx.actor,
    bottleCodes: { count: tree.count, merkleRoot: tree.root, algorithm: BOTTLE_MERKLE_ALGORITHM },
    anchor: null,
    canonical: sealed.canonical,
  }
  state.dossiers = state.dossiers.filter((d) => d.lotId !== lot.id)
  state.dossiers.push(dossier)
  refreshLotStage(state, ctx, lot)
  appendLotEvent(state, ctx, lot, {
    type: 'DOSSIER_CLOSED',
    occurredAt: ctx.now,
    summary: `Expediente cerrado con la huella ${sealed.hash.slice(0, 12)}…`,
    data: { hash: sealed.hash, algorithm: DOSSIER_HASH_ALGORITHM, bottleCodes: tree.count, bottleMerkleRoot: tree.root },
    resource: { type: 'lot_dossier', id: lot.id },
  })
  return dossier
}
