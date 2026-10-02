import { CreateBatchLabAnalysisSchema, CreateBottlingBatchSchema, PRODUCT_TYPES, type BottlingBatchResponse, type Lot } from '../../schemas'
import { bottleLot, registerLab } from '../../trace/bottling'
import { currentLab, findLot } from '../../trace/state'
import { canSee, scoped, trace, type AuthContext } from '../auth-context'
import { getErpDb, tick } from '../db'
import { notFound } from '../errors'
import { boolParam, created, enumParam, listResult, ok, parseCreateBody, strParam, type RouteSpec } from '../http'
import { traceCtx } from '../trace-context'
import { bottlingView, labView } from '../views'
import { requireWinery } from './terroirs-harvest'
import { findAging, findProduction } from './winemaking'

// /v1/bottling* y /v1/lab-analyses*: rutas legadas (alias hasta H2 de `POST /v1/lots/{id}/bottling`
// y `POST /v1/lots/{id}/lab-analyses`). Aplican las mismas reglas desde la apertura de la Ola 2:
// tipo derivado del origen, candados con la instantánea, un embotellado por lote, balance de
// volumen y de alcohol, y conformidad de laboratorio calculada.

export function findBottling(auth: AuthContext | null, id: string): BottlingBatchResponse {
  const b = getErpDb().bottlings.find((x) => x.id === id)
  if (!b || (auth && !canSee(auth, b.wineryId))) throw notFound(`Lote de embotellado con identificador "${id}" no encontrado`)
  return b
}

/** Lote de una fuente del embotellado (todas tienen uno desde la migración de la Ola 2). */
function lotOfSource(auth: AuthContext, lotId: string | null): Lot {
  if (!lotId) throw notFound('La fuente no pertenece a ningún lote')
  return findLot(getErpDb(), lotId, auth.tenantId)
}

export const bottlingLabRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/bottling',
    access: trace(['OWNER', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseCreateBody(request, CreateBottlingBatchSchema)
      // El lote se deduce del origen; el tipo enviado se compara con el derivado (EA-01).
      const source = body.wineAgingBatchId
        ? { kind: 'AGING' as const, id: body.wineAgingBatchId, lotId: findAging(auth, body.wineAgingBatchId).lotId }
        : { kind: 'REST' as const, id: body.productionBatchId as string, lotId: findProduction(auth, body.productionBatchId as string).lotId }
      const lot = lotOfSource(auth, source.lotId)
      tick()
      const bottling = bottleLot(getErpDb(), traceCtx(auth), lot, {
        sources: [{ kind: source.kind, id: source.id }],
        declaredProductType: body.productType,
        bottlingDate: body.bottlingDate,
        packagingFormatCl: body.packagingFormatCl,
        totalBottlesPackaged: body.totalBottlesPackaged,
        finalAlcoholAbv: body.finalAlcoholAbv,
        waterDilutionLiters: body.waterDilutionLiters,
        bottleType: body.bottleType,
        labelDesignUrl: body.labelDesignUrl,
      })
      return created(bottlingView(bottling))
    },
  },
  {
    method: 'get',
    path: '/v1/bottling',
    access: trace(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
    list: 'paged',
    handle({ query, auth }) {
      const productType = enumParam(query, 'productType', PRODUCT_TYPES)
      const anchored = boolParam(query, 'isAnchoredOnChain')
      const lotId = strParam(query, 'lotId')
      const items = scoped(auth, getErpDb().bottlings).filter(
        (b) => (!productType || b.productType === productType) && (anchored === undefined || b.isAnchoredOnChain === anchored) && (!lotId || b.lotId === lotId),
      )
      return listResult(items.map((b) => bottlingView(b)), query)
    },
  },
  {
    method: 'get',
    path: '/v1/bottling/:id',
    access: trace(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
    handle: ({ auth, params }) => ok(bottlingView(findBottling(auth, params.id!), true)),
  },

  // ----- Laboratorio -----
  {
    method: 'post',
    path: '/v1/lab-analyses',
    access: trace(['OWNER', 'ENOLOGIST']),
    async handle({ request, auth }) {
      const body = await parseCreateBody(request, CreateBatchLabAnalysisSchema)
      const bottling = findBottling(auth, body.bottlingBatchId)
      const lot = lotOfSource(auth, bottling.lotId)
      tick()
      // Un análisis nuevo sustituye al anterior (reanálisis): ya no hay 409.
      return created(labView(registerLab(getErpDb(), traceCtx(auth), lot, body)))
    },
  },
  {
    method: 'get',
    path: '/v1/lab-analyses/batch/:bottlingBatchId',
    access: trace(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'ACCOUNTANT']),
    handle({ auth, params }) {
      const bottling = findBottling(auth, params.bottlingBatchId!)
      const db = getErpDb()
      const lab = bottling.lotId ? currentLab(db, bottling.lotId) : db.labAnalyses.filter((l) => l.bottlingBatchId === bottling.id).at(-1)
      if (!lab) throw notFound(`Informe analítico del lote "${bottling.internationalLotCode}" no encontrado`)
      return ok(labView(lab))
    },
  },
]
