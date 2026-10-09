import { recordAudit } from '../backoffice/handlers/support'
import { platformRolesWith } from '../backoffice/permissions'
import { chainCtx, userRefOf } from '../chain/runtime'
import type { StoredCollection, StoredRequest } from '../chain/state'
import { isOpenRequest } from '../chain/state'
import { canSee, platform, scoped, trace, type AuthContext } from '../erp/handlers/auth-context'
import { getErpDb, tick } from '../erp/handlers/db'
import { forbidden } from '../erp/handlers/errors'
import { created, enumParam, intParam, listResult, ok, parseBody, strParam, type RouteContext, type RouteSpec } from '../erp/handlers/http'
import { actorOfAuth } from '../erp/handlers/trace-context'
import type { TraceActor, WineryRole } from '../erp/schemas'
import { findLot } from '../erp/trace/state'
import {
  AddTokenizationNoteSchema,
  ApproveTokenizationRequestSchema,
  TOKENIZATION_COLLECTION_STATUSES,
  CollectionOptionalReasonSchema,
  CollectionReasonSchema,
  CreateTokenizationRequestSchema,
  DecideLotClosureSchema,
  LOT_CLOSURE_STATUSES,
  MINT_STATUSES,
  RequestTokenizationChangesSchema,
  ResolveLotClosureItemSchema,
  ResubmitTokenizationRequestSchema,
  ReviewTokenizationRequestSchema,
  SALE_STATES,
  TOKEN_STATUSES,
  TOKENIZATION_REQUEST_KINDS,
  TOKENIZATION_REQUEST_STATUSES,
  TokenizationReasonSchema,
  UpdateCollectionSchema,
  UpdateTokenizationRequestSchema,
} from './schemas'
import {
  addRequestNote,
  approveRequest,
  closeCollection,
  closureNotApplicable,
  closureOf,
  collectionNotFound,
  createRequest,
  decideClosure,
  pauseCollection,
  publishCollection,
  rejectRequest,
  requestChanges,
  requestNotFound,
  resolveClosureItem,
  resubmitRequest,
  resumeCollection,
  reviewRequest,
  takeRequest,
  updateCollection,
  updateRequest,
  withdrawRequest,
} from './service'
import {
  closureSummary,
  closureView,
  collectionMetrics,
  collectionSummary,
  collectionTransactions,
  collectionView,
  lotTokenizationStatus,
  mintView,
  platformRequestView,
  requestSummary,
  requestView,
  tokenView,
  wineryClosureView,
} from './views'

// Handlers del dominio `tokenization` (contrato de la Ola 3 §5, §6 y §8.4): solicitudes y
// colecciones vistas desde el ERP (`/v1/*`, la bodega) y desde el back office (`/v1/platform/*`).
// Solo el dueño autoriza, edita, reenvía y retira; la plataforma lee las rutas del ERP con
// `?wineryId=` y no escribe en ellas (403 `TRC_PLATFORM_READ_ONLY`): la cantidad la autoriza la bodega.

/** Miembros que leen la tokenización de su bodega (el resto solo ve la marca en la lista de lotes). */
const WINERY_READERS: readonly WineryRole[] = ['OWNER', 'ENOLOGIST', 'ACCOUNTANT']
/** Lista de NFT y cierre con faltante: dueño y contabilidad. */
const WINERY_TOKEN_READERS: readonly WineryRole[] = ['OWNER', 'ACCOUNTANT']
const OWNER_ONLY: readonly WineryRole[] = ['OWNER']

const PLATFORM_READERS = platform(platformRolesWith('tokenization', 'FULL', 'READ'))
const PLATFORM_REVIEWERS = platform(platformRolesWith('tokenization', 'FULL'))

const chain = () => getErpDb().chain

function ownerOf(auth: AuthContext): TraceActor {
  const actor = actorOfAuth(auth)
  if (!actor) throw forbidden('Solo el dueño de la bodega puede hacer esto')
  return actor
}

function wineryRequest(auth: AuthContext, id: string): StoredRequest {
  const request = chain().requests.find((r) => r.id === id)
  if (!request || !canSee(auth, request.wineryId)) throw requestNotFound()
  return request
}

function wineryCollection(auth: AuthContext, id: string): StoredCollection {
  const collection = chain().collections.find((c) => c.id === id)
  if (!collection || !canSee(auth, collection.wineryId)) throw collectionNotFound()
  return collection
}

function anyRequest(id: string): StoredRequest {
  const request = chain().requests.find((r) => r.id === id)
  if (!request) throw requestNotFound()
  return request
}

function anyCollection(id: string): StoredCollection {
  const collection = chain().collections.find((c) => c.id === id)
  if (!collection) throw collectionNotFound()
  return collection
}

const lotOfRequest = (request: StoredRequest) => findLot(getErpDb(), request.lotId, null)

function audit(ctx: RouteContext, action: string, wineryId: string, resource: { type: string; id: string }, after: Record<string, unknown> | null = null, reason: string | null = null): void {
  recordAudit(ctx, { action, resource, organizationId: wineryId, after, reason })
}

function tokenList(collection: StoredCollection, query: URLSearchParams) {
  const status = enumParam(query, 'status', TOKEN_STATUSES)
  const from = intParam(query, 'fromNumber')
  const to = intParam(query, 'toNumber')
  const tokens = chain()
    .tokens.filter((t) => t.collectionId === collection.id && (!status || t.status === status) && (from === undefined || t.bottleNumber >= from) && (to === undefined || t.bottleNumber <= to))
    .sort((a, b) => a.bottleNumber - b.bottleNumber)
  // Solo se arma la vista de la página pedida (una colección puede tener miles de NFT).
  const page = listResult(tokens, query)
  const data = page.data as { items: typeof tokens }
  return { ...page, data: { ...data, items: data.items.map((t) => tokenView(chain(), t)) } }
}

/** Texto de búsqueda sin tildes ni mayúsculas. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

export const tokenizationRoutes: RouteSpec[] = [
  // ----- ERP: estado del lote y solicitudes (§5.3) -----
  {
    method: 'get',
    path: '/v1/lots/:id/tokenization',
    access: trace(WINERY_READERS),
    handle: ({ auth, params }) => ok(lotTokenizationStatus(getErpDb(), chainCtx(auth), findLot(getErpDb(), params.id!, auth.tenantId))),
  },
  {
    method: 'post',
    path: '/v1/lots/:id/tokenization-requests',
    access: trace(OWNER_ONLY),
    idempotent: 'required',
    async handle(ctx) {
      const { request, auth, params } = ctx
      const lot = findLot(getErpDb(), params.id!, auth.tenantId)
      const body = await parseBody(request, CreateTokenizationRequestSchema)
      tick()
      const stored = createRequest(getErpDb(), chainCtx(auth), lot, body, ownerOf(auth))
      audit(ctx, 'TOKENIZATION_REQUESTED', lot.wineryId, { type: 'tokenization_request', id: stored.id }, { reference: lot.reference, kind: stored.kind, quantity: stored.quantity, resultingQuota: stored.resultingQuota })
      if (stored.status === 'APPROVED') audit(ctx, 'TOKENIZATION_APPROVED', lot.wineryId, { type: 'tokenization_request', id: stored.id }, { system: true, collectionId: stored.collectionId })
      return created(requestView(getErpDb(), chainCtx(auth), stored))
    },
  },
  {
    method: 'get',
    path: '/v1/tokenization-requests',
    access: trace(WINERY_READERS),
    list: 'paged',
    handle({ auth, query }) {
      const status = enumParam(query, 'status', TOKENIZATION_REQUEST_STATUSES)
      const kind = enumParam(query, 'kind', TOKENIZATION_REQUEST_KINDS)
      const lotId = strParam(query, 'lotId')
      const ctx = chainCtx(auth)
      const items = scoped(auth, chain().requests)
        .filter((r) => (!status || r.status === status) && (!kind || r.kind === kind) && (!lotId || r.lotId === lotId))
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .map((r) => requestSummary(getErpDb(), ctx, r))
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/tokenization-requests/:id',
    access: trace(WINERY_READERS),
    handle: ({ auth, params }) => ok(requestView(getErpDb(), chainCtx(auth), wineryRequest(auth, params.id!))),
  },
  {
    method: 'patch',
    path: '/v1/tokenization-requests/:id',
    access: trace(OWNER_ONLY),
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = wineryRequest(auth, params.id!)
      const body = await parseBody(request, UpdateTokenizationRequestSchema)
      tick()
      updateRequest(getErpDb(), chainCtx(auth), stored, lotOfRequest(stored), body, ownerOf(auth))
      audit(ctx, 'TOKENIZATION_REQUEST_UPDATED', stored.wineryId, { type: 'tokenization_request', id: stored.id }, { quantity: stored.quantity, fields: Object.keys(body.commercial ?? {}) })
      return ok(requestView(getErpDb(), chainCtx(auth), stored))
    },
  },
  {
    method: 'post',
    path: '/v1/tokenization-requests/:id/resubmit',
    access: trace(OWNER_ONLY),
    idempotent: 'required',
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = wineryRequest(auth, params.id!)
      const body = await parseBody(request, ResubmitTokenizationRequestSchema)
      tick()
      resubmitRequest(getErpDb(), chainCtx(auth), stored, lotOfRequest(stored), body.message, ownerOf(auth))
      audit(ctx, 'TOKENIZATION_RESUBMITTED', stored.wineryId, { type: 'tokenization_request', id: stored.id })
      return ok(requestView(getErpDb(), chainCtx(auth), stored))
    },
  },
  {
    method: 'post',
    path: '/v1/tokenization-requests/:id/withdraw',
    access: trace(OWNER_ONLY),
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = wineryRequest(auth, params.id!)
      const body = await parseBody(request, TokenizationReasonSchema)
      tick()
      withdrawRequest(getErpDb(), chainCtx(auth), stored, body.reason, ownerOf(auth))
      audit(ctx, 'TOKENIZATION_WITHDRAWN', stored.wineryId, { type: 'tokenization_request', id: stored.id }, null, body.reason)
      return ok(requestView(getErpDb(), chainCtx(auth), stored))
    },
  },

  // ----- ERP: colecciones de la bodega -----
  {
    method: 'get',
    path: '/v1/collections',
    access: trace(WINERY_READERS),
    list: 'paged',
    handle({ auth, query }) {
      const status = enumParam(query, 'status', TOKENIZATION_COLLECTION_STATUSES)
      const lotId = strParam(query, 'lotId')
      const ctx = chainCtx(auth)
      const items = scoped(auth, chain().collections)
        .filter((c) => (!status || c.status === status) && (!lotId || c.lotId === lotId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((c) => collectionSummary(getErpDb(), ctx, c))
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/collections/:id',
    access: trace(WINERY_READERS),
    handle: ({ auth, params }) => ok(collectionView(getErpDb(), chainCtx(auth), wineryCollection(auth, params.id!))),
  },
  {
    method: 'get',
    path: '/v1/collections/:id/tokens',
    access: trace(WINERY_TOKEN_READERS),
    list: 'paged',
    handle: ({ auth, params, query }) => tokenList(wineryCollection(auth, params.id!), query),
  },
  {
    method: 'get',
    path: '/v1/collections/:id/closure',
    access: trace(WINERY_TOKEN_READERS),
    handle({ auth, params }) {
      const collection = wineryCollection(auth, params.id!)
      const closure = closureOf(getErpDb(), chainCtx(auth), collection)
      if (!closure) throw closureNotApplicable(findLot(getErpDb(), collection.lotId, null))
      return ok(wineryClosureView(chain(), closure))
    },
  },

  // ----- Back office: bandeja (§5.4) -----
  {
    method: 'get',
    path: '/v1/platform/tokenization-requests',
    access: PLATFORM_READERS,
    list: 'paged',
    handle({ auth, query }) {
      const status = enumParam(query, 'status', TOKENIZATION_REQUEST_STATUSES)
      const kind = enumParam(query, 'kind', TOKENIZATION_REQUEST_KINDS)
      const wineryId = strParam(query, 'wineryId')
      const assigneeId = strParam(query, 'assigneeId')
      const q = strParam(query, 'q')
      const ctx = chainCtx(auth)
      // Sin `status`, los estados abiertos, de la más antigua a la más reciente.
      const items = chain()
        .requests.filter((r) => (status ? r.status === status : isOpenRequest(r)) && (!kind || r.kind === kind) && (!wineryId || r.wineryId === wineryId) && (!assigneeId || r.assignee?.userId === assigneeId))
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
        .map((r) => requestSummary(getErpDb(), ctx, r))
        .filter((r) => !q || [r.winery.tradeName, r.lot.name, r.lot.reference, r.lot.lotCode ?? ''].some((text) => fold(text).includes(fold(q))))
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/platform/tokenization-requests/:id',
    access: PLATFORM_READERS,
    handle: ({ auth, params }) => ok(platformRequestView(getErpDb(), chainCtx(auth), anyRequest(params.id!))),
  },
  {
    method: 'post',
    path: '/v1/platform/tokenization-requests/:id/take',
    access: PLATFORM_REVIEWERS,
    handle(ctx) {
      const { auth, params } = ctx
      const stored = anyRequest(params.id!)
      tick()
      takeRequest(getErpDb(), chainCtx(auth), stored, userRefOf(auth))
      audit(ctx, 'TOKENIZATION_TAKEN', stored.wineryId, { type: 'tokenization_request', id: stored.id })
      return ok(platformRequestView(getErpDb(), chainCtx(auth), stored))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/tokenization-requests/:id/notes',
    access: PLATFORM_REVIEWERS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = anyRequest(params.id!)
      const body = await parseBody(request, AddTokenizationNoteSchema)
      tick()
      addRequestNote(getErpDb(), chainCtx(auth), stored, body.text, userRefOf(auth))
      audit(ctx, 'TOKENIZATION_NOTE_ADDED', stored.wineryId, { type: 'tokenization_request', id: stored.id })
      return created(platformRequestView(getErpDb(), chainCtx(auth), stored))
    },
  },
  {
    method: 'patch',
    path: '/v1/platform/tokenization-requests/:id',
    access: PLATFORM_REVIEWERS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = anyRequest(params.id!)
      const body = await parseBody(request, ReviewTokenizationRequestSchema)
      tick()
      reviewRequest(getErpDb(), chainCtx(auth), stored, body, userRefOf(auth))
      audit(ctx, 'TOKENIZATION_REQUEST_UPDATED', stored.wineryId, { type: 'tokenization_request', id: stored.id }, { price: stored.price?.amountMinor ?? null, fields: Object.keys(body.commercial ?? {}) }, body.reason ?? null)
      return ok(platformRequestView(getErpDb(), chainCtx(auth), stored))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/tokenization-requests/:id/request-changes',
    access: PLATFORM_REVIEWERS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = anyRequest(params.id!)
      const body = await parseBody(request, RequestTokenizationChangesSchema)
      tick()
      requestChanges(getErpDb(), chainCtx(auth), stored, body.message, body.fields, userRefOf(auth))
      audit(ctx, 'TOKENIZATION_CHANGES_REQUESTED', stored.wineryId, { type: 'tokenization_request', id: stored.id }, { fields: body.fields ?? [] }, body.message)
      return ok(platformRequestView(getErpDb(), chainCtx(auth), stored))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/tokenization-requests/:id/approve',
    access: PLATFORM_REVIEWERS,
    idempotent: 'required',
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = anyRequest(params.id!)
      const body = await parseBody(request, ApproveTokenizationRequestSchema)
      tick()
      const { collection, mint } = approveRequest(getErpDb(), chainCtx(auth), stored, body, userRefOf(auth))
      audit(ctx, 'TOKENIZATION_APPROVED', stored.wineryId, { type: 'tokenization_request', id: stored.id }, { collectionId: collection.id, quantity: stored.quantity, resultingQuota: collection.quota }, body.reason ?? null)
      audit(ctx, 'NFT_MINT_REQUESTED', stored.wineryId, { type: 'mint', id: mint.id }, { collectionId: collection.id, quantity: mint.quantity, transactions: mint.txIds.length })
      const view = chainCtx(auth)
      return created({ request: platformRequestView(getErpDb(), view, stored), collection: collectionView(getErpDb(), view, collection), mint: mintView(chain(), mint) })
    },
  },
  {
    method: 'post',
    path: '/v1/platform/tokenization-requests/:id/reject',
    access: PLATFORM_REVIEWERS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const stored = anyRequest(params.id!)
      const body = await parseBody(request, TokenizationReasonSchema)
      tick()
      rejectRequest(getErpDb(), chainCtx(auth), stored, body.reason, userRefOf(auth))
      audit(ctx, 'TOKENIZATION_REJECTED', stored.wineryId, { type: 'tokenization_request', id: stored.id }, null, body.reason)
      return ok(platformRequestView(getErpDb(), chainCtx(auth), stored))
    },
  },

  // ----- Back office: colecciones (§6.4) -----
  {
    method: 'get',
    path: '/v1/platform/collections',
    access: PLATFORM_READERS,
    list: 'paged',
    handle({ auth, query }) {
      const status = enumParam(query, 'status', TOKENIZATION_COLLECTION_STATUSES)
      const saleState = enumParam(query, 'saleState', SALE_STATES)
      const mintStatus = enumParam(query, 'mintStatus', MINT_STATUSES)
      const wineryId = strParam(query, 'wineryId')
      const q = strParam(query, 'q')
      const ctx = chainCtx(auth)
      const items = chain()
        .collections.filter((c) => (!status || c.status === status) && (!wineryId || c.wineryId === wineryId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((c) => collectionSummary(getErpDb(), ctx, c))
        .filter((c) => (!saleState || c.saleState === saleState) && (!mintStatus || c.mintStatus === mintStatus))
        .filter((c) => !q || [c.name, c.slug, c.winery.tradeName, c.lot.reference, c.lot.lotCode ?? ''].some((text) => fold(text).includes(fold(q))))
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/platform/collections/:id',
    access: PLATFORM_READERS,
    handle: ({ auth, params }) => ok(collectionView(getErpDb(), chainCtx(auth), anyCollection(params.id!))),
  },
  {
    method: 'patch',
    path: '/v1/platform/collections/:id',
    access: PLATFORM_REVIEWERS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const collection = anyCollection(params.id!)
      const body = await parseBody(request, UpdateCollectionSchema)
      tick()
      updateCollection(getErpDb(), chainCtx(auth), collection, body, userRefOf(auth))
      audit(ctx, body.price !== undefined ? 'COLLECTION_PRICE_SET' : 'COLLECTION_UPDATED', collection.wineryId, { type: 'collection', id: collection.id }, { price: collection.price?.amountMinor ?? null, fields: Object.keys(body.commercial ?? {}) }, body.reason)
      return ok(collectionView(getErpDb(), chainCtx(auth), collection))
    },
  },
  ...(
    [
      ['publish', 'COLLECTION_PUBLISHED', CollectionOptionalReasonSchema, publishCollection],
      ['pause', 'COLLECTION_PAUSED', CollectionReasonSchema, pauseCollection],
      ['resume', 'COLLECTION_RESUMED', CollectionOptionalReasonSchema, resumeCollection],
      ['close', 'COLLECTION_CLOSED', CollectionReasonSchema, closeCollection],
    ] as const
  ).map(
    ([action, auditAction, schema, apply]): RouteSpec => ({
      method: 'post',
      path: `/v1/platform/collections/:id/${action}`,
      access: PLATFORM_REVIEWERS,
      // Cerrar no lleva `Idempotency-Key` obligatoria en el OpenAPI; publicar, pausar y reanudar, sí.
      ...(action === 'close' ? {} : { idempotent: 'required' as const }),
      async handle(ctx) {
        const { request, auth, params } = ctx
        const collection = anyCollection(params.id!)
        const body = await parseBody(request, schema)
        tick()
        apply(getErpDb(), chainCtx(auth), collection, userRefOf(auth), (body.reason ?? null) as string)
        audit(ctx, auditAction, collection.wineryId, { type: 'collection', id: collection.id }, { status: collection.status }, body.reason ?? null)
        return ok(collectionView(getErpDb(), chainCtx(auth), collection))
      },
    }),
  ),
  {
    method: 'get',
    path: '/v1/platform/collections/:id/tokens',
    access: PLATFORM_READERS,
    list: 'paged',
    handle: ({ params, query }) => tokenList(anyCollection(params.id!), query),
  },
  {
    method: 'get',
    path: '/v1/platform/collections/:id/transactions',
    access: PLATFORM_READERS,
    list: 'paged',
    handle: ({ params, query }) => listResult(collectionTransactions(chain(), anyCollection(params.id!)), query),
  },
  {
    method: 'get',
    path: '/v1/platform/collections/:id/metrics',
    access: PLATFORM_READERS,
    handle: ({ params }) => ok(collectionMetrics(getErpDb(), anyCollection(params.id!))),
  },

  // ----- Back office: cierre con faltante (§8.4) -----
  {
    method: 'get',
    path: '/v1/platform/lot-closures',
    access: PLATFORM_READERS,
    list: 'paged',
    handle({ auth, query }) {
      const status = enumParam(query, 'status', LOT_CLOSURE_STATUSES)
      const wineryId = strParam(query, 'wineryId')
      const ctx = chainCtx(auth)
      // El cierre se calcula al consultarlo: aquí, para toda colección de un lote embotellado o descartado.
      for (const c of chain().collections) closureOf(getErpDb(), ctx, c)
      const items = chain()
        .closures.filter((c) => (!status || c.status === status) && (!wineryId || c.wineryId === wineryId))
        .sort((a, b) => b.computedAt.localeCompare(a.computedAt))
        .map(closureSummary)
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/platform/collections/:id/closure',
    access: PLATFORM_READERS,
    handle({ auth, params }) {
      const collection = anyCollection(params.id!)
      const closure = closureOf(getErpDb(), chainCtx(auth), collection)
      if (!closure) throw closureNotApplicable(findLot(getErpDb(), collection.lotId, null))
      return ok(closureView(chain(), closure))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/collections/:id/closure/decide',
    access: PLATFORM_REVIEWERS,
    idempotent: 'required',
    async handle(ctx) {
      const { request, auth, params } = ctx
      const collection = anyCollection(params.id!)
      const body = await parseBody(request, DecideLotClosureSchema)
      tick()
      // Las quemas son de administración (`chain.admin`); operaciones solo decide `KEEP_ON_SALE` sin faltante.
      const canBurn = platformRolesWith('chain.admin', 'FULL').includes(auth.platformRole!)
      const closure = decideClosure(getErpDb(), chainCtx(auth), collection, body.unsoldPolicy, body.reason, userRefOf(auth), canBurn)
      audit(ctx, 'LOT_CLOSURE_DECIDED', collection.wineryId, { type: 'lot_closure', id: closure.id }, { unsoldPolicy: body.unsoldPolicy, burns: closure.items.filter((i) => i.outcome === 'BURN_UNSOLD').length }, body.reason)
      return ok(closureView(chain(), closure))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/collections/:id/closure/items/:tokenId/resolve',
    access: PLATFORM_REVIEWERS,
    async handle(ctx) {
      const { request, auth, params } = ctx
      const collection = anyCollection(params.id!)
      const body = await parseBody(request, ResolveLotClosureItemSchema)
      tick()
      const closure = resolveClosureItem(getErpDb(), chainCtx(auth), collection, Number(params.tokenId), body)
      audit(ctx, 'LOT_CLOSURE_ITEM_RESOLVED', collection.wineryId, { type: 'lot_closure', id: closure.id }, { tokenId: Number(params.tokenId), outcome: body.outcome }, body.note)
      return ok(closureView(chain(), closure))
    },
  },
]
