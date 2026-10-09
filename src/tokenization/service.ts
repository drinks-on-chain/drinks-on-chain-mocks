import { enqueueTx, publishBlocker, setCollectionStatus, type ChainCtx } from '../chain/engine'
import { collectionOfLot, identityOf, isOpenRequest, mintsOf, openRequestOfLot, pushNotice, tokensOf, type StoredClosure, type StoredCollection, type StoredMint, type StoredRequest } from '../chain/state'
import type { UserRef } from '../chain/schemas'
import { ApiError } from '../erp/handlers/errors'
import type { ErrorDetail, Lot, TraceActor } from '../erp/schemas'
import { appendLotEvent, bottleCodesSummary, bottleLotOf, fileSha256, lotBottling, ruleError, stateError, toLotView, type TraceState } from '../erp/trace/state'
import { uid } from '../shared/uuid'
import type {
  ApproveTokenizationRequest,
  CollectionCommercialDraft,
  CollectionCommercialInput,
  CollectionImage,
  CollectionPrice,
  CollectionPriceInput,
  CreateTokenizationRequest,
  ResolveLotClosureItem,
  ReviewTokenizationRequest,
  TokenizationLimits,
  UnsoldPolicy,
  UpdateCollection,
  UpdateTokenizationRequest,
} from './schemas'

// Reglas de la tokenización (contrato de la Ola 3 §5, §6 y §8.4) como funciones puras sobre el
// estado: las usan los handlers y el generador de fixtures. Acción no permitida en el estado
// actual → 409; regla de negocio incumplida → 422 con `details` (`code`, `expected`, `actual`, `meta`).

/** Máximo de NFT por transacción `mint_batch` (DS-13): una emisión mayor se parte en trozos. */
export const MINT_CHUNK_SIZE = 32_000

/** Etapas en las que un lote se puede tokenizar (anteriores a `CERTIFIED`). */
export const TOKENIZABLE_STAGES = ['ORIGIN', 'HARVEST', 'FERMENTING', 'AGING', 'DISTILLING', 'RESTING', 'BOTTLED'] as const

const SYSTEM = 'Sistema'

const detail = (code: string, message: string, extra: Partial<ErrorDetail> = {}): ErrorDetail => ({ field: null, message, code, ...extra })

export const requestNotFound = () => new ApiError(404, 'TOK_REQUEST_NOT_FOUND', 'Solicitud de tokenización no encontrada')
export const collectionNotFound = () => new ApiError(404, 'TOK_COLLECTION_NOT_FOUND', 'Colección no encontrada')

const invalidRequestTransition = (from: string, to: string) =>
  stateError('TOK_REQUEST_INVALID_TRANSITION', `La solicitud está en ${from}: no admite esta acción`, [detail('TOK_REQUEST_INVALID_TRANSITION', `Transición no válida: ${from} → ${to}`, { meta: { from, to } })])

const invalidCollectionTransition = (from: string, to: string) =>
  stateError('TOK_COLLECTION_INVALID_TRANSITION', `La colección está en ${from}: no admite esta acción`, [
    detail('TOK_COLLECTION_INVALID_TRANSITION', `Transición no válida: ${from} → ${to}`, { meta: { from, to } }),
  ])

// ---------------------------------------------------------------------------
// Cuota (§5.2)
// ---------------------------------------------------------------------------

const activeBottles = (state: TraceState, lot: Lot): number | null => (lotBottling(state, lot.id) ? bottleCodesSummary(bottleLotOf(state, lot.id)).active : null)

/** Límites de la cuota de un lote ahora. `excludeRequestId`: no cuenta esa solicitud como pendiente (al editarla o aprobarla). */
export function tokenizationLimits(state: TraceState, lot: Lot, excludeRequestId: string | null = null): TokenizationLimits {
  const bottles = activeBottles(state, lot)
  const basis = bottles === null ? 'ESTIMATE' : 'BOTTLES'
  const authorizedQuota = collectionOfLot(state.chain, lot.id)?.quota ?? 0
  const open = openRequestOfLot(state.chain, lot.id)
  const pendingQuantity = open && open.id !== excludeRequestId ? open.quantity : 0
  const limit = basis === 'BOTTLES' ? (bottles ?? 0) : (lot.estimatedBottles ?? 0)
  return { basis, estimatedBottles: lot.estimatedBottles, bottles, authorizedQuota, pendingQuantity, maxQuantity: Math.max(0, limit - authorizedQuota - pendingQuantity) }
}

/** Lo que impide enviar una solicitud ahora (vacío = tokenizable). `quantity`: además valida esa cantidad. */
export function tokenizationBlockers(state: TraceState, lot: Lot, options: { quantity?: number; excludeRequestId?: string | null; ignoreOpen?: boolean } = {}): ErrorDetail[] {
  const out: ErrorDetail[] = []
  if (!lot.productType) out.push(detail('TOK_LOT_PRODUCT_UNDEFINED', 'El lote aún no tiene decidido su tipo de producto (vino o singani)'))
  if (lot.estimatedBottles === null) out.push(detail('TOK_LOT_ESTIMATE_MISSING', 'Declara la estimación de botellas del lote antes de tokenizarlo', { field: 'estimatedBottles' }))
  if (!(TOKENIZABLE_STAGES as readonly string[]).includes(lot.stage)) {
    out.push(detail('TOK_LOT_NOT_TOKENIZABLE', 'El lote ya no se puede tokenizar: está certificado, anclado, rechazado o descartado', { meta: { stage: lot.stage } }))
  }
  const open = openRequestOfLot(state.chain, lot.id)
  if (open && !options.ignoreOpen && open.id !== options.excludeRequestId) {
    out.push(detail('TOK_REQUEST_ALREADY_OPEN', 'El lote ya tiene una solicitud de tokenización abierta', { meta: { requestId: open.id } }))
  }
  if (options.quantity !== undefined && out.length === 0) {
    const limits = tokenizationLimits(state, lot, options.excludeRequestId ?? null)
    if (!Number.isInteger(options.quantity) || options.quantity < 1) {
      out.push(detail('TOK_QUOTA_INVALID', 'La cantidad debe ser un número entero mayor o igual que 1', { field: 'quantity', actual: options.quantity }))
    } else if (options.quantity > limits.maxQuantity) {
      const byBottles = limits.basis === 'BOTTLES'
      const limit = byBottles ? (limits.bottles ?? 0) : (limits.estimatedBottles ?? 0)
      out.push(
        detail(
          byBottles ? 'TOK_QUOTA_EXCEEDS_BOTTLES' : 'TOK_QUOTA_EXCEEDS_ESTIMATE',
          byBottles
            ? `Puedes autorizar hasta ${limits.maxQuantity} botellas: el lote tiene ${limit} botellas embotelladas y ya hay ${limits.authorizedQuota + limits.pendingQuantity} autorizadas`
            : `Puedes autorizar hasta ${limits.maxQuantity} botellas: la estimación del lote es ${limit} y ya hay ${limits.authorizedQuota + limits.pendingQuantity} autorizadas`,
          { field: 'quantity', expected: limit, actual: limits.authorizedQuota + limits.pendingQuantity + options.quantity, meta: { maxQuantity: limits.maxQuantity, basis: limits.basis } },
        ),
      )
    }
  }
  return out
}

const CONFLICT_CODES = ['TOK_LOT_NOT_TOKENIZABLE', 'TOK_REQUEST_ALREADY_OPEN']

/** Lanza la primera infracción con su estado HTTP (409 las de estado, 422 las de regla). */
function throwBlockers(blockers: ErrorDetail[]): void {
  const first = blockers[0]
  if (!first) return
  throw new ApiError(CONFLICT_CODES.includes(first.code ?? '') ? 409 : 422, first.code ?? 'UNPROCESSABLE_ENTITY', first.message, blockers)
}

// ---------------------------------------------------------------------------
// Datos comerciales (§5.5)
// ---------------------------------------------------------------------------

export function emptyCommercialDraft(estimatedRedeemDate: string | null = null): CollectionCommercialDraft {
  return { name: null, description: null, tastingNotes: null, pairing: null, imageKeys: [], estimatedRedeemDate }
}

/** Aplica lo enviado sobre el borrador (lo ausente no cambia; `null` borra los opcionales). */
export function mergeCommercial(draft: CollectionCommercialDraft, input: CollectionCommercialInput | undefined): CollectionCommercialDraft {
  if (!input) return draft
  return {
    name: input.name ?? draft.name,
    description: input.description ?? draft.description,
    tastingNotes: input.tastingNotes === undefined ? draft.tastingNotes : input.tastingNotes,
    pairing: input.pairing === undefined ? draft.pairing : input.pairing,
    imageKeys: input.imageKeys === undefined ? draft.imageKeys : input.imageKeys.map((i) => ({ key: i.key, alt: i.alt, isCover: i.isCover ?? false })),
    estimatedRedeemDate: input.estimatedRedeemDate === undefined ? draft.estimatedRedeemDate : input.estimatedRedeemDate,
  }
}

/** Campos obligatorios que faltan para aprobar o publicar (S-10): nombre, descripción y una imagen de portada. */
export function missingCommercial(c: { name: string | null; description: string | null; images: number }): ErrorDetail[] {
  const out: ErrorDetail[] = []
  if (!c.name?.trim()) out.push(detail('TOK_COMMERCIAL_DATA_INCOMPLETE', 'Falta el nombre de la colección', { field: 'commercial.name' }))
  if (!c.description?.trim()) out.push(detail('TOK_COMMERCIAL_DATA_INCOMPLETE', 'Falta la descripción de la colección', { field: 'commercial.description' }))
  if (c.images === 0) out.push(detail('TOK_COMMERCIAL_DATA_INCOMPLETE', 'Falta la imagen de portada', { field: 'commercial.imageKeys' }))
  return out
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'coleccion'
  )
}

/**
 * Imágenes de la colección a partir de las claves subidas; sin portada marcada, la primera lo es.
 * `url` es una ruta relativa de la API (`/v1/public/collections/images/{id}`), como las demás URL
 * públicas de los mocks: la app la resuelve contra su proxy.
 */
export function collectionImages(state: TraceState, _ctx: ChainCtx, collectionId: string, keys: CollectionCommercialDraft['imageKeys']): CollectionImage[] {
  const hasCover = keys.some((k) => k.isCover)
  let coverSet = false
  return keys.map((k, index) => {
    const isCover = !coverSet && (hasCover ? Boolean(k.isCover) : index === 0)
    if (isCover) coverSet = true
    const id = uid(`collection-image:${collectionId}:${k.key}`)
    return { id, key: k.key, sha256: fileSha256(k.key, state), url: `/v1/public/collections/images/${id}`, alt: k.alt, isCover }
  })
}

function priceOf(ctx: ChainCtx, input: CollectionPriceInput, by: UserRef | null): CollectionPrice {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 1 || input.currency !== 'BOB') {
    throw ruleError('TOK_PRICE_INVALID', 'El precio debe ser un importe entero de centavos mayor o igual que 1, en BOB', [detail('TOK_PRICE_INVALID', 'Precio no válido', { field: 'price.amountMinor' })])
  }
  return { amountMinor: input.amountMinor, currency: 'BOB', source: 'MANUAL', setAt: ctx.now, setBy: by ?? { userId: uid('user:system'), fullName: SYSTEM } }
}

// ---------------------------------------------------------------------------
// Solicitudes: bodega (§5.3)
// ---------------------------------------------------------------------------

function pushHistory(request: StoredRequest, ctx: ChainCtx, by: string, note: string | null = null): void {
  request.updatedAt = ctx.now
  request.history.push({ status: request.status, at: ctx.now, by, note })
}

/** `POST /v1/lots/{id}/tokenization-requests`: la bodega autoriza una cuota (o una ampliación). */
export function createRequest(state: TraceState, ctx: ChainCtx, lot: Lot, body: CreateTokenizationRequest, actor: TraceActor): StoredRequest {
  throwBlockers(tokenizationBlockers(state, lot, { quantity: body.quantity }))
  const collection = collectionOfLot(state.chain, lot.id)
  const limits = tokenizationLimits(state, lot)
  const requiresApproval = ctx.env.setting('tokenizacion.requiereAprobacion', lot.wineryId) !== false
  const request: StoredRequest = {
    id: ctx.newId('tokenization-request'),
    wineryId: lot.wineryId,
    lotId: lot.id,
    kind: collection ? 'QUOTA_INCREASE' : 'INITIAL',
    status: 'SUBMITTED',
    quantity: body.quantity,
    resultingQuota: limits.authorizedQuota + body.quantity,
    requiresApproval,
    assignee: null,
    submittedAt: ctx.now,
    submittedBy: actor,
    updatedAt: ctx.now,
    collectionId: collection?.id ?? null,
    commercialDraft: mergeCommercial(emptyCommercialDraft(toLotView(state, lot, ctx).estimatedReadyDate), body.commercial),
    price: null,
    wineryNotes: body.notes?.trim() || null,
    changeRequests: [],
    decision: null,
    withdrawn: null,
    limitsAtSubmission: limits,
    history: [],
    internalNotes: [],
  }
  pushHistory(request, ctx, actor.fullName)
  state.chain.requests.push(request)
  appendLotEvent(state, ctx, lot, {
    type: 'TOKENIZATION_AUTHORIZED',
    occurredAt: ctx.now,
    actor,
    summary: collection ? `Ampliación de la cuota autorizada: ${body.quantity} botellas más` : `Tokenización autorizada: ${body.quantity} botellas`,
    data: { requestId: request.id, kind: request.kind, quantity: body.quantity, resultingQuota: request.resultingQuota },
    resource: { type: 'tokenization_request', id: request.id },
  })
  pushNotice(state.chain, { type: 'REQUEST_SUBMITTED', wineryId: lot.wineryId, requestId: request.id })
  // S-11 (no acordado): sin aprobación obligatoria, la solicitud completa se aprueba sola al enviarse.
  if (!requiresApproval) {
    const complete = collection !== null || missingCommercial({ ...request.commercialDraft, images: request.commercialDraft.imageKeys.length }).length === 0
    const ready = identityOf(state.chain, lot.wineryId)?.status === 'ACTIVE'
    if (complete && ready) approveRequest(state, ctx, request, {}, null)
  }
  return request
}

/** `PATCH /v1/tokenization-requests/{id}`: solo en `CHANGES_REQUESTED` o `SUBMITTED` (antes de tomarse). */
export function updateRequest(state: TraceState, ctx: ChainCtx, request: StoredRequest, lot: Lot, body: UpdateTokenizationRequest, actor: TraceActor): StoredRequest {
  if (request.status !== 'CHANGES_REQUESTED' && request.status !== 'SUBMITTED') throw invalidRequestTransition(request.status, request.status)
  if (body.quantity !== undefined && body.quantity !== request.quantity) {
    throwBlockers(tokenizationBlockers(state, lot, { quantity: body.quantity, excludeRequestId: request.id }))
    request.quantity = body.quantity
    request.resultingQuota = (collectionOfLot(state.chain, lot.id)?.quota ?? 0) + body.quantity
  }
  request.commercialDraft = mergeCommercial(request.commercialDraft, body.commercial)
  if (body.notes !== undefined) request.wineryNotes = body.notes.trim() || null
  request.updatedAt = ctx.now
  void actor
  return request
}

/** `POST …/resubmit`: `CHANGES_REQUESTED → SUBMITTED`; las peticiones de cambio quedan resueltas. */
export function resubmitRequest(state: TraceState, ctx: ChainCtx, request: StoredRequest, lot: Lot, message: string | undefined, actor: TraceActor): StoredRequest {
  if (request.status !== 'CHANGES_REQUESTED') throw invalidRequestTransition(request.status, 'SUBMITTED')
  throwBlockers(tokenizationBlockers(state, lot, { quantity: request.quantity, excludeRequestId: request.id }))
  for (const change of request.changeRequests) change.resolvedAt ??= ctx.now
  request.status = 'SUBMITTED'
  request.assignee = null
  pushHistory(request, ctx, actor.fullName, message?.trim() || null)
  pushNotice(state.chain, { type: 'REQUEST_RESUBMITTED', wineryId: request.wineryId, requestId: request.id, message: message?.trim() || null })
  return request
}

/** `POST …/withdraw`: desde cualquier estado abierto. */
export function withdrawRequest(_state: TraceState, ctx: ChainCtx, request: StoredRequest, reason: string, actor: TraceActor): StoredRequest {
  if (!isOpenRequest(request)) throw invalidRequestTransition(request.status, 'WITHDRAWN')
  request.status = 'WITHDRAWN'
  request.withdrawn = { at: ctx.now, by: actor, reason }
  pushHistory(request, ctx, actor.fullName, reason)
  return request
}

// ---------------------------------------------------------------------------
// Solicitudes: bandeja del back office (§5.4)
// ---------------------------------------------------------------------------

export function takeRequest(_state: TraceState, ctx: ChainCtx, request: StoredRequest, by: UserRef): StoredRequest {
  if (request.status !== 'SUBMITTED') throw invalidRequestTransition(request.status, 'IN_REVIEW')
  request.status = 'IN_REVIEW'
  request.assignee = by
  pushHistory(request, ctx, by.fullName)
  return request
}

export function addRequestNote(_state: TraceState, ctx: ChainCtx, request: StoredRequest, text: string, by: UserRef): StoredRequest {
  request.internalNotes.push({ id: ctx.newId('tokenization-note'), text, by: by.fullName, at: ctx.now })
  request.updatedAt = ctx.now
  return request
}

/** `PATCH /v1/platform/tokenization-requests/{id}`: operaciones completa los datos comerciales y el precio (en `IN_REVIEW`). */
export function reviewRequest(_state: TraceState, ctx: ChainCtx, request: StoredRequest, body: ReviewTokenizationRequest, by: UserRef): StoredRequest {
  if (request.status !== 'IN_REVIEW') throw invalidRequestTransition(request.status, request.status)
  request.commercialDraft = mergeCommercial(request.commercialDraft, body.commercial)
  if (body.price !== undefined) request.price = body.price === null ? null : priceOf(ctx, body.price, by)
  request.updatedAt = ctx.now
  return request
}

export function requestChanges(state: TraceState, ctx: ChainCtx, request: StoredRequest, message: string, fields: string[] | undefined, by: UserRef): StoredRequest {
  if (request.status !== 'IN_REVIEW') throw invalidRequestTransition(request.status, 'CHANGES_REQUESTED')
  request.status = 'CHANGES_REQUESTED'
  request.changeRequests.push({ id: ctx.newId('tokenization-change'), at: ctx.now, by, message, fields: fields ?? [], resolvedAt: null })
  pushHistory(request, ctx, by.fullName, message)
  pushNotice(state.chain, { type: 'CHANGES_REQUESTED', wineryId: request.wineryId, requestId: request.id, message })
  return request
}

export function rejectRequest(state: TraceState, ctx: ChainCtx, request: StoredRequest, reason: string, by: UserRef | null): StoredRequest {
  if (request.status !== 'IN_REVIEW' && !(by === null && isOpenRequest(request))) throw invalidRequestTransition(request.status, 'REJECTED')
  request.status = 'REJECTED'
  request.decision = { outcome: 'REJECTED', at: ctx.now, reason, by: { userId: by?.userId ?? null, fullName: by?.fullName ?? null, system: by === null } }
  pushHistory(request, ctx, by?.fullName ?? SYSTEM, reason)
  pushNotice(state.chain, { type: 'REQUEST_REJECTED', wineryId: request.wineryId, requestId: request.id, message: reason })
  return request
}

export interface ApproveOptions {
  /** Solo el generador de fixtures: no revalida la etapa ni la cuota (hechos anteriores al estado actual del lote). */
  skipLotRules?: boolean
}

/**
 * `POST …/approve`: `IN_REVIEW → APPROVED`. Revalida la cuota con los datos de ahora, crea la
 * colección (o amplía la cuota) y la emisión, con una intención `MINT_BATCH` por trozo. `by: null`
 * = aprobación automática del sistema (S-11).
 */
export function approveRequest(
  state: TraceState,
  ctx: ChainCtx,
  request: StoredRequest,
  body: ApproveTokenizationRequest,
  by: UserRef | null,
  options: ApproveOptions = {},
): { request: StoredRequest; collection: StoredCollection; mint: StoredMint } {
  const chain = state.chain
  const expected = by === null ? 'SUBMITTED' : 'IN_REVIEW'
  if (request.status !== expected) throw invalidRequestTransition(request.status, 'APPROVED')
  const lot = state.lots.find((l) => l.id === request.lotId)
  if (!lot) throw requestNotFound()
  if (!options.skipLotRules) throwBlockers(tokenizationBlockers(state, lot, { quantity: request.quantity, excludeRequestId: request.id }))
  const winery = ctx.env.winery(request.wineryId)
  if (winery.status !== 'ACTIVE') {
    throw stateError('TOK_WINERY_NOT_ACTIVE', 'La bodega no está activa: no se pueden aprobar sus solicitudes', [detail('TOK_WINERY_NOT_ACTIVE', 'Bodega suspendida o revocada', { meta: { status: winery.status } })])
  }
  const identity = identityOf(chain, request.wineryId)
  if (identity?.status !== 'ACTIVE' || !identity.contract) {
    const status = identity?.status ?? 'NOT_PROVISIONED'
    throw stateError('TOK_WINERY_CHAIN_NOT_READY', 'La bodega aún no tiene su cuenta y su contrato listos en la red', [
      detail('TOK_WINERY_CHAIN_NOT_READY', `Identidad en la red: ${status}`, { meta: { status } }),
    ])
  }
  const draft = mergeCommercial(request.commercialDraft, body.commercial)
  const price = body.price === undefined ? request.price : body.price === null ? null : priceOf(ctx, body.price, by)
  let collection = collectionOfLot(chain, lot.id)
  if (!collection) {
    const missing = missingCommercial({ ...draft, images: draft.imageKeys.length })
    if (missing.length > 0) throw ruleError('TOK_COMMERCIAL_DATA_INCOMPLETE', 'Faltan datos comerciales obligatorios para aprobar', missing)
    // El `slug` es único **por bodega** (no global): dos bodegas pueden tener una colección con el mismo nombre.
    const slug = slugify(draft.name!)
    if (chain.collections.some((c) => c.wineryId === lot.wineryId && c.slug === slug)) {
      throw stateError('TOK_SLUG_TAKEN', `Ya existe una colección con el nombre «${draft.name}»`, [detail('TOK_SLUG_TAKEN', 'Elige otro nombre', { field: 'commercial.name', meta: { slug } })])
    }
    const id = ctx.newId('collection')
    collection = {
      id,
      slug,
      wineryId: lot.wineryId,
      lotId: lot.id,
      status: 'MINTING',
      quota: request.quantity,
      price,
      commercial: {
        name: draft.name!.trim(),
        description: draft.description!.trim(),
        tastingNotes: draft.tastingNotes,
        pairing: draft.pairing,
        estimatedRedeemDate: draft.estimatedRedeemDate,
        images: collectionImages(state, ctx, id, draft.imageKeys),
      },
      // `precio.politica` (appliesAt: COLLECTION) se copia al aprobar.
      pricePolicySnapshot: ctx.env.setting('precio.politica', lot.wineryId) ?? null,
      priceHistory: price ? [price] : [],
      quotaHistory: [],
      statusHistory: [{ status: 'MINTING', at: ctx.now, by: by?.fullName ?? SYSTEM, reason: null }],
      redeemableSince: null,
      publishedAt: null,
      closedAt: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      publishOnMint: body.publishOnMint === true,
    }
    chain.collections.push(collection)
  } else {
    collection.quota += request.quantity
    collection.updatedAt = ctx.now
  }
  collection.quotaHistory.push({ requestId: request.id, kind: request.kind, quantity: request.quantity, resultingQuota: collection.quota, approvedAt: ctx.now, approvedBy: by?.fullName ?? SYSTEM })
  const mint: StoredMint = {
    id: ctx.newId('mint'),
    collectionId: collection.id,
    requestId: request.id,
    sequence: mintsOf(chain, collection.id).length + 1,
    quantity: request.quantity,
    status: 'PENDING',
    // S-12: el argumento `lot` de `mint_batch` es la referencia estable del lote.
    lotArg: lot.reference,
    ranges: [],
    txIds: [],
    createdAt: ctx.now,
    confirmedAt: null,
  }
  chain.mints.push(mint)
  for (let chunk = 0, left = request.quantity; left > 0; chunk++, left -= MINT_CHUNK_SIZE) {
    const amount = Math.min(left, MINT_CHUNK_SIZE)
    mint.txIds.push(
      enqueueTx(state, ctx, {
        kind: 'MINT_BATCH',
        intentKey: `mint:${mint.id}:${chunk}`,
        subject: { type: 'MINT', id: mint.id },
        wineryId: lot.wineryId,
        intent: { mintId: mint.id, chunk, amount, lot: lot.reference, contract: identity.contract.address, to: identity.accountAddress },
        requestedBy: { userId: by?.userId ?? null, fullName: by?.fullName ?? null, source: by ? 'API' : 'WORKER' },
      }).id,
    )
  }
  request.commercialDraft = draft
  request.price = price
  request.status = 'APPROVED'
  request.collectionId = collection.id
  request.resultingQuota = collection.quota
  request.publishOnMint = body.publishOnMint === true
  request.decision = { outcome: 'APPROVED', at: ctx.now, reason: body.reason ?? null, by: { userId: by?.userId ?? null, fullName: by?.fullName ?? null, system: by === null } }
  pushHistory(request, ctx, by?.fullName ?? SYSTEM, body.reason ?? null)
  pushNotice(chain, { type: 'REQUEST_APPROVED', wineryId: request.wineryId, requestId: request.id, collectionId: collection.id, data: { quantity: request.quantity } })
  return { request, collection, mint }
}

// ---------------------------------------------------------------------------
// Colecciones (§6.4)
// ---------------------------------------------------------------------------

const commercialMissingOf = (c: StoredCollection) => missingCommercial({ name: c.commercial.name, description: c.commercial.description, images: c.commercial.images.length })

function assertPublishable(state: TraceState, ctx: ChainCtx, collection: StoredCollection): void {
  const blocker = publishBlocker(state, ctx, collection)
  if (blocker) throw stateError(blocker.code, blocker.message, [detail(blocker.code, blocker.message, { meta: blocker.meta })])
  const missing = commercialMissingOf(collection)
  if (missing.length > 0) throw ruleError('TOK_COMMERCIAL_DATA_INCOMPLETE', 'Faltan datos comerciales obligatorios para publicar', missing)
}

function lotOfCollection(state: TraceState, collection: StoredCollection): Lot {
  const lot = state.lots.find((l) => l.id === collection.lotId)
  if (!lot) throw collectionNotFound()
  return lot
}

export function updateCollection(state: TraceState, ctx: ChainCtx, collection: StoredCollection, body: UpdateCollection, by: UserRef): StoredCollection {
  if (collection.status === 'CLOSED') throw invalidCollectionTransition('CLOSED', 'CLOSED')
  if (body.commercial) {
    const c = body.commercial
    if (c.name !== undefined && c.name.trim() !== collection.commercial.name && !collection.publishedAt) {
      // El `slug` sigue al nombre solo hasta la primera publicación.
      const slug = slugify(c.name)
      if (state.chain.collections.some((other) => other.id !== collection.id && other.wineryId === collection.wineryId && other.slug === slug)) {
        throw stateError('TOK_SLUG_TAKEN', `Ya existe una colección con el nombre «${c.name}»`, [detail('TOK_SLUG_TAKEN', 'Elige otro nombre', { field: 'commercial.name', meta: { slug } })])
      }
      collection.slug = slug
    }
    if (c.name !== undefined) collection.commercial.name = c.name.trim()
    if (c.description !== undefined) collection.commercial.description = c.description.trim()
    if (c.tastingNotes !== undefined) collection.commercial.tastingNotes = c.tastingNotes
    if (c.pairing !== undefined) collection.commercial.pairing = c.pairing
    if (c.estimatedRedeemDate !== undefined) collection.commercial.estimatedRedeemDate = c.estimatedRedeemDate
    if (c.imageKeys !== undefined) collection.commercial.images = collectionImages(state, ctx, collection.id, c.imageKeys)
  }
  if (body.estimatedRedeemDate !== undefined) collection.commercial.estimatedRedeemDate = body.estimatedRedeemDate
  if (body.price !== undefined) {
    const sold = tokensOf(state.chain, collection.id).some((t) => !['MINTED', 'BURNED'].includes(t.status))
    if (sold) throw stateError('TOK_PRICE_LOCKED', 'La colección ya tiene ventas: el precio no se puede cambiar')
    collection.price = body.price === null ? null : priceOf(ctx, body.price, by)
    if (collection.price) collection.priceHistory.push(collection.price)
  }
  collection.updatedAt = ctx.now
  return collection
}

export function publishCollection(state: TraceState, ctx: ChainCtx, collection: StoredCollection, by: UserRef, reason: string | null): StoredCollection {
  if (collection.status === 'MINTING') assertPublishable(state, ctx, collection)
  if (collection.status !== 'READY') throw invalidCollectionTransition(collection.status, 'PUBLISHED')
  assertPublishable(state, ctx, collection)
  setCollectionStatus(collection, ctx, 'PUBLISHED', by.fullName, reason)
  appendLotEvent(state, ctx, lotOfCollection(state, collection), {
    type: 'COLLECTION_PUBLISHED',
    occurredAt: ctx.now,
    actor: null,
    summary: `Colección «${collection.commercial.name}» publicada`,
    data: { collectionId: collection.id },
    resource: { type: 'collection', id: collection.id },
  })
  pushNotice(state.chain, { type: 'COLLECTION_PUBLISHED', wineryId: collection.wineryId, collectionId: collection.id })
  return collection
}

export function pauseCollection(state: TraceState, ctx: ChainCtx, collection: StoredCollection, by: UserRef | null, reason: string): StoredCollection {
  if (collection.status !== 'PUBLISHED') throw invalidCollectionTransition(collection.status, 'PAUSED')
  setCollectionStatus(collection, ctx, 'PAUSED', by?.fullName ?? SYSTEM, reason)
  pushNotice(state.chain, { type: 'COLLECTION_PAUSED', wineryId: collection.wineryId, collectionId: collection.id, message: reason })
  return collection
}

export function resumeCollection(state: TraceState, ctx: ChainCtx, collection: StoredCollection, by: UserRef, reason: string | null): StoredCollection {
  if (collection.status !== 'PAUSED') throw invalidCollectionTransition(collection.status, 'PUBLISHED')
  assertPublishable(state, ctx, collection)
  setCollectionStatus(collection, ctx, 'PUBLISHED', by.fullName, reason)
  pushNotice(state.chain, { type: 'COLLECTION_RESUMED', wineryId: collection.wineryId, collectionId: collection.id, message: reason })
  return collection
}

export function closeCollection(state: TraceState, ctx: ChainCtx, collection: StoredCollection, by: UserRef, reason: string): StoredCollection {
  if (!['READY', 'PUBLISHED', 'PAUSED'].includes(collection.status)) throw invalidCollectionTransition(collection.status, 'CLOSED')
  const closure = closureOf(state, ctx, collection)
  if (closure && (closure.status === 'SHORTFALL_OPEN' || closure.status === 'DECIDED')) {
    throw stateError('TOK_CLOSURE_PENDING', 'El cierre del lote con faltante aún no está resuelto', [detail('TOK_CLOSURE_PENDING', `Cierre en ${closure.status}`, { meta: { closureStatus: closure.status } })])
  }
  setCollectionStatus(collection, ctx, 'CLOSED', by.fullName, reason)
  return collection
}

// ---------------------------------------------------------------------------
// Cierre del lote con faltante (§8.4)
// ---------------------------------------------------------------------------

const SOLD_STATUSES = ['SOLD', 'REDEEMABLE', 'PASS_ACTIVE', 'REDEEMED', 'EXPIRED']

/**
 * Cierre de la colección de un lote embotellado o descartado (se calcula al consultarlo y se
 * recalcula mientras no haya decisión, p. ej. si se anulan códigos). `null` si aún no aplica.
 */
export function closureOf(state: TraceState, ctx: ChainCtx, collection: StoredCollection): StoredClosure | null {
  const chain = state.chain
  const lot = lotOfCollection(state, collection)
  const bottled = lotBottling(state, lot.id) !== null
  if (!bottled && lot.discarded === null) return null
  const stored = chain.closures.find((c) => c.collectionId === collection.id)
  if (stored && (stored.status === 'DECIDED' || stored.status === 'RESOLVED')) return stored
  const tokens = tokensOf(chain, collection.id)
  const bottles = lot.discarded !== null ? 0 : (activeBottles(state, lot) ?? 0)
  const burned = tokens.filter((t) => t.status === 'BURNED').length
  const unsoldTokens = tokens.filter((t) => t.status === 'MINTED').sort((a, b) => b.bottleNumber - a.bottleNumber)
  const soldTokens = tokens.filter((t) => SOLD_STATUSES.includes(t.status)).sort((a, b) => (b.soldAt ?? '').localeCompare(a.soldAt ?? ''))
  const shortfall = Math.max(0, tokens.length - burned - bottles)
  const unsoldToBurn = Math.min(shortfall, unsoldTokens.length)
  const soldWithoutBottle = Math.min(shortfall - unsoldToBurn, soldTokens.length)
  const affected = [...unsoldTokens.slice(0, unsoldToBurn), ...soldTokens.slice(0, soldWithoutBottle)]
  const closure: StoredClosure = {
    id: stored?.id ?? ctx.newId('lot-closure'),
    wineryId: collection.wineryId,
    lotId: lot.id,
    collectionId: collection.id,
    status: shortfall > 0 ? 'SHORTFALL_OPEN' : 'NO_SHORTFALL',
    computedAt: stored && stored.shortfall === shortfall && stored.bottles === bottles ? stored.computedAt : ctx.now,
    bottles,
    minted: tokens.length,
    sold: soldTokens.length,
    reserved: tokens.filter((t) => t.status === 'RESERVED').length,
    unsold: unsoldTokens.length,
    shortfall,
    unsoldToBurn,
    soldWithoutBottle,
    unsoldPolicy: null,
    decision: null,
    // Solo los NFT afectados: primero los no vendidos con el número de botella más alto (S-23).
    items: affected.map((t) => ({ tokenId: t.tokenId, bottleNumber: t.bottleNumber, status: t.status, outcome: 'PENDING', burnTxId: null, resolvedAt: null, orderId: t.orderId ?? null, paidAt: t.soldAt, note: null })),
  }
  if (stored) Object.assign(stored, closure)
  else {
    chain.closures.push(closure)
    if (shortfall > 0) {
      appendLotEvent(state, ctx, lot, {
        type: 'SHORTFALL_DETECTED',
        occurredAt: ctx.now,
        actor: null,
        summary: `Faltante: ${shortfall} botellas menos que NFT emitidos`,
        data: { collectionId: collection.id, bottles, minted: tokens.length, shortfall },
        resource: { type: 'collection', id: collection.id },
      })
      pushNotice(chain, { type: 'SHORTFALL_DETECTED', wineryId: collection.wineryId, collectionId: collection.id, data: { bottles, minted: tokens.length, shortfall, soldWithoutBottle } })
    }
  }
  return stored ?? closure
}

export function closureNotApplicable(lot: Lot): ApiError {
  return stateError('TOK_CLOSURE_NOT_APPLICABLE', 'El cierre solo aplica a un lote embotellado o descartado', [detail('TOK_CLOSURE_NOT_APPLICABLE', `El lote está en ${lot.stage}`, { meta: { stage: lot.stage } })])
}

/**
 * `POST …/closure/decide`. Con faltante o con `BURN` hacen falta quemas: solo administración
 * (`canBurn`); sin faltante y `KEEP_ON_SALE`, también operaciones.
 */
export function decideClosure(state: TraceState, ctx: ChainCtx, collection: StoredCollection, unsoldPolicy: UnsoldPolicy, reason: string, by: UserRef, canBurn: boolean): StoredClosure {
  const chain = state.chain
  const closure = closureOf(state, ctx, collection)
  if (!closure) throw closureNotApplicable(lotOfCollection(state, collection))
  if (closure.status === 'DECIDED' || closure.status === 'RESOLVED') throw invalidCollectionTransition(closure.status, 'DECIDED')
  const burns = closure.unsoldToBurn > 0 || unsoldPolicy === 'BURN'
  if (burns && !canBurn) throw new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', 'Solo administración puede decidir un cierre que quema NFT')
  closure.unsoldPolicy = unsoldPolicy
  closure.decision = { by, at: ctx.now, reason }
  const tokens = tokensOf(chain, collection.id)
  const toBurn = new Set(closure.items.filter((i) => i.status === 'MINTED').map((i) => i.tokenId))
  if (unsoldPolicy === 'BURN') {
    for (const t of tokens) {
      if (t.status !== 'MINTED' || toBurn.has(t.tokenId)) continue
      toBurn.add(t.tokenId)
      closure.items.push({ tokenId: t.tokenId, bottleNumber: t.bottleNumber, status: t.status, outcome: 'PENDING', burnTxId: null, resolvedAt: null, orderId: null, paidAt: null, note: null })
    }
  }
  for (const item of closure.items) {
    if (!toBurn.has(item.tokenId)) continue
    const token = tokens.find((t) => t.tokenId === item.tokenId)!
    item.outcome = 'BURN_UNSOLD'
    item.burnTxId = enqueueTx(state, ctx, {
      kind: 'BURN_UNSOLD',
      intentKey: `burn-unsold:${closure.id}:${token.tokenId}`,
      subject: { type: 'TOKEN', id: token.id },
      wineryId: collection.wineryId,
      intent: { closureId: closure.id, tokenId: token.tokenId, collectionId: collection.id },
      requestedBy: { userId: by.userId, fullName: by.fullName, source: 'API' },
    }).id
  }
  closure.status = closure.items.every((i) => i.resolvedAt !== null) ? 'RESOLVED' : 'DECIDED'
  return closure
}

/** `POST …/closure/items/{tokenId}/resolve`: devolución o sustitución manual de un NFT vendido sin botella. */
export function resolveClosureItem(state: TraceState, ctx: ChainCtx, collection: StoredCollection, tokenId: number, body: ResolveLotClosureItem): StoredClosure {
  const closure = closureOf(state, ctx, collection)
  if (!closure) throw closureNotApplicable(lotOfCollection(state, collection))
  const item = closure.items.find((i) => i.tokenId === tokenId)
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Ese NFT no está entre los afectados por el cierre')
  if (item.outcome !== 'PENDING' || item.status === 'MINTED') throw invalidCollectionTransition(item.outcome, body.outcome)
  Object.assign(item, { outcome: body.outcome, note: body.note, resolvedAt: ctx.now })
  if (closure.status === 'DECIDED' && closure.items.every((i) => i.resolvedAt !== null)) closure.status = 'RESOLVED'
  return closure
}
