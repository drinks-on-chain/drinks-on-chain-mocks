import {
  CreateHarvestBatchSchema,
  CreateMaturityAnalysisSchema,
  CreatePhytoDecisionSchema,
  CreateTerroirCorrectionSchema,
  CreateTerroirSchema,
  PHYTOSANITARY_STATUSES,
  TERROIR_NORMATIVE_FIELDS,
  UpdatePhytoStatusSchema,
  UpdateTerroirSchema,
  type HarvestBatchResponse,
  type TerroirResponse,
} from '../../schemas'
import { correctTerroir } from '../../trace/dossier'
import { addMaturityAnalysis, createHarvest, decidePhyto, harvestAnalyses, harvestDecisions } from '../../trace/records'
import { violation } from '../../trace/rules'
import { stateError } from '../../trace/state'
import { canSee, scoped, trace, TRACE_READERS, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick } from '../db'
import { fieldError, forbidden, invalid, notFound } from '../errors'
import { applyPatch, boolParam, created, enumParam, intParam, listResult, ok, parseBody, parseCreateBody, strParam, type RouteSpec } from '../http'
import { traceCtx } from '../trace-context'
import { harvestView, terroirView } from '../views'

// /v1/terroirs* y /v1/harvest-batches* (contrato de la Ola 2 §3: aptitud D.O. calculada, pesaje
// separado del análisis de madurez y del dictamen fitosanitario).

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

/** Bodega de la petición (la activa), obligatoria en las altas. */
export function requireWinery(auth: AuthContext): string {
  if (!auth.tenantId) throw forbidden('El usuario no tiene una bodega activa')
  return auth.tenantId
}

/** Crear un lote (`POST /v1/lots` o `newLot`) es del dueño y del enólogo (§14). */
export function assertCanCreateLot(auth: AuthContext): void {
  if (auth.memberRole === 'OWNER' || auth.memberRole === 'ENOLOGIST') return
  throw forbidden(`Acceso denegado: el rol '${auth.memberRole ?? ''}' no puede crear lotes`)
}

export const terroirHarvestRoutes: RouteSpec[] = [
  // ----- Terroirs -----
  {
    method: 'post',
    path: '/v1/terroirs',
    access: trace(['OWNER', 'AGRONOMIST']),
    async handle({ request, auth }) {
      const wineryId = requireWinery(auth)
      const body = await parseCreateBody(request, CreateTerroirSchema)
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
        // Se calcula al responder: el valor enviado se ignora (EA-03).
        isDoEligible: false,
        doType: body.doType ?? null,
        doCertificateUrl: body.doCertificateUrl ?? null,
        isActive: true,
        createdAt: tick(),
      }
      getErpDb().terroirs.push(terroir)
      return created(terroirView(terroir))
    },
  },
  {
    method: 'get',
    path: '/v1/terroirs',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle({ query, auth }) {
      const isDoEligible = boolParam(query, 'isDoEligible')
      const isActive = boolParam(query, 'isActive')
      const variety = strParam(query, 'varietyName')?.toLowerCase()
      const raw = strParam(query, 'rawMaterialType')?.toLowerCase()
      const items = scoped(auth, getErpDb().terroirs)
        .map((t) => terroirView(t))
        .filter(
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
    access: trace(TRACE_READERS),
    handle: ({ auth, params }) => ok(terroirView(findTerroir(auth, params.id!), true)),
  },
  {
    method: 'patch',
    path: '/v1/terroirs/:id',
    access: trace(['OWNER', 'AGRONOMIST']),
    async handle({ request, auth, params }) {
      const t = findTerroir(auth, params.id!)
      const body = await parseBody(request, UpdateTerroirSchema)
      // La aptitud D.O. se calcula: el valor enviado se ignora (EA-03).
      delete body.isDoEligible
      // Una parcela usada no cambia por PATCH sus campos con efecto normativo: se corrigen aparte (§3.1).
      const used = getErpDb().harvestBatches.some((h) => h.terroirId === t.id)
      const changed = TERROIR_NORMATIVE_FIELDS.filter((f) => body[f] !== undefined && body[f] !== t[f])
      if (used && changed.length > 0) {
        throw stateError('TRC_TERROIR_IN_USE', 'La parcela ya tiene pesajes: altitud, cepa y materia prima se cambian con una corrección', [
          violation('TRC_TERROIR_IN_USE', 'Parcela con pesajes', { field: changed[0], meta: { fields: changed } }),
        ])
      }
      tick()
      return ok(terroirView(applyPatch(t, body)))
    },
  },
  {
    method: 'post',
    path: '/v1/terroirs/:id/corrections',
    access: trace(['OWNER', 'AGRONOMIST']),
    idempotent: true,
    async handle({ request, auth, params }) {
      const t = findTerroir(auth, params.id!)
      const body = await parseBody(request, CreateTerroirCorrectionSchema)
      tick()
      return created(correctTerroir(getErpDb(), traceCtx(auth), t, body))
    },
  },

  // ----- Lotes de vendimia (pesaje) -----
  {
    method: 'post',
    path: '/v1/harvest-batches',
    access: trace(['OWNER', 'AGRONOMIST', 'ENOLOGIST', 'OPERATOR']),
    async handle({ request, auth }) {
      const wineryId = requireWinery(auth)
      const body = await parseCreateBody(request, CreateHarvestBatchSchema)
      if (body.newLot) assertCanCreateLot(auth)
      tick()
      return created(harvestView(createHarvest(getErpDb(), traceCtx(auth), wineryId, body)))
    },
  },
  {
    method: 'get',
    path: '/v1/harvest-batches',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle({ query, auth }) {
      const year = intParam(query, 'harvestYear')
      const terroirId = strParam(query, 'terroirId')
      const status = enumParam(query, 'phytosanitaryStatus', PHYTOSANITARY_STATUSES)
      // `lotId=none`: uva recibida sin lote (§2.5).
      const lotId = strParam(query, 'lotId')
      const items = scoped(auth, getErpDb().harvestBatches).filter(
        (h) =>
          (year === undefined || h.harvestYear === year) &&
          (!terroirId || h.terroirId === terroirId) &&
          (!status || h.phytosanitaryStatus === status) &&
          (!lotId || (lotId === 'none' ? h.lotId === null : h.lotId === lotId)),
      )
      return listResult(items.map((h) => harvestView(h)), query)
    },
  },
  {
    method: 'get',
    path: '/v1/harvest-batches/:id',
    access: trace(TRACE_READERS),
    handle: ({ auth, params }) => ok(harvestView(findHarvest(auth, params.id!), true)),
  },
  {
    method: 'post',
    path: '/v1/harvest-batches/:id/maturity-analyses',
    access: trace(['OWNER', 'ENOLOGIST', 'AGRONOMIST']),
    idempotent: true,
    async handle({ request, auth, params }) {
      const h = findHarvest(auth, params.id!)
      const body = await parseCreateBody(request, CreateMaturityAnalysisSchema)
      tick()
      return created(addMaturityAnalysis(getErpDb(), traceCtx(auth), h, body))
    },
  },
  {
    method: 'get',
    path: '/v1/harvest-batches/:id/maturity-analyses',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle: ({ query, auth, params }) => listResult(harvestAnalyses(getErpDb(), findHarvest(auth, params.id!).id), query),
  },
  {
    method: 'post',
    path: '/v1/harvest-batches/:id/phyto-decisions',
    access: trace(['OWNER', 'AGRONOMIST', 'ENOLOGIST']),
    idempotent: true,
    async handle({ request, auth, params }) {
      const h = findHarvest(auth, params.id!)
      const body = await parseCreateBody(request, CreatePhytoDecisionSchema)
      tick()
      return created(harvestView(decidePhyto(getErpDb(), traceCtx(auth), h, body), true))
    },
  },
  {
    method: 'get',
    path: '/v1/harvest-batches/:id/phyto-decisions',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle: ({ query, auth, params }) => listResult(harvestDecisions(getErpDb(), findHarvest(auth, params.id!).id), query),
  },
  {
    // Legado: alias de `POST …/phyto-decisions` hasta H2. Mismas reglas; ya no pisa las notas del pesaje.
    method: 'patch',
    path: '/v1/harvest-batches/:id/phyto-status',
    access: trace(['OWNER', 'AGRONOMIST', 'ENOLOGIST']),
    deprecated: '/v1/harvest-batches/{id}/phyto-decisions',
    async handle({ request, auth, params }) {
      const h = findHarvest(auth, params.id!)
      const body = await parseBody(request, UpdatePhytoStatusSchema)
      if (body.phytosanitaryStatus === 'PENDING_INSPECTION') {
        throw invalid([fieldError('phytosanitaryStatus', 'Indica el dictamen: APPROVED, REJECTED o QUARANTINE')])
      }
      tick()
      const harvest = decidePhyto(getErpDb(), traceCtx(auth), h, {
        decision: body.phytosanitaryStatus,
        legacyReportUrl: body.phytoInspectionPdfUrl ?? null,
        notes: body.notes ?? null,
      })
      return ok(harvestView(harvest, true))
    },
  },
]
