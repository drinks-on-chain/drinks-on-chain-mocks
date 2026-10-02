import { PRODUCT_TYPES, type BottlingBatchResponse } from '../../schemas'
import { currentLab } from '../../trace/state'
import { canSee, scoped, trace, type AuthContext } from '../auth-context'
import { getErpDb } from '../db'
import { notFound } from '../errors'
import { boolParam, enumParam, listResult, ok, strParam, type RouteSpec } from '../http'
import { bottlingView, labView } from '../views'

// /v1/bottling* y /v1/lab-analyses*: lecturas del embotellado y de su análisis vigente. Las altas
// son del lote desde el cierre H2 de la Ola 2 (`POST /v1/lots/{id}/bottling` y
// `POST /v1/lots/{id}/lab-analyses`); `POST /v1/bottling` y `POST /v1/lab-analyses` ya no existen.

export function findBottling(auth: AuthContext | null, id: string): BottlingBatchResponse {
  const b = getErpDb().bottlings.find((x) => x.id === id)
  if (!b || (auth && !canSee(auth, b.wineryId))) throw notFound(`Lote de embotellado con identificador "${id}" no encontrado`)
  return b
}

export const bottlingLabRoutes: RouteSpec[] = [
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
