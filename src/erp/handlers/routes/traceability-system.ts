import { buildPublicPassport } from '../../derive'
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_MIME_TYPES,
  type HealthStatus,
  type TraceabilityDag,
  type TraceabilityDagNode,
  type UploadResponse,
} from '../../schemas'
import { anyUser, members } from '../auth-context'
import { CLOCK_START, getErpDb, nextSeq, tick } from '../db'
import { ApiError, notFound } from '../errors'
import { created, ok, strParam, type RouteSpec } from '../http'
import { findBottling } from './bottling-lab'

// /v1/traceability/*, /v1/uploads, /v1/health

function buildDag(bottlingId: string, auth: Parameters<typeof findBottling>[0]): TraceabilityDag {
  const db = getErpDb()
  const b = findBottling(auth, bottlingId)
  const nodes: TraceabilityDagNode[] = []
  const edges: TraceabilityDag['edges'] = []
  const add = (node: TraceabilityDagNode, parent?: string) => {
    nodes.push(node)
    if (parent) edges.push({ from: parent, to: node.id })
  }
  const aging = b.wineAgingBatchId ? db.wineAgings.find((a) => a.id === b.wineAgingBatchId) : undefined
  const production = b.productionBatchId ? db.productionBatches.find((p) => p.id === b.productionBatchId) : undefined
  const tank = db.tanks.find((t) => t.id === (aging?.fermentationTankId ?? production?.fermentationTankId))
  const harvest = tank ? db.harvestBatches.find((h) => h.id === tank.harvestBatchId) : undefined
  const terroir = harvest ? db.terroirs.find((t) => t.id === harvest.terroirId) : undefined
  const lab = db.labAnalyses.find((l) => l.bottlingBatchId === b.id)

  if (terroir) add({ id: terroir.id, type: 'TERROIR', label: terroir.parcelName, date: terroir.createdAt, data: { ...terroir } })
  if (harvest) add({ id: harvest.id, type: 'HARVEST_BATCH', label: harvest.harvestBatchCode, date: harvest.intakeDate, data: { ...harvest } }, terroir?.id)
  if (tank) add({ id: tank.id, type: 'FERMENTATION_TANK', label: tank.tankCode, date: tank.startDate, data: { ...tank } }, harvest?.id)
  if (aging) add({ id: aging.id, type: 'WINE_AGING', label: aging.containerCode ?? aging.containerType, date: aging.createdAt, data: { ...aging } }, tank?.id)
  if (production) add({ id: production.id, type: 'PRODUCTION_BATCH', label: production.equipmentIdentifier, date: production.processStartDate, data: { ...production } }, tank?.id)
  add({ id: b.id, type: 'BOTTLING_BATCH', label: b.internationalLotCode, date: b.bottlingDate, data: { ...b } }, aging?.id ?? production?.id)
  if (lab) add({ id: lab.id, type: 'LAB_ANALYSIS', label: lab.accreditedLabCertificationCode, date: lab.testPerformedAt, data: { ...lab } }, b.id)

  return { bottlingBatchId: b.id, lotCode: b.internationalLotCode, nodes, edges }
}

export const traceabilitySystemRoutes: RouteSpec[] = [
  {
    method: 'get',
    path: '/v1/traceability/dag/:bottlingBatchId',
    access: members,
    handle: ({ auth, params }) => ok(buildDag(params.bottlingBatchId!, auth)),
  },
  {
    method: 'get',
    path: '/v1/traceability/public/:lotCode',
    access: 'public',
    handle({ params }) {
      const code = decodeURIComponent(params.lotCode!)
      const db = getErpDb()
      const b = db.bottlings.find((x) => x.internationalLotCode.toUpperCase() === code.toUpperCase() || x.id === code)
      if (!b) throw notFound(`Lote de embotellado con identificador "${code}" no encontrado`)
      return ok(
        buildPublicPassport(b, {
          wineries: db.wineries,
          terroirs: db.terroirs,
          harvestBatches: db.harvestBatches,
          tanks: db.tanks,
          wineAgings: db.wineAgings,
          productionBatches: db.productionBatches,
          labAnalyses: db.labAnalyses,
        }),
      )
    },
  },
  {
    method: 'post',
    path: '/v1/uploads',
    access: anyUser,
    async handle({ request, query }) {
      let form: FormData
      try {
        form = await request.formData()
      } catch {
        throw new ApiError(400, 'BAD_REQUEST', 'Archivo faltante: envíe multipart/form-data con el campo "file"')
      }
      const file = form.get('file')
      if (!file || typeof file === 'string') {
        throw new ApiError(400, 'BAD_REQUEST', 'Archivo faltante: envíe multipart/form-data con el campo "file"')
      }
      if (file.size > UPLOAD_MAX_BYTES) throw new ApiError(400, 'BAD_REQUEST', 'El archivo excede el tamaño máximo (15MB)')
      if (!(UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
        throw new ApiError(400, 'BAD_REQUEST', `Tipo MIME no permitido: ${file.type || 'desconocido'}`)
      }
      const folder = (strParam(query, 'folder') ?? 'misc').replace(/[^a-z0-9-]/gi, '')
      const name = (file.name || 'archivo').replace(/[^\w.-]+/g, '-')
      tick()
      const key = `${folder}/${getErpDb().clock + nextSeq('upload')}-${name}`
      const upload: UploadResponse = {
        url: `/mocks/uploads/${key}`,
        key,
        originalName: file.name || name,
        mimeType: file.type,
        sizeBytes: file.size,
      }
      return created(upload)
    },
  },
  {
    method: 'get',
    path: '/v1/health',
    access: 'public',
    handle() {
      const health: HealthStatus = {
        status: 'ok',
        database: 'connected',
        redis: 'connected',
        uptime: (getErpDb().clock - CLOCK_START) / 1000 + 1,
      }
      return ok(health)
    },
  },
]
