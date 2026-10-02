import { recordAudit } from '../../../backoffice/handlers/support'
import {
  ChangeLotAttachmentVisibilitySchema,
  CloseDossierSchema,
  CreateBottleCodeExportSchema,
  CreateLotAttachmentSchema,
  CreateLotBottlingSchema,
  CreateLotCorrectionSchema,
  CreateLotLabAnalysisSchema,
  CreateLotSchema,
  DiscardLotSchema,
  LOT_PRODUCT_TYPES,
  LOT_STAGE_CODES,
  UpdateLotSchema,
  VoidBottleCodeSchema,
  type BottlingPreview,
  type CorrectionTargetType,
  type Lot,
  type LotStageCode,
  type WineryRole,
} from '../../schemas'
import { BOTTLE_UNIT_STATUSES, type BottleCodeExport } from '../../schemas/bottle-codes'
import { assertNotBottled, bottleLot, evaluateBottling, exportBottleCodesCsv, listBottleUnits, lotBottlingRequest, registerLab, serialRange, voidBottleCode } from '../../trace/bottling'
import { daysBetween } from '../../trace/dates'
import {
  addAttachment,
  changeAttachmentVisibility,
  closeDossier,
  correctLot,
  dossierCanonical,
  dossierOf,
  dossierPreview,
  lotAttachments,
  signedFileUrl,
  toAttachment,
} from '../../trace/dossier'
import { discardLot, updateLot } from '../../trace/lots'
import { violation } from '../../trace/rules'
import {
  bottleLotOf,
  createLot,
  findLot,
  lotBottling,
  lotLabs,
  stateError,
  toLotSummary,
  toLotView,
  type StoredBottleExport,
} from '../../trace/state'
import {
  lotBalance,
  lotGraph,
  lotTimeline,
  PRODUCTION_REPORT_MAX_ROWS,
  productionReport,
  productionReportCsv,
  traceDashboard,
} from '../../trace/views'
import { anyUser, trace, TRACE_READERS, type AuthContext } from '../auth-context'
import { getErpDb, tick } from '../db'
import { ApiError, fieldError, forbidden, invalid, notFound } from '../errors'
import { accepted, created, enumParam, intParam, listResult, ok, parseBody, parseCreateBody, strParam, type RouteContext, type RouteSpec } from '../http'
import { traceCtx } from '../trace-context'
import { bottlingView, labView } from '../views'
import { requireWinery } from './terroirs-harvest'

// /v1/lots* (contrato de la Ola 2 §2 y §6–§11): el lote del servidor con su embotellado, códigos de
// botella, laboratorio, correcciones, expediente, vistas y adjuntos; más el panel y el reporte de
// la bodega. La plataforma solo lee, con `?wineryId=`.

const LOT_WRITERS = ['OWNER', 'ENOLOGIST'] as const

/** Lote de la bodega de la petición (o de cualquiera, para la plataforma sin `?wineryId=`). */
const lotOf = (auth: AuthContext, id: string, writable = false): Lot => findLot(getErpDb(), id, auth.tenantId, { writable })
const lotViewOf = (auth: AuthContext, lot: Lot) => toLotView(getErpDb(), lot, traceCtx(auth))

/** Etapas de un filtro `stage=A,B`; una desconocida → 422. */
function stagesParam(query: URLSearchParams): LotStageCode[] | undefined {
  const raw = strParam(query, 'stage')
  if (!raw) return undefined
  const stages = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = stages.filter((s) => !(LOT_STAGE_CODES as readonly string[]).includes(s))
  if (unknown.length > 0) throw invalid([fieldError('stage', `Etapas desconocidas: ${unknown.join(', ')} (válidas: ${LOT_STAGE_CODES.join(', ')})`)])
  return stages as LotStageCode[]
}

/** Quién puede corregir cada registro: el rol que puede crearlo (S-17). */
const CORRECTION_ROLES: Record<CorrectionTargetType, readonly WineryRole[]> = {
  TERROIR: ['OWNER', 'AGRONOMIST'],
  HARVEST_BATCH: ['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR'],
  MATURITY_ANALYSIS: ['OWNER', 'ENOLOGIST', 'AGRONOMIST'],
  PHYTO_DECISION: ['OWNER', 'ENOLOGIST', 'AGRONOMIST'],
  FERMENTATION_TANK: LOT_WRITERS,
  FERMENTATION_LOG: ['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR'],
  TREATMENT: LOT_WRITERS,
  WINE_AGING: LOT_WRITERS,
  PRODUCTION_BATCH: LOT_WRITERS,
  BOTTLING: LOT_WRITERS,
  LAB_ANALYSIS: LOT_WRITERS,
}

/** Bitácora de una acción sobre el lote (contrato §15). */
function audit(ctx: RouteContext, action: string, lot: Lot, resource: { type: string; id: string | null }, after: Record<string, unknown> | null, reason: string | null = null): void {
  recordAudit(ctx, { action, resource, organizationId: lot.wineryId, after: { reference: lot.reference, ...after }, reason })
}

/** Estado de una exportación ZIP: el worker la deja lista poco después (aquí, a la segunda consulta). */
function exportView(ctx: RouteContext, e: StoredBottleExport): BottleCodeExport {
  const ready = e.status === 'READY'
  return {
    exportId: e.exportId,
    status: e.status,
    rows: e.rows,
    createdAt: e.createdAt,
    createdBy: e.createdBy,
    downloadUrl: ready ? signedFileUrl(traceCtx(ctx.auth), `org/${ctx.auth.tenantId ?? 'platform'}/exports/${e.exportId}.zip`).url : null,
    expiresAt: e.expiresAt,
  }
}

export const lotRoutes: RouteSpec[] = [
  // ----- Lote -----
  {
    method: 'get',
    path: '/v1/lots',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle({ query, auth }) {
      const db = getErpDb()
      const ctx = traceCtx(auth)
      const stages = stagesParam(query)
      const productType = enumParam(query, 'productType', LOT_PRODUCT_TYPES)
      const year = intParam(query, 'harvestYear')
      const q = strParam(query, 'q')?.toLowerCase()
      const issues = enumParam(query, 'hasComplianceIssues', ['true', 'false'] as const)
      const dueWithin = intParam(query, 'lockDueWithinDays')
      const items = db.lots
        .filter((l) => (auth.tenantId ? l.wineryId === auth.tenantId : auth.isPlatformAdmin))
        .filter(
          (l) =>
            (!stages || stages.includes(l.stage)) &&
            (!productType || l.productType === productType) &&
            (year === undefined || l.harvestYear === year) &&
            (!q || [l.name, l.reference, l.lotCode ?? ''].some((text) => text.toLowerCase().includes(q))) &&
            (!issues || l.complianceIssues.some((i) => !i.resolvedAt) === (issues === 'true')),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .map((l) => toLotSummary(db, l, ctx))
        .filter((s) => dueWithin === undefined || (s.nextLock !== null && daysBetween(ctx.today, s.nextLock.unlockDate) <= dueWithin))
      return listResult(items, query)
    },
  },
  {
    method: 'post',
    path: '/v1/lots',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth } = ctx
      const wineryId = requireWinery(auth)
      const body = await parseCreateBody(request, CreateLotSchema)
      tick()
      const lot = createLot(getErpDb(), traceCtx(auth), wineryId, body)
      audit(ctx, 'LOT_CREATED', lot, { type: 'lot', id: lot.id }, { name: lot.name, harvestYear: lot.harvestYear, productType: lot.productType, estimatedBottles: lot.estimatedBottles, rulesTakenAt: lot.rules.takenAt })
      return created(lotViewOf(auth, lot))
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id',
    access: trace(TRACE_READERS),
    handle: ({ auth, params }) => ok(lotViewOf(auth, lotOf(auth, params.id!))),
  },
  {
    method: 'patch',
    path: '/v1/lots/:id',
    access: trace(LOT_WRITERS),
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = lotOf(auth, params.id!, true)
      const body = await parseBody(request, UpdateLotSchema)
      tick()
      updateLot(getErpDb(), traceCtx(auth), lot, body)
      const { reason, ...changes } = body
      audit(ctx, 'LOT_UPDATED', lot, { type: 'lot', id: lot.id }, changes, reason ?? null)
      return ok(lotViewOf(auth, lot))
    },
  },
  {
    method: 'post',
    path: '/v1/lots/:id/discard',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = lotOf(auth, params.id!, true)
      const body = await parseBody(request, DiscardLotSchema)
      tick()
      discardLot(getErpDb(), traceCtx(auth), lot, body.reason)
      audit(ctx, 'LOT_DISCARDED', lot, { type: 'lot', id: lot.id }, { stage: lot.stage }, body.reason)
      return ok(lotViewOf(auth, lot))
    },
  },

  // ----- Vistas (§11) -----
  {
    method: 'get',
    path: '/v1/lots/:id/timeline',
    access: trace(TRACE_READERS),
    handle: ({ auth, params }) => ok(lotTimeline(getErpDb(), traceCtx(auth), lotOf(auth, params.id!))),
  },
  {
    // SE-07: solo los miembros de la bodega dueña y el personal de plataforma; cualquier otra sesión → 404.
    method: 'get',
    path: '/v1/lots/:id/graph',
    access: anyUser,
    handle({ auth, params }) {
      const db = getErpDb()
      const lot = db.lots.find((l) => l.id === params.id)
      const owner = auth.organizationType === 'WINERY' && lot?.wineryId === auth.wineryId
      const staff = auth.organizationType === 'PLATFORM' && auth.platformRole !== null
      if (!lot || (!owner && !staff)) throw new ApiError(404, 'TRC_LOT_NOT_FOUND', 'Lote no encontrado')
      return ok(lotGraph(db, lot))
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id/balance',
    access: trace(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'ACCOUNTANT']),
    handle: ({ auth, params }) => ok(lotBalance(getErpDb(), lotOf(auth, params.id!))),
  },

  // ----- Embotellado (§6) -----
  {
    method: 'post',
    path: '/v1/lots/:id/bottling/preview',
    access: trace(LOT_WRITERS),
    async handle({ request, auth, params }) {
      const db = getErpDb()
      const lot = lotOf(auth, params.id!, true)
      assertNotBottled(db, lot)
      const body = await parseCreateBody(request, CreateLotBottlingSchema)
      const evaluation = evaluateBottling(db, traceCtx(auth), lot, lotBottlingRequest(db, lot, body))
      const preview: BottlingPreview = { valid: evaluation.valid, balance: evaluation.balance, violations: evaluation.violations }
      return ok(preview)
    },
  },
  {
    method: 'post',
    path: '/v1/lots/:id/bottling',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const db = getErpDb()
      const lot = lotOf(auth, params.id!)
      const body = await parseCreateBody(request, CreateLotBottlingSchema)
      tick()
      const bottling = bottleLot(db, traceCtx(auth), lot, lotBottlingRequest(db, lot, body))
      audit(ctx, 'BOTTLED', lot, { type: 'bottling_batch', id: bottling.id }, { lotCode: bottling.internationalLotCode, bottles: bottling.totalBottlesPackaged })
      return created(bottlingView(bottling, true))
    },
  },

  // ----- Códigos de botella (§7) -----
  {
    method: 'get',
    path: '/v1/lots/:id/bottle-codes',
    access: trace(LOT_WRITERS),
    list: 'paged',
    handle({ query, auth, params }) {
      const lot = lotOf(auth, params.id!)
      const units = listBottleUnits(getErpDb(), traceCtx(auth), lot, {
        status: enumParam(query, 'status', BOTTLE_UNIT_STATUSES),
        fromSerial: intParam(query, 'fromSerial'),
        toSerial: intParam(query, 'toSerial'),
      })
      return listResult(units, query)
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id/bottle-codes/export',
    access: trace(LOT_WRITERS),
    handle(ctx) {
      const { query, auth, params } = ctx
      enumParam(query, 'format', ['csv'] as const)
      const lot = lotOf(auth, params.id!)
      const csv = exportBottleCodesCsv(getErpDb(), traceCtx(auth), lot, intParam(query, 'fromSerial'), intParam(query, 'toSerial'))
      audit(ctx, 'BOTTLE_CODES_EXPORTED', lot, { type: 'lot', id: lot.id }, { format: 'CSV', fromSerial: csv.from, toSerial: csv.to, rows: csv.rows })
      return {
        status: 200,
        data: undefined,
        raw: { body: csv.body, contentType: 'text/csv; charset=utf-8' },
        headers: { 'Content-Disposition': `attachment; filename="codigos-${lot.lotCode ?? lot.reference}.csv"`, 'Cache-Control': 'no-store', 'X-Export-Rows': String(csv.rows) },
      }
    },
  },
  {
    method: 'post',
    path: '/v1/lots/:id/bottle-codes/exports',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const db = getErpDb()
      const lot = lotOf(auth, params.id!)
      const body = await parseBody(request, CreateBottleCodeExportSchema)
      const bl = lotBottling(db, lot.id) ? bottleLotOf(db, lot.id) : null
      if (!bl) throw stateError('TRC_LOT_NOT_BOTTLED', 'El lote aún no está embotellado: no tiene códigos de botella', [violation('TRC_LOT_NOT_BOTTLED', 'Lote sin embotellar', { meta: { stage: lot.stage } })])
      const { from, to } = serialRange(bl, body.fromSerial, body.toSerial)
      tick()
      const tctx = traceCtx(auth)
      if (!tctx.actor) throw forbidden('Solo un miembro de la bodega puede exportar códigos')
      const record: StoredBottleExport = {
        lotId: lot.id,
        exportId: tctx.newId('bottle-export'),
        status: 'PENDING',
        rows: to - from + 1,
        createdAt: tctx.now,
        createdBy: tctx.actor,
        downloadUrl: null,
        expiresAt: new Date(Date.parse(tctx.now) + 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        fromSerial: from,
        toSerial: to,
        imageFormat: body.qr.imageFormat,
        polls: 0,
      }
      db.bottleExports.push(record)
      bl.exports.push({ fromSerial: from, toSerial: to, at: tctx.now })
      audit(ctx, 'BOTTLE_CODES_EXPORTED', lot, { type: 'lot', id: lot.id }, { format: 'ZIP', fromSerial: from, toSerial: to, rows: record.rows, imageFormat: body.qr.imageFormat })
      return accepted({ exportId: record.exportId, status: 'PENDING' })
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id/bottle-codes/exports/:exportId',
    access: trace(LOT_WRITERS),
    handle(ctx) {
      const { auth, params } = ctx
      const lot = lotOf(auth, params.id!)
      const record = getErpDb().bottleExports.find((e) => e.exportId === params.exportId && e.lotId === lot.id)
      if (!record) throw notFound('Exportación no encontrada')
      const view = exportView(ctx, record)
      // La primera consulta la ve pendiente; a partir de la segunda, el ZIP ya está listo.
      record.polls++
      if (record.status === 'PENDING') record.status = 'READY'
      return ok(view)
    },
  },
  {
    method: 'post',
    path: '/v1/bottle-codes/:code/void',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const wineryId = requireWinery(auth)
      const body = await parseBody(request, VoidBottleCodeSchema)
      tick()
      const unit = voidBottleCode(getErpDb(), traceCtx(auth), wineryId, decodeURIComponent(params.code!), body)
      const lot = lotOf(auth, unit.lotId)
      audit(ctx, 'BOTTLE_CODE_VOIDED', lot, { type: 'lot', id: lot.id }, { serial: unit.serial, replaced: unit.voided?.replacedBy !== null }, body.reason)
      return ok(unit)
    },
  },

  // ----- Laboratorio (§8) -----
  {
    method: 'post',
    path: '/v1/lots/:id/lab-analyses',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = lotOf(auth, params.id!)
      const body = await parseCreateBody(request, CreateLotLabAnalysisSchema)
      tick()
      const lab = registerLab(getErpDb(), traceCtx(auth), lot, body)
      audit(ctx, 'LAB_REGISTERED', lot, { type: 'lab_analysis', id: lab.id }, { conformity: lab.conformityStatus })
      return created(labView(lab))
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id/lab-analyses',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle({ query, auth, params }) {
      const lot = lotOf(auth, params.id!)
      // Todos los análisis del lote, el más reciente primero, con `current: true` en el vigente.
      return listResult([...lotLabs(getErpDb(), lot.id)].reverse().map((l) => labView(l)), query)
    },
  },

  // ----- Correcciones (§9) -----
  {
    method: 'post',
    path: '/v1/lots/:id/corrections',
    access: trace(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR']),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = lotOf(auth, params.id!)
      const body = await parseBody(request, CreateLotCorrectionSchema)
      if (auth.memberRole && !CORRECTION_ROLES[body.target.type].includes(auth.memberRole)) {
        throw forbidden(`Acceso denegado: el rol '${auth.memberRole}' no puede corregir este registro (lo corrige quien puede crearlo)`)
      }
      tick()
      const correction = correctLot(getErpDb(), traceCtx(auth), lot, body)
      audit(ctx, 'CORRECTION_REGISTERED', lot, { type: 'correction', id: correction.id }, { target: correction.target, kind: correction.kind, fields: correction.changes.map((c) => c.field) }, body.reason)
      return created(correction)
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id/corrections',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle({ query, auth, params }) {
      const lot = lotOf(auth, params.id!)
      const items = getErpDb()
        .corrections.filter((c) => c.lotId === lot.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return listResult(items, query)
    },
  },

  // ----- Expediente (§10) -----
  {
    method: 'get',
    path: '/v1/lots/:id/dossier/preview',
    access: trace(TRACE_READERS),
    handle: ({ auth, params }) => ok(dossierPreview(getErpDb(), traceCtx(auth), lotOf(auth, params.id!))),
  },
  {
    method: 'post',
    path: '/v1/lots/:id/dossier/close',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = lotOf(auth, params.id!)
      await parseBody(request, CloseDossierSchema)
      tick()
      closeDossier(getErpDb(), traceCtx(auth), lot)
      const dossier = dossierOf(getErpDb(), lot)
      audit(ctx, 'DOSSIER_CLOSED', lot, { type: 'lot', id: lot.id }, { hash: dossier.hash, bottleCodes: dossier.bottleCodes?.count ?? 0 })
      return ok(dossier)
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id/dossier',
    access: trace(TRACE_READERS),
    handle: ({ auth, params }) => ok(dossierOf(getErpDb(), lotOf(auth, params.id!))),
  },
  {
    // Los bytes exactos que se hashearon (o se hashearían), sin el envoltorio `data`.
    method: 'get',
    path: '/v1/lots/:id/dossier/canonical',
    access: trace(TRACE_READERS),
    handle({ auth, params }) {
      const lot = lotOf(auth, params.id!)
      return { status: 200, data: undefined, raw: { body: dossierCanonical(getErpDb(), traceCtx(auth), lot), contentType: 'application/json; charset=utf-8' } }
    },
  },

  // ----- Archivos del lote (§11.5) -----
  {
    method: 'post',
    path: '/v1/lots/:id/attachments',
    access: trace(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR']),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = lotOf(auth, params.id!)
      const body = await parseCreateBody(request, CreateLotAttachmentSchema)
      tick()
      const tctx = traceCtx(auth)
      const attachment = addAttachment(getErpDb(), tctx, lot, body)
      audit(ctx, 'ATTACHMENT_ADDED', lot, { type: 'lot_attachment', id: attachment.id }, { kind: attachment.kind, visibility: attachment.visibility })
      return created(toAttachment(tctx, attachment))
    },
  },
  {
    method: 'get',
    path: '/v1/lots/:id/attachments',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle({ query, auth, params }) {
      const lot = lotOf(auth, params.id!)
      const tctx = traceCtx(auth)
      return listResult(lotAttachments(getErpDb(), lot).map((a) => toAttachment(tctx, a)), query)
    },
  },
  {
    method: 'post',
    path: '/v1/lots/:id/attachments/:attachmentId/visibility',
    access: trace(LOT_WRITERS),
    idempotent: true,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = lotOf(auth, params.id!)
      const body = await parseBody(request, ChangeLotAttachmentVisibilitySchema)
      tick()
      const tctx = traceCtx(auth)
      const attachment = changeAttachmentVisibility(getErpDb(), tctx, lot, params.attachmentId!, body)
      audit(ctx, 'ATTACHMENT_VISIBILITY_CHANGED', lot, { type: 'lot_attachment', id: attachment.id }, { visibility: attachment.visibility })
      return ok(toAttachment(tctx, attachment))
    },
  },

  // ----- Panel y reportes de la bodega (§11.2, §11.4) -----
  {
    method: 'get',
    path: '/v1/traceability/dashboard',
    access: trace(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'ACCOUNTANT']),
    handle: ({ auth }) => ok(traceDashboard(getErpDb(), traceCtx(auth), auth.tenantId)),
  },
  {
    method: 'get',
    path: '/v1/traceability/reports/production',
    access: trace(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
    handle({ query, auth }) {
      const format = enumParam(query, 'format', ['json', 'csv'] as const) ?? 'json'
      const day = (name: string) => {
        const value = strParam(query, name)
        if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid([fieldError(name, `${name} debe tener el formato YYYY-MM-DD`)])
        return value
      }
      const report = productionReport(getErpDb(), {
        wineryId: auth.tenantId,
        from: day('from'),
        to: day('to'),
        productType: enumParam(query, 'productType', LOT_PRODUCT_TYPES),
        stages: stagesParam(query),
      })
      if (report.rows.length > PRODUCTION_REPORT_MAX_ROWS) {
        throw new ApiError(422, 'TRC_REPORT_TOO_LARGE', `El reporte tiene más de ${PRODUCTION_REPORT_MAX_ROWS} filas: acota las fechas`, [
          violation('TRC_REPORT_TOO_LARGE', 'Demasiadas filas', { meta: { rows: report.rows.length } }),
        ])
      }
      if (format === 'json') return ok(report)
      return {
        status: 200,
        data: undefined,
        raw: { body: productionReportCsv(report), contentType: 'text/csv; charset=utf-8' },
        headers: { 'Content-Disposition': 'attachment; filename="reporte-de-produccion.csv"', 'Cache-Control': 'no-store', 'X-Export-Rows': String(report.rows.length) },
      }
    },
  },
]
