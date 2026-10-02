import {
  CleanFermentationTankSchema,
  CloseDistillationSchema,
  CompleteFermentationTankSchema,
  CreateDistillationBatchSchema,
  CreateEnologicalTreatmentSchema,
  CreateFermentationLogSchema,
  CreateFermentationTankSchema,
  CreateWineAgingBatchSchema,
  DESTINATION_TYPES,
  DiscardProductionBatchSchema,
  DiscardWineAgingSchema,
  PROCESS_TYPES,
  REST_STATUSES,
  RETIRED_INPUT_FIELDS,
  StartFermentationTankSchema,
  TANK_STATUSES,
  type FermentationTankResponse,
  type ProductionBatchResponse,
  type WineAgingResponse,
} from '../../schemas'
import {
  addLog,
  addTreatment,
  cleanTank,
  closeDistillation,
  completeTank,
  createAging,
  createDistillation,
  createTank,
  discardAging,
  discardDistillation,
  restStatusOf,
  startTank,
} from '../../trace/records'
import { withIssueReevaluation } from '../../trace/dossier'
import { canSee, scoped, trace, TRACE_READERS, type AuthContext } from '../auth-context'
import { getErpDb, tick } from '../db'
import { forbidden, notFound } from '../errors'
import { created, enumParam, listResult, ok, parseBody, parseCreateBody, strParam, type RouteSpec } from '../http'
import { traceCtx } from '../trace-context'
import { agingView, logView, productionView, tankView, treatmentView } from '../views'
import { assertCanCreateLot, requireWinery } from './terroirs-harvest'

// /v1/fermentation-tanks*, /v1/wine-aging*, /v1/production-batches* (contrato de la Ola 2 §4–§5:
// entradas por pesaje, transiciones por acciones, bifurcación coherente con el destino, crianza y
// reposo con la instantánea del lote).

export function findTank(auth: AuthContext, id: string): FermentationTankResponse {
  const t = getErpDb().tanks.find((x) => x.id === id)
  if (!t || !canSee(auth, t.wineryId)) throw notFound(`Cuba con identificador "${id}" no encontrada`)
  return t
}

export function findAging(auth: AuthContext, id: string): WineAgingResponse {
  const a = getErpDb().wineAgings.find((x) => x.id === id)
  if (!a || !canSee(auth, a.wineryId)) throw notFound(`Lote de crianza con identificador "${id}" no encontrado`)
  return a
}

export function findProduction(auth: AuthContext, id: string): ProductionBatchResponse {
  const p = getErpDb().productionBatches.find((x) => x.id === id)
  if (!p || !canSee(auth, p.wineryId)) throw notFound(`Lote de producción con identificador "${id}" no encontrado`)
  return p
}

const WINEMAKERS = ['OWNER', 'ENOLOGIST'] as const
const READERS_WITH_ACCOUNTANT = ['OWNER', 'ENOLOGIST', 'ACCOUNTANT'] as const

export const winemakingRoutes: RouteSpec[] = [
  // ----- Tanques de fermentación -----
  {
    method: 'post',
    path: '/v1/fermentation-tanks',
    access: trace(WINEMAKERS),
    async handle({ request, auth }) {
      const wineryId = requireWinery(auth)
      const body = await parseCreateBody(request, CreateFermentationTankSchema, { retired: RETIRED_INPUT_FIELDS.CreateFermentationTankDto })
      if (body.newLot) assertCanCreateLot(auth)
      tick()
      return created(tankView(createTank(getErpDb(), traceCtx(auth), wineryId, body)))
    },
  },
  {
    method: 'get',
    path: '/v1/fermentation-tanks',
    access: trace(TRACE_READERS),
    list: 'paged',
    handle({ query, auth }) {
      const status = enumParam(query, 'status', TANK_STATUSES)
      const destination = enumParam(query, 'destinationType', DESTINATION_TYPES)
      const harvestBatchId = strParam(query, 'harvestBatchId')
      const lotId = strParam(query, 'lotId')
      const items = scoped(auth, getErpDb().tanks).filter(
        (t) =>
          (!status || t.status === status) &&
          (!destination || t.destinationType === destination) &&
          (!harvestBatchId || (t.inputs ?? [{ harvestBatchId: t.harvestBatchId }]).some((i) => i.harvestBatchId === harvestBatchId)) &&
          (!lotId || t.lotId === lotId),
      )
      return listResult(items.map((t) => tankView(t)), query)
    },
  },
  {
    method: 'get',
    path: '/v1/fermentation-tanks/:id',
    access: trace(TRACE_READERS),
    handle: ({ auth, params }) => ok(tankView(findTank(auth, params.id!), true)),
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/start',
    access: trace(WINEMAKERS),
    idempotent: true,
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseCreateBody(request, StartFermentationTankSchema)
      tick()
      return ok(tankView(startTank(getErpDb(), traceCtx(auth), t, body.startedAt), true))
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/complete',
    access: trace(WINEMAKERS),
    idempotent: true,
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseCreateBody(request, CompleteFermentationTankSchema)
      tick()
      return ok(tankView(completeTank(getErpDb(), traceCtx(auth), t, body), true))
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/clean',
    access: trace(WINEMAKERS),
    idempotent: true,
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseCreateBody(request, CleanFermentationTankSchema)
      tick()
      return ok(tankView(cleanTank(getErpDb(), traceCtx(auth), t, body.cleanedAt), true))
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/logs',
    access: trace(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR']),
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseCreateBody(request, CreateFermentationLogSchema)
      tick()
      // El backend guarda la persona (`recordedByUserId`).
      return created(logView(addLog(getErpDb(), traceCtx(auth), t, body, auth.user.id)))
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/treatments',
    access: trace(WINEMAKERS),
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseCreateBody(request, CreateEnologicalTreatmentSchema)
      // Como el backend: lo autoriza un miembro activo de la bodega.
      if (!auth.memberId) throw forbidden('El usuario no es miembro activo acreditado de esta bodega')
      tick()
      return created(treatmentView(addTreatment(getErpDb(), traceCtx(auth), t, body)))
    },
  },

  // ----- Crianza -----
  {
    method: 'post',
    path: '/v1/wine-aging',
    access: trace(WINEMAKERS),
    async handle({ request, auth }) {
      const wineryId = requireWinery(auth)
      const body = await parseCreateBody(request, CreateWineAgingBatchSchema)
      tick()
      return created(agingView(createAging(getErpDb(), traceCtx(auth), wineryId, body)))
    },
  },
  {
    method: 'get',
    path: '/v1/wine-aging',
    access: trace(READERS_WITH_ACCOUNTANT),
    list: 'paged',
    handle: ({ query, auth }) => listResult(scoped(auth, getErpDb().wineAgings).map((a) => agingView(a)), query),
  },
  {
    method: 'get',
    path: '/v1/wine-aging/:id',
    access: trace(READERS_WITH_ACCOUNTANT),
    handle: ({ auth, params }) => ok(agingView(findAging(auth, params.id!), true)),
  },
  {
    method: 'post',
    path: '/v1/wine-aging/:id/discard',
    access: trace(WINEMAKERS),
    idempotent: true,
    async handle({ request, auth, params }) {
      const a = findAging(auth, params.id!)
      const body = await parseCreateBody(request, DiscardWineAgingSchema)
      tick()
      const db = getErpDb()
      const ctx = traceCtx(auth)
      const lot = db.lots.find((l) => l.id === a.lotId) ?? null
      // Las incidencias abiertas del lote se reevalúan (p. ej. una fuente abierta en un lote ya embotellado).
      return ok(agingView(withIssueReevaluation(db, ctx, lot, () => discardAging(db, ctx, a, body)), true))
    },
  },

  // ----- Destilación y reposo -----
  {
    method: 'post',
    path: '/v1/production-batches/distillation',
    access: trace(WINEMAKERS),
    async handle({ request, auth }) {
      const wineryId = requireWinery(auth)
      const body = await parseCreateBody(request, CreateDistillationBatchSchema, { retired: RETIRED_INPUT_FIELDS.CreateDistillationBatchDto })
      tick()
      return created(productionView(createDistillation(getErpDb(), traceCtx(auth), wineryId, body)))
    },
  },
  {
    method: 'post',
    path: '/v1/production-batches/:id/close',
    access: trace(WINEMAKERS),
    idempotent: true,
    async handle({ request, auth, params }) {
      const p = findProduction(auth, params.id!)
      const body = await parseBody(request, CloseDistillationSchema)
      tick()
      return ok(productionView(closeDistillation(getErpDb(), traceCtx(auth), p, body), true))
    },
  },
  {
    method: 'post',
    path: '/v1/production-batches/:id/discard',
    access: trace(WINEMAKERS),
    idempotent: true,
    async handle({ request, auth, params }) {
      const p = findProduction(auth, params.id!)
      const body = await parseBody(request, DiscardProductionBatchSchema)
      tick()
      const db = getErpDb()
      const ctx = traceCtx(auth)
      const lot = db.lots.find((l) => l.id === p.lotId) ?? null
      return ok(productionView(withIssueReevaluation(db, ctx, lot, () => discardDistillation(db, ctx, p, body.reason)), true))
    },
  },
  {
    method: 'get',
    path: '/v1/production-batches/:id/rest-status',
    access: trace(READERS_WITH_ACCOUNTANT),
    handle: ({ auth, params }) => ok(restStatusOf(getErpDb(), traceCtx(auth), findProduction(auth, params.id!))),
  },
  {
    method: 'get',
    path: '/v1/production-batches/:id',
    access: trace(READERS_WITH_ACCOUNTANT),
    handle: ({ auth, params }) => ok(productionView(findProduction(auth, params.id!), true)),
  },
  {
    method: 'get',
    path: '/v1/production-batches',
    access: trace(READERS_WITH_ACCOUNTANT),
    list: 'paged',
    handle({ query, auth }) {
      const processType = enumParam(query, 'processType', PROCESS_TYPES)
      const restStatus = enumParam(query, 'restStatus', REST_STATUSES)
      const tankId = strParam(query, 'fermentationTankId')
      const items = scoped(auth, getErpDb().productionBatches).filter(
        (p) => (!processType || p.processType === processType) && (!restStatus || p.restStatus === restStatus) && (!tankId || p.fermentationTankId === tankId),
      )
      return listResult(items.map((p) => productionView(p)), query)
    },
  },
]
