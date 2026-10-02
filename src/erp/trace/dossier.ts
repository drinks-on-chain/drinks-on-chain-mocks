import { canonicalJson, sha256Hex } from '../../shared/crypto'
import type { ApiErrorDetail } from '../../shared/envelope'
import { ApiError } from '../handlers/errors'
import type {
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
import { fileSha256 } from './bottling'
import { addDaysYmd, addMonthsYmd, dayOf, toDateField } from './dates'
import { computeBottlingBalance, computeLabConformity, methanolToAnhydrous } from './domain'
import { assertOwnFile, groupReadings, harvestAnalyses, harvestDecisions, syncHarvest } from './records'
import { violation } from './rules'
import {
  addComplianceIssue,
  appendLotEvent,
  assertLotWritable,
  bottleGeneration,
  bottleLotOf,
  currentLab,
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
  ruleError,
  stateError,
  type BottleLot,
  type StoredAttachment,
  type StoredDossier,
  type TraceCtx,
  type TraceState,
} from './state'

// Correcciones compensatorias (contrato de la Ola 2 §9), archivos del lote (§11.5) y expediente
// con hash canónico (§10). El backend los trae en los pasos 2.7–2.9: aquí se adelantan con las
// formas del OpenAPI; el contenido canónico y el árbol Merkle son los de los mocks hasta entonces.

function assertDossierOpen(state: TraceState, lot: Lot): void {
  const dossier = lotDossier(state, lot.id)
  if (dossier?.status !== 'CLOSED') return
  throw stateError('TRC_DOSSIER_CLOSED', 'El expediente del lote está cerrado: ya no admite cambios', [
    violation('TRC_DOSSIER_CLOSED', 'Expediente cerrado', { meta: { closedAt: dossier.closedAt } }),
  ])
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
      return h ? { record: h as AnyRecord, after: () => void (h.netWeightKg = Math.round((h.grossWeightKg - h.tareWeightKg) * 1000) / 1000) } : null
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
const TEXT_FIELDS = new Set(['notes', 'additiveName', 'bottleType'])

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
  assertLotWritable(lot)
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
    if (isVoided(state, body.target.type, body.target.id)) throw stateError('TRC_INVALID_STAGE', 'El registro ya estaba anulado', [violation('TRC_INVALID_STAGE', 'Registro ya anulado')])
    if (body.target.type === 'PHYTO_DECISION' && harvestInTank(state, record.harvestBatchId as string)) {
      throw ruleError('TRC_CORRECTION_BREAKS_RULES', 'La uva ya entró a un tanque: su dictamen no cambia', [
        violation('TRC_PHYTO_DECISION_FINAL', 'Uva ya en un tanque', { meta: { harvestBatchId: record.harvestBatchId } }),
      ])
    }
    state.voidedRecords.push(`${body.target.type}:${body.target.id}`)
    changes.push({ field: 'voided', before: false, after: true })
    if (body.target.type === 'LAB_ANALYSIS') {
      // El análisis anterior vuelve a ser el vigente.
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
    for (const field of fields) {
      const raw = (body.changes as AnyRecord)[field]
      const value = DATE_FIELDS.has(field) && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && field !== 'startDate' ? toDateField(raw) : raw
      changes.push({ field, before: record[field] ?? null, after: value ?? null })
      record[field] = value
    }
  }
  target.after(ctx)

  // El resultado no puede incumplir una regla que antes se cumplía.
  const after = reviewLot(state, ctx, lot)
  const known = new Set(before.map(issueKey))
  const broken = after.filter((i) => !known.has(issueKey(i)))
  if (broken.length > 0) {
    throw ruleError('TRC_CORRECTION_BREAKS_RULES', 'La corrección dejaría el lote incumpliendo una regla', broken.flatMap((i) => i.details))
  }
  // Incidencias que la corrección resuelve.
  const remaining = new Set(after.map((i) => i.code))
  for (const issue of lot.complianceIssues) if (!issue.resolvedAt && !remaining.has(issue.code)) issue.resolvedAt = ctx.now

  const correction: Correction = { id: ctx.newId('correction'), lotId: lot.id, target: body.target, kind: body.kind, changes, reason: body.reason, createdAt: ctx.now, createdBy: ctx.actor }
  state.corrections.push(correction)
  for (const event of state.lotEvents) if (event.lotId === lot.id && event.resource.id === body.target.id) event.corrected = true
  appendLotEvent(state, ctx, lot, {
    type: 'CORRECTION',
    occurredAt: ctx.now,
    summary: `${body.kind === 'VOID' ? 'Registro anulado' : `Corrección de ${changes.map((c) => c.field).join(', ')}`}: ${body.reason}`,
    data: { targetType: body.target.type, kind: body.kind, fields: changes.map((c) => c.field) },
    resource: { type: 'correction', id: correction.id },
  })
  refreshLotStage(state, ctx, lot)
  return correction
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

/** Adjunta al lote un archivo ya subido con `POST /v1/uploads`. Por defecto `PRIVATE`; la etiqueta nace `PUBLIC` (S-20). */
export function addAttachment(state: TraceState, ctx: TraceCtx, lot: Lot, body: CreateLotAttachmentDto): StoredAttachment {
  assertDossierOpen(state, lot)
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
    sha256: fileSha256(body.key),
    visibility: body.visibility ?? (body.kind === 'LABEL' ? 'PUBLIC' : 'PRIVATE'),
    createdAt: ctx.now,
    createdBy: ctx.actor,
  }
  state.attachments.push(attachment)
  appendLotEvent(state, ctx, lot, {
    type: 'FILE_ATTACHED',
    occurredAt: ctx.now,
    summary: `Archivo adjunto: ${body.title}`,
    data: { kind: body.kind, visibility: attachment.visibility },
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
  const add = (id: string, kind: 'PHYTO_REPORT' | 'LAB_REPORT', title: string, key: string, at: string, by: TraceActor | null | undefined) => {
    if (!by || keys.has(key) || !key.startsWith('org/')) return
    keys.add(key)
    derived.push({ id, lotId: lot.id, kind, title, key, mimeType: mimeOf(key), sizeBytes: sizeOf(key), sha256: fileSha256(key), visibility: 'PRIVATE', createdAt: at, createdBy: by })
  }
  for (const h of lotHarvests(state, lot.id)) {
    for (const d of harvestDecisions(state, h.id)) if (d.inspectionReport) add(d.id, 'PHYTO_REPORT', `Informe de inspección de ${h.harvestBatchCode}`, d.inspectionReport.key, d.recordedAt, d.decidedBy)
  }
  for (const l of lotLabs(state, lot.id)) if (l.report) add(l.id, 'LAB_REPORT', `Informe de ${l.certifiedLaboratoryName}`, l.report.key, l.createdAt, l.recordedBy)
  return [...own, ...derived].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function changeAttachmentVisibility(state: TraceState, ctx: TraceCtx, lot: Lot, attachmentId: string, body: ChangeLotAttachmentVisibilityDto): StoredAttachment {
  const attachment = state.attachments.find((a) => a.id === attachmentId && a.lotId === lot.id)
  if (!attachment) throw new ApiError(404, 'NOT_FOUND', 'Archivo no encontrado en este lote')
  attachment.visibility = body.visibility
  if (ctx.now > lot.updatedAt) lot.updatedAt = ctx.now
  return attachment
}

// ---------------------------------------------------------------------------
// Expediente y hash canónico (§10)
// ---------------------------------------------------------------------------

const fixed = (value: number | null | undefined, scale: number): string | null => (value === null || value === undefined ? null : value.toFixed(scale))
const kg = (v: number | null | undefined) => fixed(v, 3)
const liters = (v: number | null | undefined) => fixed(v, 3)
const degrees = (v: number | null | undefined) => fixed(v, 2)
/** Actores del expediente: rol y membresía, sin nombres ni correos. */
const actorRef = (a: TraceActor | null | undefined) => (a ? { role: a.role, membershipId: a.membershipId } : null)

/** ¿Estaba vigente y activo el código de la serie al cerrar el expediente? */
function leafOf(bl: BottleLot, serial: number, closedAt: string | null): { serial: number; code: string; salt: string } | null {
  if (bl.allVoided && (!closedAt || bl.allVoided.at <= closedAt)) return null
  const generation = bottleGeneration(bl, serial)
  const voided = bl.voided.find((v) => v.serial === serial && v.generation === generation)
  if (voided && (!closedAt || voided.at <= closedAt)) return null
  return { serial, code: mockBottleCode(bl.lotId, serial, generation), salt: mockBottleSalt(bl.lotId, serial, generation) }
}

const merkleCache = new WeakMap<BottleLot, { signature: string; serials: number[]; levels: string[][] }>()

/** Árbol Merkle de los códigos activos del lote al cierre: hojas `SHA-256("{serie}:{código}:{sal}")` por serie. */
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

/** Prueba Merkle de una botella frente a la raíz del expediente cerrado (`null` si no entró en él). */
export function bottleMerkleProof(state: TraceState, lot: Lot, serial: number, generation: number): { salt: string; path: MerkleStep[] } | null {
  const dossier = lotDossier(state, lot.id)
  const bl = bottleLotOf(state, lot.id)
  if (!bl || dossier?.status !== 'CLOSED' || generation !== bottleGeneration(bl, serial)) return null
  const tree = bottleMerkleTree(bl, dossier.closedAt)
  const index = tree.serials.indexOf(serial)
  if (index < 0) return null
  return { salt: mockBottleSalt(bl.lotId, serial, generation), path: merkleProof(tree.levels, index) }
}

/**
 * Contenido canónico del expediente (`doc-dossier/1`): JSON canónico (claves ordenadas, sin
 * espacios; RFC 8785), decimales como cadenas de escala fija, actores sin nombre y los códigos de
 * botella solo como raíz Merkle con sal por botella. No depende de la fecha de consulta.
 */
export function canonicalDossier(state: TraceState, lot: Lot, closedAt: string | null, lotPrefix: string): string {
  const winery = state.wineries.find((w) => w.id === lot.wineryId)
  const harvests = lotHarvests(state, lot.id)
  const tanks = lotTanks(state, lot.id)
  const bottling = lotBottling(state, lot.id)
  const bl = bottleLotOf(state, lot.id)
  const tree = bl ? bottleMerkleTree(bl, closedAt) : null
  const attachments = lotAttachments(state, lot)
  const doc = {
    schema: DOSSIER_SCHEMA_VERSION,
    winery: { id: lot.wineryId, lotPrefix, tradeName: winery?.commercialName ?? '' },
    lot: { id: lot.id, reference: lot.reference, lotCode: lot.lotCode, name: lot.name, productType: lot.productType, harvestYear: lot.harvestYear, createdAt: lot.createdAt },
    rules: lot.rules,
    harvestBatches: harvests.map((h) => ({
      id: h.id,
      code: h.harvestBatchCode,
      intakeDate: h.intakeDate,
      grossWeightKg: kg(h.grossWeightKg),
      tareWeightKg: kg(h.tareWeightKg),
      netWeightKg: kg(h.netWeightKg),
      terroir: h.terroirSnapshot ? { id: h.terroirId, ...h.terroirSnapshot, altitudeMasl: fixed(h.terroirSnapshot.altitudeMasl, 0) } : null,
      maturityAnalyses: harvestAnalyses(state, h.id).map((m) => ({ id: m.id, brixDegrees: degrees(m.brixDegrees), ph: degrees(m.ph), acidityGl: degrees(m.acidityGl), measuredAt: m.measuredAt, recordedBy: actorRef(m.recordedBy) })),
      phytoDecisions: harvestDecisions(state, h.id).map((d) => ({ id: d.id, decision: d.decision, decidedAt: d.decidedAt, decidedBy: actorRef(d.decidedBy), reportSha256: d.inspectionReport?.sha256 ?? null })),
    })),
    tanks: tanks.map((t) => ({
      id: t.id,
      tankCode: t.tankCode,
      startDate: t.startDate,
      endDate: t.endDate ?? null,
      destinationType: t.destinationType ?? null,
      volumeFilledLiters: liters(t.volumeFilledLiters),
      finalVolumeLiters: liters(t.finalVolumeLiters),
      inputs: (t.inputs ?? []).map((i) => ({ harvestBatchId: i.harvestBatchId, kg: kg(i.kg) })),
      readings: state.logs
        .filter((l) => l.fermentationTankId === t.id && !isVoided(state, 'FERMENTATION_LOG', l.id))
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))
        .map((l) => ({ id: l.id, recordedAt: l.recordedAt, temperatureCelsius: degrees(l.temperatureCelsius), specificGravity: fixed(l.specificGravity, 3), phValue: degrees(l.phValue) })),
      treatments: state.treatments
        .filter((x) => x.fermentationTankId === t.id && !isVoided(state, 'TREATMENT', x.id))
        .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.id.localeCompare(b.id))
        .map((x) => ({ id: x.id, treatmentType: x.treatmentType, additiveName: x.additiveName, dosageAppliedGPerHl: degrees(x.dosageAppliedGPerHl), regulatoryAuthCode: x.regulatoryAuthCode, appliedAt: x.appliedAt })),
    })),
    agings: lotAgings(state, lot.id).map((a) => ({ id: a.id, fermentationTankId: a.fermentationTankId, containerType: a.containerType, containerMaterial: a.containerMaterial ?? null, plannedMonths: a.plannedMonths, volumeLiters: liters(a.volumeLiters), startDate: a.startDate, unlockDate: a.lockUntilDate.slice(0, 10), status: a.agingStatus })),
    distillations: lotProductions(state, lot.id).map((p) => ({
      id: p.id,
      fermentationTankId: p.fermentationTankId,
      equipmentIdentifier: p.equipmentIdentifier,
      processStartDate: p.processStartDate.slice(0, 10),
      processEndDate: p.processEndDate?.slice(0, 10) ?? null,
      inputVolumeLiters: liters(p.inputVolumeLiters),
      headsLiters: liters(p.headsLiters),
      heartLiters: liters(p.heartLiters ?? p.outputVolumeLiters),
      tailsLiters: liters(p.tailsLiters),
      vinasseLiters: liters(p.vinasseLiters),
      heartAbvPercent: degrees(p.heartAbvPercent ?? p.initialAlcoholPercentage),
      restUntil: p.mandatoryRestUntil?.slice(0, 10) ?? null,
      status: p.restStatus,
    })),
    bottling: bottling
      ? {
          id: bottling.id,
          lotCode: bottling.internationalLotCode,
          bottlingDate: bottling.bottlingDate.slice(0, 10),
          bottles: bottling.totalBottlesPackaged,
          formatCl: bottling.packagingFormatCl,
          finalAlcoholAbv: degrees(bottling.finalAlcoholAbv),
          waterDilutionLiters: liters(bottling.waterDilutionLiters ?? 0),
          balance: bottling.balance
            ? {
                availableLiters: liters(bottling.balance.availableLiters),
                bottledLiters: liters(bottling.balance.bottledLiters),
                leftoverLiters: liters(bottling.balance.leftoverLiters),
                lossLiters: liters(bottling.balance.lossLiters),
                lossPercent: degrees(bottling.balance.lossPercent),
                maxLossPercent: degrees(bottling.balance.maxLossPercent),
                pureAlcohol: bottling.balance.pureAlcohol ? { availableLiters: liters(bottling.balance.pureAlcohol.availableLiters), bottledLiters: liters(bottling.balance.pureAlcohol.bottledLiters) } : null,
              }
            : null,
          releasedBy: bottling.releasedByMemberId ? { membershipId: bottling.releasedByMemberId } : null,
        }
      : null,
    labAnalyses: lotLabs(state, lot.id).map((l) => ({
      id: l.id,
      laboratory: l.certifiedLaboratoryName,
      certificationCode: l.accreditedLabCertificationCode,
      testPerformedAt: l.testPerformedAt.slice(0, 10),
      actualAlcoholAbv: degrees(l.actualAlcoholAbv),
      volatileAcidityAceticGl: degrees(l.volatileAcidityAceticGl),
      methanolMg100mlAa: fixed(l.methanolMg100mlAa, 3),
      copperContentMgL: fixed(l.copperContentMgL, 3),
      conformity: l.conformity ? { status: l.conformity.status, checks: l.conformity.checks.map((c) => ({ parameter: c.parameter, value: fixed(c.value, 3), unit: c.unit, limit: c.limit, result: c.result })) } : null,
      current: !l.supersededAt,
      reportSha256: l.report?.sha256 ?? null,
    })),
    corrections: state.corrections
      .filter((c) => c.lotId === lot.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((c) => ({ id: c.id, target: c.target, kind: c.kind, changes: c.changes, reason: c.reason, createdAt: c.createdAt, createdBy: actorRef(c.createdBy) })),
    attachments: attachments.map((a) => ({ kind: a.kind, sha256: a.sha256 })).sort((a, b) => a.sha256.localeCompare(b.sha256)),
    bottleCodes: tree ? { count: tree.count, merkleRoot: tree.root, algorithm: BOTTLE_MERKLE_ALGORITHM } : null,
    closedAt,
  }
  return canonicalJson(doc)
}

/** Requisitos del cierre del expediente (§10) y la huella que tendría si se cerrara ahora. */
export function dossierPreview(state: TraceState, ctx: TraceCtx, lot: Lot): DossierPreview {
  const bottling = lotBottling(state, lot.id)
  const bl = bottleLotOf(state, lot.id)
  const lab = currentLab(state, lot.id)
  const openIssues = lot.complianceIssues.filter((i) => !i.resolvedAt).length
  const openSources = lotAgings(state, lot.id).filter(isAgingOpen).length + lotProductions(state, lot.id).filter(isProductionOpen).length
  const labMessage = !lab
    ? 'Falta registrar el análisis de laboratorio'
    : lab.conformityStatus === 'CONFORMING'
      ? 'Laboratorio conforme'
      : lab.conformityStatus === 'NON_CONFORMING'
        ? 'El análisis vigente no es conforme: reanaliza o descarta el lote'
        : 'El análisis vigente está incompleto: falta un parámetro exigido'
  const requirements: DossierPreview['requirements'] = [
    { key: 'BOTTLED', met: Boolean(bottling), message: bottling ? `Embotellado ${bottling.internationalLotCode} registrado` : 'El lote aún no está embotellado' },
    { key: 'LAB_CONFORMING', met: lab?.conformityStatus === 'CONFORMING', message: labMessage },
    {
      key: 'BOTTLE_CODES_READY',
      met: Boolean(bottling && bl && bl.total === bottling.totalBottlesPackaged),
      message: bl ? `${bl.total} códigos de botella generados` : 'Los códigos de botella se generan al embotellar',
    },
    { key: 'NO_OPEN_COMPLIANCE_ISSUES', met: openIssues === 0, message: openIssues === 0 ? 'Sin incidencias de cumplimiento abiertas' : `${openIssues} incidencia(s) de cumplimiento abierta(s)` },
    { key: 'NO_OPEN_SOURCES', met: openSources === 0, message: openSources === 0 ? 'Todas las crianzas y destilaciones están cerradas' : `${openSources} fuente(s) abierta(s) sin embotellar ni descartar` },
  ]
  const closed = lotDossier(state, lot.id)
  return {
    ready: requirements.every((r) => r.met),
    requirements,
    hashPreview: closed?.status === 'CLOSED' ? closed.hash : bottling ? sha256Hex(canonicalDossier(state, lot, ctx.now, ctx.lotPrefix(lot.wineryId))) : null,
  }
}

/** Expediente del lote (`OPEN` mientras no se cierre). */
export function dossierOf(state: TraceState, lot: Lot): LotDossier {
  const stored = lotDossier(state, lot.id)
  if (stored) {
    const dossier: StoredDossier = { ...stored }
    delete dossier.canonical
    return dossier
  }
  return { lotId: lot.id, schema: DOSSIER_SCHEMA_VERSION, status: 'OPEN', hash: null, algorithm: DOSSIER_HASH_ALGORITHM, closedAt: null, closedBy: null, bottleCodes: null, anchor: null }
}

/** Bytes canónicos del expediente: los que se hashearon al cerrarlo o los que se hashearían ahora. */
export function dossierCanonical(state: TraceState, ctx: Pick<TraceCtx, 'lotPrefix'>, lot: Lot): string {
  const stored = lotDossier(state, lot.id)
  if (stored?.status === 'CLOSED') {
    stored.canonical ??= canonicalDossier(state, lot, stored.closedAt, ctx.lotPrefix(lot.wineryId))
    return stored.canonical
  }
  return canonicalDossier(state, lot, null, ctx.lotPrefix(lot.wineryId))
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
      preview.requirements.filter((r) => !r.met).map((r) => violation('TRC_DOSSIER_NOT_READY', r.message, { meta: { requirement: r.key } })),
    )
  }
  const bl = bottleLotOf(state, lot.id) as BottleLot
  const canonical = canonicalDossier(state, lot, ctx.now, ctx.lotPrefix(lot.wineryId))
  const tree = bottleMerkleTree(bl, ctx.now)
  const dossier: StoredDossier = {
    lotId: lot.id,
    schema: DOSSIER_SCHEMA_VERSION,
    status: 'CLOSED',
    hash: sha256Hex(canonical),
    algorithm: DOSSIER_HASH_ALGORITHM,
    closedAt: ctx.now,
    closedBy: ctx.actor,
    bottleCodes: { count: tree.count, merkleRoot: tree.root, algorithm: BOTTLE_MERKLE_ALGORITHM },
    anchor: null,
    canonical,
  }
  state.dossiers = state.dossiers.filter((d) => d.lotId !== lot.id)
  state.dossiers.push(dossier)
  refreshLotStage(state, ctx, lot)
  appendLotEvent(state, ctx, lot, {
    type: 'DOSSIER_CLOSED',
    occurredAt: ctx.now,
    summary: `Expediente cerrado con la huella ${dossier.hash?.slice(0, 12)}…`,
    data: { hash: dossier.hash, algorithm: DOSSIER_HASH_ALGORITHM, bottleCodes: tree.count },
    resource: { type: 'lot_dossier', id: lot.id },
  })
  return dossier
}
