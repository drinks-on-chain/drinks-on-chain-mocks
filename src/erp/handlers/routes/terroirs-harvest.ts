import { normalizeDateTime } from '../../../shared/dates'
import {
  CreateHarvestBatchSchema,
  CreateTerroirSchema,
  HARVEST_LAB_FIELDS,
  PHYTOSANITARY_STATUSES,
  UpdatePhytoStatusSchema,
  UpdateTerroirSchema,
  type HarvestBatchDetail,
  type HarvestBatchResponse,
  type TerroirDetail,
  type TerroirResponse,
} from '../../schemas'
import { canSee, members, roles, scoped, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick } from '../db'
import { badRequest, forbidden, notFound, unprocessable } from '../errors'
import {
  applyPatch,
  boolParam,
  created,
  enumParam,
  intParam,
  listResult,
  ok,
  parseBody,
  readJson,
  strParam,
  validate,
  type RouteSpec,
} from '../http'

// /v1/terroirs* y /v1/harvest-batches*

export function findTerroir(auth: AuthContext, id: string): TerroirResponse {
  const t = getErpDb().terroirs.find((x) => x.id === id)
  if (!t || !canSee(auth, t.wineryId)) throw notFound(`Parcela con identificador "${id}" no encontrada`)
  return t
}

export function findHarvest(auth: AuthContext, id: string): HarvestBatchResponse {
  const h = getErpDb().harvestBatches.find((x) => x.id === id)
  if (!h || !canSee(auth, h.wineryId)) throw notFound(`Lote de vendimia con identificador "${id}" no encontrado`)
  return h
}

/** Bodega activa obligatoria para dar de alta entidades. */
export function requireWinery(auth: AuthContext): string {
  if (!auth.wineryId) throw forbidden('El usuario no tiene una bodega activa')
  return auth.wineryId
}

function harvestSlug(parcelName: string): string {
  const last = parcelName.split('·').at(-1)?.trim().split(/\s+/).at(-1) ?? 'LOTE'
  return last.toUpperCase()
}

export const terroirHarvestRoutes: RouteSpec[] = [
  // ----- Terroirs -----
  {
    method: 'post',
    path: '/v1/terroirs',
    access: roles(['WINERY_ADMIN', 'AGRONOMIST']),
    async handle({ request, auth }) {
      const wineryId = requireWinery(auth)
      const body = await parseBody(request, CreateTerroirSchema)
      const terroir: TerroirResponse = {
        id: newId('terroir'),
        wineryId,
        parcelName: body.parcelName,
        cadastreCode: body.cadastreCode ?? null,
        surfaceHectares: body.surfaceHectares,
        altitudeMasl: body.altitudeMasl,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        geographicPolygonGeojson: body.geographicPolygonGeojson ?? null,
        rawMaterialType: body.rawMaterialType,
        varietyName: body.varietyName,
        soilType: body.soilType ?? null,
        irrigationSystem: body.irrigationSystem ?? null,
        isDoEligible: body.isDoEligible ?? false,
        doType: body.doType ?? null,
        doCertificateUrl: body.doCertificateUrl ?? null,
        isActive: true,
        createdAt: tick(),
      }
      getErpDb().terroirs.push(terroir)
      return created(terroir)
    },
  },
  {
    method: 'get',
    path: '/v1/terroirs',
    access: roles(['WINERY_ADMIN', 'AGRONOMIST', 'ENOLOGIST'], { adminReads: true }),
    list: 'paged',
    handle({ query, auth }) {
      const isDoEligible = boolParam(query, 'isDoEligible')
      const isActive = boolParam(query, 'isActive')
      const variety = strParam(query, 'varietyName')?.toLowerCase()
      const raw = strParam(query, 'rawMaterialType')?.toLowerCase()
      const items = scoped(auth, getErpDb().terroirs).filter(
        (t) =>
          (isDoEligible === undefined || t.isDoEligible === isDoEligible) &&
          (isActive === undefined || t.isActive === isActive) &&
          (!variety || t.varietyName.toLowerCase().includes(variety)) &&
          (!raw || t.rawMaterialType.toLowerCase() === raw),
      )
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/terroirs/:id',
    access: roles(['WINERY_ADMIN', 'AGRONOMIST', 'ENOLOGIST'], { adminReads: true }),
    handle({ auth, params }) {
      const t = findTerroir(auth, params.id!)
      const detail: TerroirDetail = { ...t, harvestBatches: getErpDb().harvestBatches.filter((h) => h.terroirId === t.id) }
      return ok(detail)
    },
  },
  {
    method: 'patch',
    path: '/v1/terroirs/:id',
    access: roles(['WINERY_ADMIN', 'AGRONOMIST']),
    async handle({ request, auth, params }) {
      const t = findTerroir(auth, params.id!)
      const body = await parseBody(request, UpdateTerroirSchema)
      return ok(applyPatch(t, body))
    },
  },

  // ----- Lotes de vendimia (pesaje) -----
  {
    method: 'post',
    path: '/v1/harvest-batches',
    access: roles(['WINERY_ADMIN', 'AGRONOMIST', 'ENOLOGIST']),
    async handle({ request, auth }) {
      const wineryId = requireWinery(auth)
      // Regla del backend: Brix, pH y acidez obligatorios en el alta (doc 09 §4 y §8 punto 6).
      const raw = await readJson(request)
      const fields = (raw ?? {}) as Record<string, unknown>
      const missing = HARVEST_LAB_FIELDS.filter((f) => fields[f] === undefined || fields[f] === null || fields[f] === '')
      if (missing.length > 0) {
        throw unprocessable(
          'Brix, pH y acidez son obligatorios al registrar el pesaje',
          missing.map((f) => `${f} es obligatorio`),
        )
      }
      const body = validate(raw, CreateHarvestBatchSchema)
      if (body.grossWeightKg <= body.tareWeightKg) throw badRequest('El peso bruto debe ser mayor que la tara')
      const terroir = getErpDb().terroirs.find((t) => t.id === body.terroirId && t.wineryId === wineryId)
      if (!terroir) throw notFound('Parcela no encontrada en esta bodega')
      const db = getErpDb()
      const seq = String(db.harvestBatches.length + 1).padStart(2, '0')
      const createdAt = tick()
      const harvest: HarvestBatchResponse = {
        id: newId('harvest'),
        wineryId,
        terroirId: terroir.id,
        harvestBatchCode: `HARV-${body.harvestYear}-${harvestSlug(terroir.parcelName)}-${seq}`,
        intakeDate: normalizeDateTime(body.intakeDate),
        harvestYear: body.harvestYear,
        grossWeightKg: body.grossWeightKg,
        tareWeightKg: body.tareWeightKg,
        netWeightKg: body.grossWeightKg - body.tareWeightKg,
        brixDegrees: body.brixDegrees,
        initialPh: body.initialPh,
        initialAcidityGl: body.initialAcidityGl,
        temperatureAtIntakeC: body.temperatureAtIntakeC ?? null,
        phytosanitaryStatus: body.phytosanitaryStatus ?? 'PENDING_INSPECTION',
        phytoInspectionPdfUrl: null,
        certifiedByMemberId: null,
        notes: body.notes ?? null,
        createdAt,
      }
      db.harvestBatches.push(harvest)
      return created(harvest)
    },
  },
  {
    method: 'get',
    path: '/v1/harvest-batches',
    access: members,
    list: 'paged',
    handle({ query, auth }) {
      const year = intParam(query, 'harvestYear')
      const terroirId = strParam(query, 'terroirId')
      const status = enumParam(query, 'phytosanitaryStatus', PHYTOSANITARY_STATUSES)
      const items = scoped(auth, getErpDb().harvestBatches).filter(
        (h) =>
          (year === undefined || h.harvestYear === year) &&
          (!terroirId || h.terroirId === terroirId) &&
          (!status || h.phytosanitaryStatus === status),
      )
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/harvest-batches/:id',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST', 'AGRONOMIST'], { adminReads: true }),
    handle({ auth, params }) {
      const h = findHarvest(auth, params.id!)
      const detail: HarvestBatchDetail = { ...h, fermentationTanks: getErpDb().tanks.filter((t) => t.harvestBatchId === h.id) }
      return ok(detail)
    },
  },
  {
    method: 'patch',
    path: '/v1/harvest-batches/:id/phyto-status',
    access: roles(['AGRONOMIST', 'ENOLOGIST']),
    async handle({ request, auth, params }) {
      const h = findHarvest(auth, params.id!)
      const body = await parseBody(request, UpdatePhytoStatusSchema)
      h.phytosanitaryStatus = body.phytosanitaryStatus
      if (body.phytoInspectionPdfUrl !== undefined) h.phytoInspectionPdfUrl = body.phytoInspectionPdfUrl
      if (body.notes !== undefined) h.notes = body.notes
      h.certifiedByMemberId = body.phytosanitaryStatus === 'PENDING_INSPECTION' ? null : auth.memberId
      return ok(h)
    },
  },
]
