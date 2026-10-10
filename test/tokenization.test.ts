import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ChainTransactionSchema,
  CollectionSchema,
  ConsumerProfileSchema,
  isValidStrKey,
  LotClosureSchema,
  LotTokenizationStatusSchema,
  OrderSchema,
  PlatformTokenizationRequestSchema,
  PublicDossierVerificationSchema,
  PublicNftMetadataSchema,
  TokenizationRequestSchema,
  WineryChainAccountViewSchema,
  type ApiErrorDetail,
  type ChainTransaction,
  type Collection,
  type Dashboard,
  type Envelope,
  type Lot,
  type LotClosure,
  type Paged,
  type Token,
  type TokenizationApproval,
  type TraceDashboard,
  type WineryChainIdentity,
} from '../src'
import { chainFixtures, erpFixtures as F, PREVENTA_CASE, SINGANI_CASE, tokenizationFixtures as T } from '../src/fixtures'
import { advanceMockClock, getErpDb, MARKETPLACE_DRAFT_CONTRACT, mockChain, resetScenario, setScenario, SHORTFALL_SCENARIO_BOTTLES } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf } from './helpers'

// Ola 3 (plan/contratos/o3-tokenizacion.md): reglas de la cuota y de las solicitudes, transiciones
// de la colección, red simulada (emisión, fallos, reintento, anclaje, identidad), cierre con
// faltante, permisos, rutas públicas, escenarios de `/__mocks` y el borrador del Marketplace.

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
  resetScenario()
})
afterAll(() => server.close())

const as = (key: string) => `mock.access.${key}`
const OWNER = as('cvj_admin')
const ENOLOGIST = as('cvj_enologa')
const ALTOS_OWNER = as('altos_admin')
const OPS = as('operaciones')
const ADMIN = as('bo_admin')
const SUPPORT = as('soporte')
const CONSUMER = as('maria')

const CINTI = SINGANI_CASE.wineryId
const ALTOS = F.wineries.find((w) => w.commercialName === 'Bodega Altos de Calamuchita')!.id
const lotNamed = (name: string) => F.lots.find((l) => l.name === name)!
const origin = lotNamed('Singani Edición Aniversario 2026')
const collectionOf = (name: string) => T.collections.find((c) => c.name === name)!
const preventa = collectionOf(PREVENTA_CASE.name)
const granReserva = collectionOf(SINGANI_CASE.name)
const portillo = collectionOf('Singani El Portillo 2025')
const requestOf = (lotName: string, status: string) => T.requests.find((r) => r.lot.name === lotName && r.status === status)!

let keySeq = 0
/** Escritura con `Idempotency-Key` nueva (la exigen varias operaciones de la Ola 3). */
const post = <D = unknown>(path: string, token: string, body: unknown = {}, method = 'POST') => call<D>(path, { method, token, body, headers: { 'Idempotency-Key': uid(`tokenization-test:${++keySeq}`) } })
const get = async <D>(path: string, token?: string) => dataOf((await call<D>(path, { token })).json)
function failure(res: { status: number; json: Envelope<unknown> }) {
  if (res.json.success) throw new Error(`Se esperaba un error y llegó ${res.status}`)
  return { status: res.status, code: res.json.error.code, details: (res.json.error.details ?? []) as ApiErrorDetail[] }
}
const COVER = (wineryId: string) => ({ key: `org/${wineryId}/collections/2026/portada.jpg`, alt: 'Botella de la colección', isCover: true })
const COMMERCIAL = { name: 'Singani Edición Aniversario 2026', description: 'Edición limitada por el aniversario de la destilería, en preventa.' }
const tx = async (id: string) => ChainTransactionSchema.parse(await get(`/v1/platform/chain/transactions/${id}`, SUPPORT))

describe('solicitud de tokenización: reglas de la cuota (§5.2) y permisos (§10)', () => {
  it('estado del lote: límite sobre la estimación o sobre las botellas, bloqueos con su código y solicitud abierta', async () => {
    const status = LotTokenizationStatusSchema.parse(await get(`/v1/lots/${origin.id}/tokenization`, ENOLOGIST))
    expect(status).toMatchObject({ tokenizable: true, blockers: [], approvalRequired: true, chainIdentity: { status: 'ACTIVE' }, openRequest: null, collection: null, limits: { basis: 'ESTIMATE', estimatedBottles: 1800, bottles: null, authorizedQuota: 0, maxQuantity: 1800 } })
    const blockerOf = async (lotName: string, token = ENOLOGIST) => LotTokenizationStatusSchema.parse(await get(`/v1/lots/${lotNamed(lotName).id}/tokenization`, token)).blockers.map((b) => b.code)
    expect(await blockerOf('CVJ-2026-SINGANI-001')).toEqual(['TOK_LOT_ESTIMATE_MISSING'])
    expect(await blockerOf('Singani Gran Reserva 2026')).toEqual(['TOK_LOT_NOT_TOKENIZABLE'])
    expect(await blockerOf('Singani El Molino 2026')).toEqual(['TOK_REQUEST_ALREADY_OPEN'])
    expect(await blockerOf('Moscatel Los Sauces 2026', as('altos_enologa'))).toEqual(['TOK_LOT_PRODUCT_UNDEFINED'])
    // Embotellado: el límite son los códigos de botella activos, menos lo ya autorizado y lo pedido.
    const bottled = LotTokenizationStatusSchema.parse(await get(`/v1/lots/${portillo.lotId}/tokenization`, ALTOS_OWNER))
    expect(bottled).toMatchObject({ tokenizable: false, limits: { basis: 'BOTTLES', bottles: 1040, authorizedQuota: 240, pendingQuantity: 500, maxQuantity: 300 }, openRequest: { kind: 'QUOTA_INCREASE' }, collection: { status: 'READY' } })
    // El operario y el agrónomo solo ven la marca en la lista de lotes; lo de otra bodega, 404.
    expect((await call(`/v1/lots/${origin.id}/tokenization`, { token: as('cvj_operario') })).status).toBe(403)
    expect(failure(await call(`/v1/lots/${origin.id}/tokenization`, { token: ALTOS_OWNER }))).toMatchObject({ status: 404, code: 'TRC_LOT_NOT_FOUND' })
    const lots = await get<Paged<Lot>>('/v1/lots?limit=100', as('cvj_operario'))
    expect(lots.items.find((l) => l.id === PREVENTA_CASE.lotId)!.tokenization).toEqual({ state: 'PUBLISHED', quota: 100, minted: 100, collectionId: preventa.id })
  })

  it('solo el dueño autoriza, con Idempotency-Key obligatoria; la plataforma no escribe en las rutas del ERP', async () => {
    const url = `/v1/lots/${origin.id}/tokenization-requests`
    const body = { quantity: 300, commercial: COMMERCIAL, confirm: true }
    expect(failure(await post(url, ENOLOGIST, body))).toMatchObject({ status: 403, code: 'AUTH_INSUFFICIENT_PERMISSIONS' })
    expect(failure(await post(`${url}?wineryId=${CINTI}`, OPS, body))).toMatchObject({ status: 403, code: 'TRC_PLATFORM_READ_ONLY' })
    // Sin la cabecera: 422 con el campo.
    expect(failure(await call(url, { token: OWNER, body }))).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REQUIRED', details: [{ field: 'Idempotency-Key' }] })
    expect(failure(await post(url, OWNER, { quantity: 300 }))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'confirm' }] })
    // Misma clave y cuerpo → la misma respuesta; otro cuerpo → 409.
    const headers = { 'Idempotency-Key': uid('tokenization-test:replay') }
    const first = await call(url, { token: OWNER, body, headers })
    expect(first.status).toBe(201)
    const replay = await call(url, { token: OWNER, body, headers })
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(dataOf(replay.json)).toEqual(dataOf(first.json))
    expect(failure(await call(url, { token: OWNER, body: { ...body, quantity: 301 }, headers }))).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(getErpDb().chain.requests.filter((r) => r.lotId === origin.id)).toHaveLength(1)
    // La plataforma sí lee con `?wineryId=`; y una bodega suspendida no opera el ERP.
    expect((await get<Paged<unknown>>(`/v1/tokenization-requests?wineryId=${CINTI}`, SUPPORT)).total).toBeGreaterThan(0)
    const uriondoLot = lotNamed('Singani Casa Uriondo 2025')
    expect(failure(await post(`/v1/lots/${uriondoLot.id}/tokenization-requests`, as('sofia'), body))).toMatchObject({ status: 403 })
  })

  it('cuota: mayor que la estimación o que las botellas, cantidad inválida, lote no tokenizable y segunda solicitud abierta', async () => {
    const request = (lotId: string, quantity: unknown, token = OWNER) => post(`/v1/lots/${lotId}/tokenization-requests`, token, { quantity, commercial: COMMERCIAL, confirm: true })
    expect(failure(await request(origin.id, 1801))).toMatchObject({
      status: 422,
      code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
      details: [{ field: 'quantity', code: 'TOK_QUOTA_EXCEEDS_ESTIMATE', expected: 1800, actual: 1801, meta: { maxQuantity: 1800 } }],
    })
    expect(failure(await request(origin.id, 0))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' })
    expect(failure(await request(origin.id, 2.5))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' })
    expect(failure(await request(lotNamed('CVJ-2026-SINGANI-001').id, 10))).toMatchObject({ status: 422, code: 'TOK_LOT_ESTIMATE_MISSING' })
    expect(failure(await request(SINGANI_CASE.lotId, 10))).toMatchObject({ status: 409, code: 'TOK_LOT_NOT_TOKENIZABLE', details: [{ meta: { stage: 'ANCHORED' } }] })
    const open = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    expect(failure(await request(open.lotId, 10))).toMatchObject({ status: 409, code: 'TOK_REQUEST_ALREADY_OPEN', details: [{ meta: { requestId: open.id } }] })
    // Embotellado (El Portillo: 1.040 botellas, 240 autorizadas): se retira la ampliación y se pide de más.
    const pending = requestOf('Singani El Portillo 2025', 'SUBMITTED')
    expect((await post(`/v1/tokenization-requests/${pending.id}/withdraw`, ALTOS_OWNER, { reason: 'Se pide otra cantidad' })).status).toBe(200)
    expect(failure(await request(portillo.lotId, 801, ALTOS_OWNER))).toMatchObject({ status: 422, code: 'TOK_QUOTA_EXCEEDS_BOTTLES', details: [{ expected: 1040, actual: 1041, meta: { maxQuantity: 800 } }] })
    const increase = TokenizationRequestSchema.parse(dataOf((await request(portillo.lotId, 800, ALTOS_OWNER)).json))
    expect(increase).toMatchObject({ kind: 'QUOTA_INCREASE', status: 'SUBMITTED', quantity: 800, resultingQuota: 1040, collectionId: portillo.id })
    // La solicitud de otra bodega no existe para esta.
    expect(failure(await call(`/v1/tokenization-requests/${increase.id}`, { token: OWNER }))).toMatchObject({ status: 404, code: 'TOK_REQUEST_NOT_FOUND' })
    expect(failure(await post(`/v1/tokenization-requests/${increase.id}/withdraw`, OWNER, { reason: 'No es mía' }))).toMatchObject({ status: 404, code: 'TOK_REQUEST_NOT_FOUND' })
  })
})

describe('recorrido H3 (§14): de la autorización a la preventa publicada y la ampliación', () => {
  it('autorizar → cambios pedidos → reenviar → aprobar → emisión confirmada en la red → publicar, pausar, reanudar → ampliar la cuota', async () => {
    // 1. La dueña autoriza 300 botellas sin portada.
    const createdRes = await post(`/v1/lots/${origin.id}/tokenization-requests`, OWNER, { quantity: 300, commercial: COMMERCIAL, notes: 'Preventa de aniversario', confirm: true })
    const request = TokenizationRequestSchema.parse(dataOf(createdRes.json))
    expect(request).toMatchObject({ kind: 'INITIAL', status: 'SUBMITTED', quantity: 300, resultingQuota: 300, requiresApproval: true, submittedBy: { fullName: 'Rosa Camargo', role: 'OWNER' }, limitsAtSubmission: { maxQuantity: 1800 } })
    expect(request).not.toHaveProperty('internalNotes')
    expect((await get<Lot>(`/v1/lots/${origin.id}`, ENOLOGIST)).tokenization).toEqual({ state: 'REQUESTED', quota: 0, minted: 0, collectionId: null })
    const url = `/v1/platform/tokenization-requests/${request.id}`

    // 2. Operaciones la toma (soporte solo lee) y pide cambios; fuera de su estado → 409 con `from` y `to`.
    expect(failure(await post(`${url}/take`, SUPPORT))).toMatchObject({ status: 403 })
    expect(failure(await post(`${url}/approve`, OPS))).toMatchObject({ status: 409, code: 'TOK_REQUEST_INVALID_TRANSITION', details: [{ meta: { from: 'SUBMITTED', to: 'APPROVED' } }] })
    const taken = PlatformTokenizationRequestSchema.parse(dataOf((await post(`${url}/take`, OPS)).json))
    expect(taken).toMatchObject({ status: 'IN_REVIEW', assignee: { fullName: 'Valeria Méndez' }, priceSuggestion: { available: false, reason: 'POLICY_UNDEFINED' }, review: { lot: { id: origin.id }, limits: { maxQuantity: 1800 }, chainIdentity: { status: 'ACTIVE' }, traceability: { dossierStatus: 'OPEN' } } })
    expect(taken.review.otherCollectionsOfWinery.map((c) => c.name).sort()).toEqual(['Singani Gran Reserva 2026', 'Singani Preventa 2026'])
    expect(failure(await post(`${url}/take`, OPS))).toMatchObject({ status: 409, code: 'TOK_REQUEST_INVALID_TRANSITION' })
    // Aprobar sin portada: un detalle por campo que falta.
    expect(failure(await post(`${url}/approve`, OPS))).toMatchObject({ status: 422, code: 'TOK_COMMERCIAL_DATA_INCOMPLETE', details: [{ field: 'commercial.imageKeys' }] })
    expect(dataOf((await post<{ status: string }>(`${url}/request-changes`, OPS, { message: 'Falta la foto de portada', fields: ['commercial.imageKeys'] })).json).status).toBe('CHANGES_REQUESTED')
    expect((await get<Lot>(`/v1/lots/${origin.id}`, ENOLOGIST)).tokenization.state).toBe('CHANGES_REQUESTED')

    // 3. La dueña añade la portada y reenvía; operaciones la toma de nuevo.
    expect((await post(`/v1/tokenization-requests/${request.id}`, OWNER, { commercial: { imageKeys: [COVER(CINTI)], tastingNotes: 'Floral y cítrico' } }, 'PATCH')).status).toBe(200)
    const resubmitted = TokenizationRequestSchema.parse(dataOf((await post(`/v1/tokenization-requests/${request.id}/resubmit`, OWNER, { message: 'Añadida' })).json))
    expect(resubmitted).toMatchObject({ status: 'SUBMITTED', assignee: null })
    expect(resubmitted.changeRequests[0]!.resolvedAt).not.toBeNull()
    expect(failure(await post(`/v1/tokenization-requests/${request.id}`, OWNER, { quantity: 5000 }, 'PATCH'))).toMatchObject({ status: 422, code: 'TOK_QUOTA_EXCEEDS_ESTIMATE' })
    await post(`${url}/take`, OPS)
    expect(failure(await post(`/v1/tokenization-requests/${request.id}`, OWNER, { quantity: 200 }, 'PATCH'))).toMatchObject({ status: 409, code: 'TOK_REQUEST_INVALID_TRANSITION' })
    expect((await post(`${url}/notes`, OPS, { text: 'Todo en orden' })).status).toBe(201)

    // 4. Aprobar (sin precio: política sin definir): colección en emisión y una intención MINT_BATCH en cola.
    const approvedRes = await post<TokenizationApproval>(`${url}/approve`, OPS, { reason: 'Datos completos' })
    expect(approvedRes.status).toBe(201)
    const approved = dataOf(approvedRes.json)
    expect(approved.request).toMatchObject({ status: 'APPROVED', decision: { outcome: 'APPROVED', by: { fullName: 'Valeria Méndez', system: false } } })
    expect(approved.collection).toMatchObject({ slug: 'singani-edicion-aniversario-2026', status: 'MINTING', mintStatus: 'PENDING', quota: 300, pendingMintQuantity: 300, price: null, saleState: null, counts: { minted: 0 } })
    expect(approved.mint).toMatchObject({ sequence: 1, quantity: 300, status: 'PENDING', lotArg: origin.reference, ranges: [], transactions: [{ kind: 'MINT_BATCH', status: 'PENDING', txHash: null, explorerUrl: null, attempts: 0 }] })
    const collectionUrl = `/v1/platform/collections/${approved.collection.id}`
    expect(failure(await post(`${collectionUrl}/publish`, OPS))).toMatchObject({ status: 409, code: 'TOK_MINT_NOT_CONFIRMED', details: [{ meta: { mintStatus: 'PENDING' } }] })
    expect((await get<Lot>(`/v1/lots/${origin.id}`, ENOLOGIST)).tokenization).toMatchObject({ state: 'MINTING', quota: 300, minted: 0 })

    // 5. La red avanza con el reloj simulado: un paso por estado.
    const txId = approved.mint.transactions[0]!.id
    expect(mockChain.pending().map((t) => t.id)).toEqual([txId])
    mockChain.advance()
    expect(await tx(txId)).toMatchObject({ status: 'BUILDING', attempts: 1, txHash: null })
    mockChain.advance()
    const submitted = await tx(txId)
    expect(submitted).toMatchObject({ status: 'SUBMITTED', ledger: null })
    expect(submitted.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${submitted.txHash}`)
    expect((await get<Collection>(collectionUrl, SUPPORT)).status).toBe('MINTING')
    mockChain.advance()
    const confirmed = await tx(txId)
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', lastError: null, result: { returnValue: 459, contractEvents: ['consecutive_mint', 'lot_minted'] }, signers: [{ role: 'OPERATIONS' }, { role: 'WINERY', wineryId: CINTI }] })
    expect(confirmed.history.map((h) => h.status)).toEqual(['PENDING', 'BUILDING', 'SUBMITTED', 'CONFIRMED'])
    expect(mockChain.pending()).toEqual([])

    // 6. Al confirmarse: 300 NFT (ids continuos tras los 160 del contrato, botellas 1–300) y colección lista.
    const ready = CollectionSchema.parse(await get(collectionUrl, SUPPORT))
    expect(ready).toMatchObject({ status: 'READY', mintStatus: 'CONFIRMED', pendingMintQuantity: 0, counts: { minted: 300, available: 300 }, saleState: null })
    expect(ready.mints[0]!.ranges).toEqual([{ firstTokenId: 160, lastTokenId: 459, firstBottleNumber: 1, lastBottleNumber: 300 }])
    expect(ready.metrics).toMatchObject({ quota: 300, authorizedVsEstimatePercent: 16.7, chainCosts: { transactions: 1 }, byMint: [{ sequence: 1, quantity: 300 }] })
    const tokens = await get<Paged<Token>>(`/v1/collections/${ready.id}/tokens?fromNumber=299&limit=5`, OWNER)
    expect(tokens.items.map((t) => [t.tokenId, t.bottleNumber, t.status, t.owner.kind])).toEqual([[458, 299, 'MINTED', 'WINERY'], [459, 300, 'MINTED', 'WINERY']])
    expect((await call(`/v1/collections/${ready.id}/tokens`, { token: ENOLOGIST })).status).toBe(403)
    const timeline = await get<{ events: { type: string; summary: string }[] }>(`/v1/lots/${origin.id}/timeline`, ENOLOGIST)
    expect(timeline.events.slice(-2).map((e) => [e.type, e.summary])).toEqual([['TOKENIZATION_AUTHORIZED', 'Tokenización autorizada: 300 botellas'], ['NFT_MINTED', '300 botellas en preventa']])
    const events = await get<Paged<{ type: string; matchedTransactionId: string }>>(`/v1/platform/chain/events?txHash=${confirmed.txHash}`, SUPPORT)
    expect(events.items.map((e) => e.type).sort()).toEqual(['consecutive_mint', 'lot_minted'])

    // 7. Publicar (preventa), pausar y reanudar; las transiciones fuera de sitio → 409.
    expect(failure(await post(`${collectionUrl}/publish`, SUPPORT))).toMatchObject({ status: 403 })
    expect(failure(await post(`${collectionUrl}/pause`, OPS, { reason: 'Aún no está publicada' }))).toMatchObject({ status: 409, code: 'TOK_COLLECTION_INVALID_TRANSITION', details: [{ meta: { from: 'READY', to: 'PAUSED' } }] })
    expect(dataOf((await post<Collection>(`${collectionUrl}/publish`, OPS)).json)).toMatchObject({ status: 'PUBLISHED', saleState: 'PRESALE', redeemable: false })
    expect(failure(await post(`${collectionUrl}/publish`, OPS))).toMatchObject({ status: 409, code: 'TOK_COLLECTION_INVALID_TRANSITION' })
    expect(failure(await post(`${collectionUrl}/pause`, OPS, {}))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'reason' }] })
    expect(dataOf((await post<Collection>(`${collectionUrl}/pause`, OPS, { reason: 'Revisión de textos' })).json)).toMatchObject({ status: 'PAUSED', saleState: null })
    const resumed = dataOf((await post<Collection>(`${collectionUrl}/resume`, OPS)).json)
    expect(resumed.statusHistory.map((h) => h.status)).toEqual(['MINTING', 'READY', 'PUBLISHED', 'PAUSED', 'PUBLISHED'])
    expect((await get<Lot>(`/v1/lots/${origin.id}`, ENOLOGIST)).tokenization.state).toBe('PUBLISHED')
    // El precio se fija después, con motivo, y queda en su historial.
    const priced = dataOf((await post<Collection>(collectionUrl, OPS, { price: { amountMinor: 24000, currency: 'BOB' }, reason: 'Precio de lanzamiento' }, 'PATCH')).json)
    expect(priced).toMatchObject({ price: { amountMinor: 24000, source: 'MANUAL', setBy: { fullName: 'Valeria Méndez' } }, slug: 'singani-edicion-aniversario-2026' })
    expect(priced.priceHistory).toHaveLength(1)

    // 8. Ampliación: la pide la bodega; al aprobarse, segunda emisión con botellas 301–500 e ids continuos.
    const more = TokenizationRequestSchema.parse(dataOf((await post(`/v1/lots/${origin.id}/tokenization-requests`, OWNER, { quantity: 200, confirm: true })).json))
    expect(more).toMatchObject({ kind: 'QUOTA_INCREASE', resultingQuota: 500, collectionId: ready.id, limitsAtSubmission: { authorizedQuota: 300, maxQuantity: 1500 } })
    await post(`/v1/platform/tokenization-requests/${more.id}/take`, OPS)
    const second = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${more.id}/approve`, OPS)).json)
    expect(second.collection).toMatchObject({ status: 'PUBLISHED', quota: 500, mintStatus: 'PENDING', pendingMintQuantity: 200, counts: { minted: 300 } })
    expect(mockChain.settle()).toBe(3)
    const grown = await get<Collection>(collectionUrl, SUPPORT)
    expect(grown).toMatchObject({ quota: 500, mintStatus: 'CONFIRMED', counts: { minted: 500, available: 500 } })
    expect(grown.mints[1]!.ranges).toEqual([{ firstTokenId: 460, lastTokenId: 659, firstBottleNumber: 301, lastBottleNumber: 500 }])
    expect(grown.quotaHistory.map((q) => [q.kind, q.quantity, q.resultingQuota])).toEqual([['INITIAL', 300, 300], ['QUOTA_INCREASE', 200, 500]])

    // 9. La estimación no baja de lo emitido; por encima sí.
    expect(failure(await call(`/v1/lots/${origin.id}`, { method: 'PATCH', token: ENOLOGIST, body: { estimatedBottles: 499, reason: 'Menos uva' } }))).toMatchObject({
      status: 422,
      code: 'TOK_ESTIMATE_BELOW_MINTED',
      details: [{ field: 'estimatedBottles', expected: 500, actual: 499 }],
    })
    expect((await call(`/v1/lots/${origin.id}`, { method: 'PATCH', token: ENOLOGIST, body: { estimatedBottles: 600, reason: 'Menos uva' } })).status).toBe(200)
    expect((await get<{ limits: { maxQuantity: number } }>(`/v1/lots/${origin.id}/tokenization`, OWNER)).limits.maxQuantity).toBe(100)

    // Los tableros y la bitácora lo reflejan.
    const erp = await get<TraceDashboard>('/v1/traceability/dashboard', OWNER)
    expect(erp.tokenization).toEqual({ openRequests: 1, changesRequested: 0, collectionsPublished: 3 })
    const audit = await get<Paged<{ action: string }>>('/v1/platform/audit?limit=100', ADMIN)
    expect(audit.items.map((e) => e.action)).toEqual(expect.arrayContaining(['TOKENIZATION_REQUESTED', 'TOKENIZATION_TAKEN', 'TOKENIZATION_CHANGES_REQUESTED', 'TOKENIZATION_RESUBMITTED', 'TOKENIZATION_APPROVED', 'NFT_MINT_REQUESTED', 'COLLECTION_PUBLISHED', 'COLLECTION_PAUSED', 'COLLECTION_RESUMED', 'COLLECTION_PRICE_SET']))
  })

  it('aprobar con «publicar al emitir», rechazar con motivo y retirar; bodega suspendida → TOK_WINERY_NOT_ACTIVE y colecciones pausadas', async () => {
    const inReview = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${inReview.id}/approve`, OPS, { price: { amountMinor: 19500, currency: 'BOB' }, publishOnMint: true })).json)
    expect(approved.collection).toMatchObject({ status: 'MINTING', price: { amountMinor: 19500 } })
    mockChain.settle()
    expect(await get<Collection>(`/v1/collections/${approved.collection.id}`, OWNER)).toMatchObject({ status: 'PUBLISHED', saleState: 'PRESALE', counts: { minted: 400 } })
    // Nombre repetido → 409 TOK_SLUG_TAKEN al aprobar otra colección con ese nombre.
    const created = dataOf((await post<{ id: string }>(`/v1/lots/${origin.id}/tokenization-requests`, OWNER, { quantity: 10, commercial: { name: 'Singani El Molino 2026', description: 'Otra colección con el mismo nombre.', imageKeys: [COVER(CINTI)] }, confirm: true })).json)
    await post(`/v1/platform/tokenization-requests/${created.id}/take`, OPS)
    expect(failure(await post(`/v1/platform/tokenization-requests/${created.id}/approve`, OPS))).toMatchObject({ status: 409, code: 'TOK_SLUG_TAKEN' })
    expect(failure(await post(`/v1/platform/tokenization-requests/${created.id}/reject`, OPS, {}))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'reason' }] })
    expect(dataOf((await post<{ status: string; decision: unknown }>(`/v1/platform/tokenization-requests/${created.id}/reject`, OPS, { reason: 'Nombre duplicado' })).json)).toMatchObject({ status: 'REJECTED', decision: { outcome: 'REJECTED', reason: 'Nombre duplicado' } })
    expect(failure(await post(`/v1/tokenization-requests/${created.id}/withdraw`, OWNER, { reason: 'Ya no' }))).toMatchObject({ status: 409, code: 'TOK_REQUEST_INVALID_TRANSITION' })

    // Suspender Altos: no se aprueban sus solicitudes. Suspender Cinti Viejo pausa sus colecciones publicadas.
    const altosRequest = requestOf('Singani El Portillo 2025', 'SUBMITTED')
    await post(`/v1/platform/tokenization-requests/${altosRequest.id}/take`, OPS)
    expect((await post(`/v1/platform/wineries/${ALTOS}/suspend`, OPS, { reason: 'Documentación pendiente' })).status).toBe(200)
    expect(failure(await post(`/v1/platform/tokenization-requests/${altosRequest.id}/approve`, OPS))).toMatchObject({ status: 409, code: 'TOK_WINERY_NOT_ACTIVE', details: [{ meta: { status: 'SUSPENDED' } }] })
    expect(failure(await post(`/v1/platform/collections/${portillo.id}/publish`, OPS))).toMatchObject({ status: 409, code: 'TOK_WINERY_NOT_ACTIVE' })
    await post(`/v1/platform/wineries/${CINTI}/suspend`, OPS, { reason: 'Documentación pendiente' })
    const paused = await get<Paged<Collection>>(`/v1/platform/collections?wineryId=${CINTI}`, SUPPORT)
    expect(paused.items.map((c) => c.status)).toEqual(['PAUSED', 'PAUSED', 'PAUSED'])
    expect((await get<Collection>(`/v1/platform/collections/${preventa.id}`, SUPPORT)).statusHistory.at(-1)).toMatchObject({ status: 'PAUSED', by: 'Sistema', reason: 'Bodega suspendida' })
  })
})

describe('red simulada: fallos forzados, reintento y espera de la emisión (§2.3)', () => {
  it('escenario emision-fallida: emisión FAILED con alerta; se reintenta desde el back office y se confirma', async () => {
    setScenario('emision-fallida')
    const collection = (await get<Paged<Collection>>('/v1/platform/collections?mintStatus=FAILED', SUPPORT)).items[0]!
    expect(collection).toMatchObject({ name: PREVENTA_CASE.name, status: 'MINTING', mintStatus: 'FAILED', counts: { minted: 0 }, pendingMintQuantity: 100 })
    expect((await get<Lot>(`/v1/lots/${PREVENTA_CASE.lotId}`, ENOLOGIST)).tokenization).toMatchObject({ state: 'MINT_FAILED', quota: 100, minted: 0 })
    const failed = (await get<Paged<ChainTransaction>>('/v1/platform/chain/transactions?status=FAILED', SUPPORT)).items
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ kind: 'MINT_BATCH', lastError: { code: 'CHN_AUTH_FAILED', retryable: false }, confirmedAt: null })
    expect(failed[0]!.history.at(-1)).toMatchObject({ status: 'FAILED', errorCode: 'CHN_AUTH_FAILED' })
    const alerts = await get<Paged<{ code: string; level: string; subject: { id: string } }>>('/v1/platform/chain/alerts?status=open&level=CRITICAL', SUPPORT)
    expect(alerts.items).toMatchObject([{ code: 'TX_FAILED', subject: { id: failed[0]!.id } }])
    const board = await get<Dashboard>('/v1/platform/dashboard', ADMIN)
    expect(board.chain).toMatchObject({ network: 'TESTNET', failedTransactions: 1, openAlerts: { critical: 1, warning: 1 }, lastReconciliation: { status: 'OK' } })
    expect(board.tokenization).toMatchObject({ mintFailures: 1, collectionsMinting: 1, collectionsPublished: 2, submitted: 1, inReview: 1, changesRequested: 1 })
    // El tablero resume las alertas de la cadena en dos entradas fijas (backend, paso 3.6).
    expect(board.alerts.filter((a) => a.id.startsWith('chain-alerts-'))).toMatchObject([
      { id: 'chain-alerts-critical', level: 'CRITICAL', message: '1 alerta crítica de la cadena sin resolver: nada se corrige solo.', link: '/cadena/alertas' },
      { id: 'chain-alerts-warning', level: 'WARNING', message: '1 aviso de la cadena sin resolver.', link: '/cadena/alertas' },
    ])

    // Una emisión no se abandona; reintentar exige rol, motivo e Idempotency-Key.
    const url = `/v1/platform/chain/transactions/${failed[0]!.id}`
    expect(failure(await post(`${url}/abandon`, OPS, { reason: 'No procede' }))).toMatchObject({ status: 403 })
    expect(failure(await post(`${url}/abandon`, ADMIN, { reason: 'No procede' }))).toMatchObject({ status: 409, code: 'CHN_TX_NOT_ABANDONABLE', details: [{ meta: { kind: 'MINT_BATCH' } }] })
    expect(failure(await post(`${url}/retry`, SUPPORT, { reason: 'Reintento' }))).toMatchObject({ status: 403 })
    expect(failure(await call(`${url}/retry`, { token: OPS, body: { reason: 'Reintento' } }))).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(failure(await post(`${url}/retry`, OPS, {}))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'reason' }] })
    expect(dataOf((await post<ChainTransaction>(`${url}/retry`, OPS, { reason: 'Clave de la bodega corregida' })).json)).toMatchObject({ status: 'PENDING', lastError: null, txHash: null })
    expect(failure(await post(`${url}/retry`, OPS, { reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'CHN_TX_NOT_RETRYABLE', details: [{ meta: { status: 'PENDING' } }] })
    mockChain.settle()
    expect(await tx(failed[0]!.id)).toMatchObject({ status: 'CONFIRMED', attempts: 2 })
    expect(await get<Collection>(`/v1/platform/collections/${collection.id}`, SUPPORT)).toMatchObject({ status: 'READY', mintStatus: 'CONFIRMED', counts: { minted: 100 } })
    expect(failure(await post('/v1/platform/chain/transactions/no-existe/retry', OPS, { reason: 'Nada' }))).toMatchObject({ status: 404, code: 'CHN_TX_NOT_FOUND' })
  })

  it('un error transitorio pasa por RETRYING y se confirma solo; con la emisión desactivada espera en PENDING con CHN_MINT_DISABLED', async () => {
    const inReview = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    mockChain.failNext({ kind: 'MINT_BATCH', code: 'CHN_RPC_UNAVAILABLE' })
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${inReview.id}/approve`, OPS)).json)
    const txId = approved.mint.transactions[0]!.id
    mockChain.advance(mockChain.stepMs * 3)
    expect(await tx(txId)).toMatchObject({ status: 'RETRYING', lastError: { code: 'CHN_RPC_UNAVAILABLE', retryable: true } })
    expect((await tx(txId)).nextAttemptAt).not.toBeNull()
    mockChain.settle()
    const done = await tx(txId)
    expect(done).toMatchObject({ status: 'CONFIRMED', attempts: 2, lastError: null })
    expect(done.history.map((h) => h.status)).toEqual(['PENDING', 'BUILDING', 'SUBMITTED', 'RETRYING', 'BUILDING', 'SUBMITTED', 'CONFIRMED'])
    // El total emitido sube una sola vez.
    expect((await get<Collection>(`/v1/platform/collections/${approved.collection.id}`, SUPPORT)).counts.minted).toBe(400)

    // ADR-011: con CHAIN_MINT_ENABLED=false la intención no se envía.
    mockChain.setMintEnabled(false)
    const created = dataOf((await post<{ id: string }>(`/v1/lots/${origin.id}/tokenization-requests`, OWNER, { quantity: 50, commercial: { ...COMMERCIAL, imageKeys: [COVER(CINTI)] }, confirm: true })).json)
    await post(`/v1/platform/tokenization-requests/${created.id}/take`, OPS)
    const waiting = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${created.id}/approve`, OPS)).json)
    mockChain.settle()
    expect(await tx(waiting.mint.transactions[0]!.id)).toMatchObject({ status: 'PENDING', lastError: { code: 'CHN_MINT_DISABLED' }, attempts: 0 })
    mockChain.setMintEnabled(true)
    mockChain.settle()
    expect(await tx(waiting.mint.transactions[0]!.id)).toMatchObject({ status: 'CONFIRMED', lastError: null })
  })

  it('una emisión de más de 32.000 NFT se parte en trozos; el reloj de los mocks también hace avanzar la red', async () => {
    // Un lote con la estimación suficiente: se sube la del lote en origen.
    await call(`/v1/lots/${origin.id}`, { method: 'PATCH', token: ENOLOGIST, body: { estimatedBottles: 40000, reason: 'Prueba de trozos' } })
    const created = dataOf((await post<{ id: string }>(`/v1/lots/${origin.id}/tokenization-requests`, OWNER, { quantity: 32001, commercial: { ...COMMERCIAL, imageKeys: [COVER(CINTI)] }, confirm: true })).json)
    await post(`/v1/platform/tokenization-requests/${created.id}/take`, OPS)
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${created.id}/approve`, OPS)).json)
    expect(approved.mint.transactions).toHaveLength(2)
    advanceMockClock(60_000)
    const collection = await get<Collection>(`/v1/platform/collections/${approved.collection.id}`, SUPPORT)
    expect(collection).toMatchObject({ status: 'READY', counts: { minted: 32001 } })
    expect(collection.mints[0]!.ranges.map((r) => r.lastBottleNumber - r.firstBottleNumber + 1)).toEqual([32000, 1])
    const txs = await get<Paged<{ kind: string }>>(`/v1/platform/collections/${collection.id}/transactions`, SUPPORT)
    expect(txs).toMatchObject({ total: 2, limit: 20, offset: 0 })
  })
})

describe('anclaje del expediente (§7) e identidad de la bodega (§3)', () => {
  it('escenario anclaje-pendiente: el lote sigue CERTIFIED hasta que la red confirma; después ANCHORED, canjeable y verificable', async () => {
    setScenario('anclaje-pendiente')
    const lotUrl = `/v1/lots/${SINGANI_CASE.lotId}`
    const code = F.lots.find((l) => l.id === SINGANI_CASE.lotId)!.lotCode!
    expect((await get<Lot>(lotUrl, ENOLOGIST)).stage).toBe('CERTIFIED')
    const dossier = await get<{ hash: string; anchor: { status: string; txHash: string | null; memoHashHex: string } }>(`${lotUrl}/dossier`, ENOLOGIST)
    expect(dossier.anchor).toMatchObject({ status: 'PENDING', txHash: null, memoHashHex: dossier.hash, transaction: { kind: 'ANCHOR_DOSSIER', status: 'PENDING' } })
    const pending = PublicDossierVerificationSchema.parse(await get(`/v1/public/lots/${code}/verification`))
    expect(pending.anchor).toMatchObject({ status: 'PENDING', txHash: null, explorerUrl: null })
    expect(pending.checks.map((c) => c.pass)).toEqual([true, false, null, null])
    expect((await get<{ dossier: { anchor: { status: string } }; stage: string }>(`/v1/public/lots/${code}`)).dossier.anchor.status).toBe('PENDING')
    expect(await get<Collection>(`/v1/collections/${granReserva.id}`, OWNER)).toMatchObject({ redeemable: false, saleState: 'PRESALE', anchor: { status: 'PENDING' } })

    mockChain.advance(mockChain.stepMs * 2)
    expect((await get<{ anchor: { status: string } }>(`${lotUrl}/dossier`, ENOLOGIST)).anchor.status).toBe('SUBMITTED')
    // En público, un anclaje enviado sigue siendo «pendiente».
    expect((await get<{ anchor: { status: string } }>(`/v1/public/lots/${code}/verification`)).anchor.status).toBe('PENDING')
    mockChain.advance()
    expect((await get<Lot>(lotUrl, ENOLOGIST)).stage).toBe('ANCHORED')
    const done = PublicDossierVerificationSchema.parse(await get(`/v1/public/lots/${code}/verification`))
    expect(done.checks.map((c) => c.pass)).toEqual([true, true, true, true])
    expect(done).toMatchObject({ anchor: { status: 'ANCHORED', memoHashHex: dossier.hash }, officialAnchorAccount: chainFixtures.platformAccounts.anchor.address })
    expect(done.anchor!.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${done.anchor!.txHash}`)
    expect(done.verifiedOnChainAt).not.toBeNull()
    expect(await get<Collection>(`/v1/collections/${granReserva.id}`, OWNER)).toMatchObject({ redeemable: true, saleState: 'ON_SALE' })
    const timeline = await get<{ events: { type: string }[] }>(`${lotUrl}/timeline`, ENOLOGIST)
    expect(timeline.events.slice(-2).map((e) => e.type)).toEqual(['DOSSIER_ANCHORED', 'TOKENS_REDEEMABLE'])
    // Lote inexistente o código imposible.
    expect(failure(await call('/v1/public/lots/CVJ-2026-SINGANI-999/verification'))).toMatchObject({ status: 404, code: 'PUB_CODE_NOT_FOUND' })
    expect((await call('/v1/public/lots/no-es-un-codigo/verification')).status).toBe(422)
  })

  it('escenario identidad-preparandose: la cuenta y el contrato se crean en dos transacciones; hasta entonces no se aprueba nada', async () => {
    setScenario('identidad-preparandose')
    const view = WineryChainAccountViewSchema.parse(await get('/v1/organizations/current/chain-account', as('altos_operario')))
    expect(view.identity).toMatchObject({ status: 'PROVISIONING', account: null, contract: null, pendingTransactions: [{ kind: 'CREATE_WINERY_ACCOUNT', status: 'BUILDING' }] })
    expect(view).toMatchObject({ byLot: [], totals: { minted: 0 } })
    expect((await get<{ wineries: { symbol: string }[] }>('/v1/public/chain/registry')).wineries.map((w) => w.symbol).sort()).toEqual(['CUR', 'CVJ'])
    const request = requestOf('Tannat La Angostura 2024', 'CHANGES_REQUESTED')
    await post(`/v1/tokenization-requests/${request.id}`, ALTOS_OWNER, { commercial: { imageKeys: [COVER(ALTOS)] } }, 'PATCH')
    await post(`/v1/tokenization-requests/${request.id}/resubmit`, ALTOS_OWNER)
    await post(`/v1/platform/tokenization-requests/${request.id}/take`, OPS)
    expect(failure(await post(`/v1/platform/tokenization-requests/${request.id}/approve`, OPS))).toMatchObject({ status: 409, code: 'TOK_WINERY_CHAIN_NOT_READY', details: [{ meta: { status: 'PROVISIONING' } }] })
    // Reaprovisionar mientras está en curso no crea nada nuevo.
    const again = dataOf((await post<WineryChainIdentity>(`/v1/platform/wineries/${ALTOS}/chain/provision`, OPS, { reason: 'Por si acaso' })).json)
    expect(again.status).toBe('PROVISIONING')
    expect(getErpDb().chain.transactions.filter((t) => t.wineryId === ALTOS)).toHaveLength(1)
    mockChain.advance(mockChain.stepMs * 2)
    expect((await get<{ identity: WineryChainIdentity }>(`/v1/platform/wineries/${ALTOS}/chain-account`, SUPPORT)).identity).toMatchObject({ status: 'PROVISIONING', account: { createdTx: { status: 'CONFIRMED' } }, contract: null, pendingTransactions: [{ kind: 'DEPLOY_WINERY_CONTRACT' }] })
    mockChain.settle()
    const identity = (await get<{ identity: WineryChainIdentity }>(`/v1/organizations/current/chain-account`, ALTOS_OWNER)).identity
    expect(identity).toMatchObject({ status: 'ACTIVE', contract: { symbol: 'ALT', name: 'Bodega Altos de Calamuchita', paused: false, deployedTx: { kind: 'DEPLOY_WINERY_CONTRACT', status: 'CONFIRMED' } }, pendingTransactions: [] })
    expect(isValidStrKey(identity.account!.address, 'G') && isValidStrKey(identity.contract!.address, 'C')).toBe(true)
    expect((await post(`/v1/platform/tokenization-requests/${request.id}/approve`, OPS)).status).toBe(201)
    expect(failure(await post(`/v1/platform/wineries/${ALTOS}/chain/provision`, OPS, { reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'CHN_IDENTITY_ALREADY_ACTIVE' })
  })

  it('una identidad fallida se reaprovisiona; pausar y reanudar el contrato en la red es de administración', async () => {
    setScenario('identidad-preparandose')
    await get('/v1/platform/chain/accounts', SUPPORT)
    mockChain.failNext({ kind: 'DEPLOY_WINERY_CONTRACT', code: 'CHN_INSUFFICIENT_BALANCE' })
    mockChain.settle()
    const failed = (await get<{ identity: WineryChainIdentity }>(`/v1/platform/wineries/${ALTOS}/chain-account`, SUPPORT)).identity
    expect(failed).toMatchObject({ status: 'FAILED', contract: null, lastError: { code: 'CHN_INSUFFICIENT_BALANCE' } })
    expect(failure(await post(`/v1/platform/wineries/${ALTOS}/chain/provision`, SUPPORT, { reason: 'Reintento' }))).toMatchObject({ status: 403 })
    expect(dataOf((await post<WineryChainIdentity>(`/v1/platform/wineries/${ALTOS}/chain/provision`, OPS, { reason: 'Cuenta de operaciones recargada' })).json).status).toBe('PROVISIONING')
    mockChain.settle()
    expect((await get<{ identity: WineryChainIdentity }>(`/v1/platform/wineries/${ALTOS}/chain-account`, SUPPORT)).identity.status).toBe('ACTIVE')

    // Pausa en la red (Cinti Viejo): 202 con la transacción en vuelo; después, PAUSED y no se publica ni se reanuda.
    const pauseUrl = `/v1/platform/wineries/${CINTI}/chain/pause`
    expect(failure(await post(pauseUrl, OPS, { reason: 'Incidente' }))).toMatchObject({ status: 403 })
    expect(failure(await call(pauseUrl, { token: ADMIN, body: { reason: 'Incidente' } }))).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REQUIRED' })
    const pausing = await post<WineryChainIdentity>(pauseUrl, ADMIN, { reason: 'Clave comprometida' })
    expect(pausing.status).toBe(202)
    expect(dataOf(pausing.json)).toMatchObject({ status: 'ACTIVE', contract: { paused: false }, pendingTransactions: [{ kind: 'PAUSE_CONTRACT', status: 'PENDING' }] })
    expect(failure(await post(pauseUrl, ADMIN, { reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'CHN_CONTRACT_ALREADY_PAUSED' })
    mockChain.settle()
    expect((await get<{ identity: WineryChainIdentity }>('/v1/organizations/current/chain-account', OWNER)).identity).toMatchObject({ status: 'PAUSED', contract: { paused: true } })
    await post(`/v1/platform/collections/${preventa.id}/pause`, OPS, { reason: 'Pausa comercial' })
    expect(failure(await post(`/v1/platform/collections/${preventa.id}/resume`, OPS))).toMatchObject({ status: 409, code: 'CHN_CONTRACT_PAUSED' })
    expect((await get<{ wineries: { symbol: string; paused: boolean }[] }>('/v1/public/chain/registry')).wineries.find((w) => w.symbol === 'CVJ')!.paused).toBe(true)
    await post(`/v1/platform/wineries/${CINTI}/chain/unpause`, ADMIN, { reason: 'Clave rotada' })
    mockChain.settle()
    expect(failure(await post(`/v1/platform/wineries/${CINTI}/chain/unpause`, ADMIN, { reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'CHN_CONTRACT_NOT_PAUSED' })
    expect((await post(`/v1/platform/collections/${preventa.id}/resume`, OPS)).status).toBe(200)
    // Una bodega sin activar no tiene identidad.
    const invited = F.wineries.find((w) => w.certificationStatus === 'INVITED')!
    expect((await get<{ identity: WineryChainIdentity }>(`/v1/platform/wineries/${invited.id}/chain-account`, SUPPORT)).identity).toMatchObject({ status: 'NOT_PROVISIONED', account: null, contract: null })
    expect((await call(`/v1/platform/wineries/${uid('no-existe')}/chain-account`, { token: SUPPORT })).status).toBe(404)
  })

  it('certificar un lote registra su anclaje: al confirmarse en la red pasa a ANCHORED', async () => {
    const ready = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'BOTTLED' && l.labStatus === 'CONFORMING')!
    const closed = await call<{ anchor: unknown }>(`/v1/lots/${ready.id}/dossier/close`, { token: OWNER, body: { confirm: true } })
    expect(dataOf(closed.json).anchor).toMatchObject({ status: 'PENDING', transaction: { kind: 'ANCHOR_DOSSIER', status: 'PENDING' } })
    expect((await get<Lot>(`/v1/lots/${ready.id}`, ENOLOGIST)).stage).toBe('CERTIFIED')
    expect(mockChain.settle()).toBe(3)
    expect((await get<Lot>(`/v1/lots/${ready.id}`, ENOLOGIST)).stage).toBe('ANCHORED')
    const account = await get<{ recentTransactions: { kind: string }[] }>('/v1/organizations/current/chain-account', OWNER)
    expect(account.recentTransactions[0]!.kind).toBe('ANCHOR_DOSSIER')
    expect(account.recentTransactions.length).toBeLessThanOrEqual(10)
  })
})

describe('cierre con faltante (§8.4), conciliación y alertas (§8.2)', () => {
  it('escenario faltante-botellas: 20 NFT sin botella; decide administración, se queman y el cierre queda resuelto', async () => {
    setScenario('faltante-botellas')
    const collection = (await get<Paged<Collection>>(`/v1/platform/collections?wineryId=${ALTOS}`, SUPPORT)).items.find((c) => c.name === 'Singani El Portillo 2025')!
    const url = `/v1/platform/collections/${collection.id}`
    const closure = LotClosureSchema.parse(await get(`${url}/closure`, SUPPORT))
    expect(closure).toMatchObject({ status: 'SHORTFALL_OPEN', bottles: 1040, minted: 1060, unsold: 1060, sold: 0, shortfall: SHORTFALL_SCENARIO_BOTTLES, unsoldToBurn: 20, soldWithoutBottle: 0, unsoldPolicy: null, decision: null })
    // Pierden su botella los no vendidos con el número más alto (S-23).
    expect(closure.items.map((i) => i.bottleNumber)).toEqual(Array.from({ length: 20 }, (_, i) => 1060 - i))
    expect((await get<Paged<LotClosure>>('/v1/platform/lot-closures?status=SHORTFALL_OPEN', SUPPORT)).items).toMatchObject([{ id: closure.id, shortfall: 20 }])
    expect((await get<Dashboard>('/v1/platform/dashboard', ADMIN)).tokenization.shortfallsOpen).toBe(1)
    expect(failure(await post(`${url}/close`, OPS, { reason: 'Fin de la venta' }))).toMatchObject({ status: 409, code: 'TOK_CLOSURE_PENDING', details: [{ meta: { closureStatus: 'SHORTFALL_OPEN' } }] })
    // La bodega lo ve en solo lectura y sin datos de pedidos.
    const mine = await get<LotClosure>(`/v1/collections/${collection.id}/closure`, ALTOS_OWNER)
    expect(mine.items[0]).not.toHaveProperty('orderId')
    expect((await call(`/v1/collections/${collection.id}/closure`, { token: as('altos_enologa') })).status).toBe(403)

    // Con quemas decide administración; operaciones no.
    expect(failure(await post(`${url}/closure/decide`, OPS, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Se queman los 20 sin botella' }))).toMatchObject({ status: 403, code: 'AUTH_INSUFFICIENT_PERMISSIONS' })
    const decided = dataOf((await post<LotClosure>(`${url}/closure/decide`, ADMIN, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Se queman los 20 sin botella' })).json)
    expect(decided).toMatchObject({ status: 'DECIDED', unsoldPolicy: 'KEEP_ON_SALE', decision: { by: { fullName: 'Jorge Salinas' } } })
    expect(decided.items.every((i) => i.outcome === 'BURN_UNSOLD' && i.burnTx?.kind === 'BURN_UNSOLD' && i.burnTx.status === 'PENDING')).toBe(true)
    expect(failure(await post(`${url}/closure/decide`, ADMIN, { unsoldPolicy: 'BURN', reason: 'Otra decisión' }))).toMatchObject({ status: 409 })
    mockChain.settle()
    const resolved = await get<LotClosure>(`${url}/closure`, SUPPORT)
    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.items.every((i) => i.status === 'BURNED' && i.burnTx?.status === 'CONFIRMED' && i.resolvedAt !== null)).toBe(true)
    const after = await get<Collection>(url, SUPPORT)
    expect(after.counts).toMatchObject({ minted: 1060, available: 1040, burned: 20 })
    const burned = await get<Paged<Token>>(`${url}/tokens?status=BURNED&limit=1`, SUPPORT)
    expect(burned.total).toBe(20)
    expect(burned.items[0]).toMatchObject({ burnReason: 'SHORTFALL', onchain: { owner: null, burned: true }, burnTx: { status: 'CONFIRMED' } })
    // Un token quemado sigue respondiendo sus metadatos, con su estado.
    expect((await get<{ properties: { status: string } }>(`/v1/public/nft/${after.winery.slug}/${burned.items[0]!.tokenId}`)).properties.status).toBe('BURNED')
    expect((await post(`${url}/close`, OPS, { reason: 'Fin de la venta' })).status).toBe(200)
  })

  it('sin faltante: operaciones decide conservar a la venta; un lote sin embotellar no tiene cierre', async () => {
    const closure = await get<LotClosure>(`/v1/platform/collections/${portillo.id}/closure`, SUPPORT)
    expect(closure).toMatchObject({ status: 'NO_SHORTFALL', bottles: 1040, minted: 240, shortfall: 0, items: [] })
    expect(dataOf((await post<LotClosure>(`/v1/platform/collections/${portillo.id}/closure/decide`, OPS, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Siguen a la venta' })).json)).toMatchObject({ status: 'NO_SHORTFALL', unsoldPolicy: 'KEEP_ON_SALE', decision: { by: { fullName: 'Valeria Méndez' }, reason: 'Siguen a la venta' } })
    // Quemar los no vendidos con botella es de administración.
    expect(failure(await post(`/v1/platform/collections/${granReserva.id}/closure/decide`, OPS, { unsoldPolicy: 'BURN', reason: 'Se retira la colección' }))).toMatchObject({ status: 403 })
    expect(failure(await call(`/v1/platform/collections/${preventa.id}/closure`, { token: SUPPORT }))).toMatchObject({ status: 409, code: 'TOK_CLOSURE_NOT_APPLICABLE', details: [{ meta: { stage: 'ORIGIN' } }] })
    expect(failure(await call(`/v1/collections/${preventa.id}/closure`, { token: OWNER }))).toMatchObject({ status: 409, code: 'TOK_CLOSURE_NOT_APPLICABLE' })
    expect(failure(await call(`/v1/platform/collections/${uid('no-existe')}`, { token: SUPPORT }))).toMatchObject({ status: 404, code: 'TOK_COLLECTION_NOT_FOUND' })
  })

  it('escenario alerta-evento-inesperado: alerta CRITICAL que se resuelve a mano; la conciliación nunca corrige datos', async () => {
    setScenario('alerta-evento-inesperado')
    const alerts = await get<Paged<{ id: string; code: string; level: string; wineryId: string; actual: { type: string } }>>('/v1/platform/chain/alerts?status=open&code=UNEXPECTED_EVENT', SUPPORT)
    expect(alerts.items).toMatchObject([{ code: 'UNEXPECTED_EVENT', level: 'CRITICAL', wineryId: CINTI, actual: { type: 'role_granted', role: 'minter' } }])
    const unmatched = await get<Paged<{ type: string; originatedBySystem: boolean; matchedTransactionId: null }>>('/v1/platform/chain/events?unmatched=true', SUPPORT)
    expect(unmatched.items).toMatchObject([{ type: 'role_granted', originatedBySystem: false, matchedTransactionId: null }])
    const url = `/v1/platform/chain/alerts/${alerts.items[0]!.id}/resolve`
    expect(failure(await post(url, SUPPORT, { note: 'Revisado' }))).toMatchObject({ status: 403 })
    expect(dataOf((await post<{ resolvedAt: string; resolution: unknown }>(url, OPS, { note: 'Rol revocado por la bodega' })).json)).toMatchObject({ resolution: { by: 'Valeria Méndez', note: 'Rol revocado por la bodega', auto: false } })
    expect(failure(await post(url, OPS, { note: 'Otra vez' }))).toMatchObject({ status: 409, code: 'CHN_ALERT_ALREADY_RESOLVED' })

    // Una diferencia provocada en la base: la conciliación la detecta y abre la alerta, sin tocar los datos.
    const tokens = getErpDb().chain.tokens
    tokens.splice(tokens.findLastIndex((t) => t.collectionId === preventa.id), 1)
    const started = await post<{ id: string; status: string; issuesOpened: number }>('/v1/platform/chain/reconciliation/runs', OPS, { scope: 'ALL', depth: 'FULL' })
    expect(started.status).toBe(202)
    expect(dataOf(started.json)).toMatchObject({ status: 'DIFFERENCES', issuesOpened: 1, trigger: 'MANUAL', depth: 'FULL' })
    const detail = await get<{ alerts: { code: string; expected: number; actual: number }[] }>(`/v1/platform/chain/reconciliation/runs/${dataOf(started.json).id}`, SUPPORT)
    expect(detail.alerts).toMatchObject([{ code: 'TOTAL_MINTED_MISMATCH', expected: 99, actual: 100 }])
    expect(getErpDb().chain.tokens.filter((t) => t.collectionId === preventa.id)).toHaveLength(99)
    expect(failure(await post('/v1/platform/chain/reconciliation/runs', OPS, { scope: 'COLLECTION' }))).toMatchObject({ status: 422, details: [{ field: 'subjectId' }] })
    expect(failure(await post('/v1/platform/chain/reconciliation/runs', SUPPORT, { scope: 'ALL' }))).toMatchObject({ status: 403 })
    expect((await get<Paged<unknown>>('/v1/platform/chain/reconciliation/runs', SUPPORT)).total).toBe(chainFixtures.reconciliationRuns.length + 1)
    // Las rutas de cadena son de la plataforma.
    expect((await call('/v1/platform/chain/transactions', { token: OWNER })).status).toBe(403)
    expect((await get<{ operations: { status: string; explorerUrl: string } }>('/v1/platform/chain/accounts', SUPPORT)).operations).toMatchObject({ status: 'OK' })
  })
})

describe('rutas públicas de la Ola 3, billetera legada y escenarios', () => {
  it('metadatos del NFT, registro, stellar.toml e imágenes', async () => {
    const res = await call(`/v1/public/nft/destileria-cinti-viejo/60`)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const metadata = PublicNftMetadataSchema.parse(dataOf(res.json))
    expect(metadata).toMatchObject({ name: 'Singani Preventa 2026 · Botella 1 de 100', image: preventa.coverImageUrl, properties: { lotReference: 'CVJ-L2026-006', lotCode: null, passportUrl: null, contract: preventa.contract.address } })
    expect(metadata.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Bodega', value: 'Destilería Cinti Viejo' }, { trait_type: 'Añada', value: 2026 }, { trait_type: 'Estado', value: 'Emitido' }]))
    expect(JSON.stringify(metadata)).not.toMatch(/Rosa Camargo|@/)
    // Con el lote embotellado, el enlace externo es su pasaporte.
    expect((await get<{ external_url: string }>('/v1/public/nft/destileria-cinti-viejo/0')).external_url).toMatch(/\/b\/CVJ-2026-SINGANI-004$/)
    for (const path of ['/v1/public/nft/destileria-cinti-viejo/9999', '/v1/public/nft/no-existe/0', '/v1/public/nft/destileria-cinti-viejo/abc']) {
      expect(failure(await call(path))).toMatchObject({ status: 404, code: 'PUB_TOKEN_NOT_FOUND' })
    }
    const toml = await fetch(`${API}/.well-known/stellar.toml`)
    expect(toml.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(toml.headers.get('access-control-allow-origin')).toBe('*')
    const text = await toml.text()
    expect(text).toContain('NETWORK_PASSPHRASE="Test SDF Network ; September 2015"')
    expect(text).toContain('ORG_NAME="Drinks on Chain"')
    for (const identity of chainFixtures.identities) expect(text).toContain(identity.account!.address)
    const image = await fetch(`${API}${preventa.coverImageUrl}`)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await image.arrayBuffer()).slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(failure(await call(`/v1/public/collections/images/${uid('no-existe')}`))).toMatchObject({ status: 404, code: 'FILE_NOT_FOUND' })
  })

  it('GET /v1/users/me/wallet: el personal → 404 CHN_WALLET_NOT_AVAILABLE; el consumidor, su dirección derivada', async () => {
    for (const token of [OWNER, OPS]) expect(failure(await call('/v1/users/me/wallet', { token }))).toMatchObject({ status: 404, code: 'CHN_WALLET_NOT_AVAILABLE' })
    const wallet = await get<{ stellarPublicAddress: string; walletType: string; walletPurpose: string }>('/v1/users/me/wallet', CONSUMER)
    expect(wallet).toMatchObject({ walletType: 'CUSTODIAL', walletPurpose: 'CONSUMER_NFT' })
    expect(isValidStrKey(wallet.stellarPublicAddress, 'G')).toBe(true)
    expect((await get<{ stellarPublicKey: string | null; onchainProducerId: null }>('/v1/wineries/my', OWNER)).onchainProducerId).toBeNull()
  })

  it('escenarios cambios-pedidos y emision-en-curso; los de la Ola 2 retiran el anclaje y la colección del caso', async () => {
    setScenario('cambios-pedidos')
    const status = await get<{ openRequest: { id: string; status: string }; collection: null; tokenizable: boolean }>(`/v1/lots/${PREVENTA_CASE.lotId}/tokenization`, OWNER)
    expect(status).toMatchObject({ openRequest: { status: 'CHANGES_REQUESTED' }, collection: null, tokenizable: false })
    const request = TokenizationRequestSchema.parse(await get(`/v1/tokenization-requests/${status.openRequest.id}`, OWNER))
    expect(request.changeRequests).toMatchObject([{ message: 'Falta la nota de cata para la ficha de la colección.', fields: ['commercial.tastingNotes'], resolvedAt: null }])
    expect((await post(`/v1/tokenization-requests/${request.id}/resubmit`, OWNER, { message: 'Listo' })).status).toBe(200)

    setScenario('emision-en-curso')
    const minting = (await get<Paged<Collection>>('/v1/collections?status=MINTING', OWNER)).items
    expect(minting).toMatchObject([{ name: PREVENTA_CASE.name, mintStatus: 'PENDING', pendingMintQuantity: 100 }])
    expect((await get<Paged<ChainTransaction>>('/v1/platform/chain/transactions?kind=MINT_BATCH&status=BUILDING', SUPPORT)).total).toBe(1)
    mockChain.settle()
    expect((await get<Collection>(`/v1/collections/${minting[0]!.id}`, OWNER)).status).toBe('READY')

    setScenario('lote-listo')
    expect(await get<Lot>(`/v1/lots/${SINGANI_CASE.lotId}`, ENOLOGIST)).toMatchObject({ stage: 'RESTING', tokenization: { state: 'NONE' } })
    expect((await get<Paged<Collection>>('/v1/collections', OWNER)).items.map((c) => c.name)).toEqual([PREVENTA_CASE.name])
    setScenario('normal')
    expect(await get<Lot>(`/v1/lots/${SINGANI_CASE.lotId}`, ENOLOGIST)).toMatchObject({ stage: 'ANCHORED', tokenization: { state: 'PUBLISHED', quota: 60 } })
  })
})

describe('BORRADOR del Marketplace (§13.1): cuenta del consumidor y compra con pasarela de prueba', () => {
  it('perfil con dirección informativa; pedido, pago aprobado, rechazado y reserva caducada', async () => {
    const profileRes = await call('/v1/me/consumer', { token: CONSUMER })
    expect(profileRes.headers.get('x-mock-draft')).toBe(MARKETPLACE_DRAFT_CONTRACT)
    const profile = ConsumerProfileSchema.parse(dataOf(profileRes.json))
    expect(profile).toMatchObject({ fullName: 'María Fernández', address: { network: 'TESTNET', custodial: true } })
    expect(profile.address!.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/account/${profile.address!.address}`)
    expect((await call('/v1/me/consumer', { token: OWNER })).status).toBe(403)
    expect((await call('/v1/me/consumer')).status).toBe(401)

    // El catálogo lleva el id que recibe el pedido; la preventa sin precio no se puede comprar.
    const catalog = await get<Paged<{ id: string; slug: string; saleState: string; counts: { available: number } }>>('/v1/public/collections')
    expect(catalog.items.find((c) => c.slug === 'singani-gran-reserva-2026')).toMatchObject({ id: granReserva.id, saleState: 'ON_SALE', counts: { available: 60 } })
    const order = (collectionId: string, quantity: number) => post('/v1/orders', CONSUMER, { collectionId, quantity })
    expect(failure(await order(preventa.id, 1))).toMatchObject({ status: 422, code: 'MKT_PRICE_UNDEFINED' })
    // Máximo por pedido (`compra.maxBotellasPorCompra` = 10) y colección agotada.
    expect(failure(await order(granReserva.id, 11))).toMatchObject({ status: 422, code: 'MKT_MAX_PER_ORDER', details: [{ field: 'quantity', rule: 'compra.maxBotellasPorCompra', expected: 10, actual: 11 }] })
    expect(failure(await order(catalog.items.find((c) => c.saleState === 'SOLD_OUT')!.id, 1))).toMatchObject({ status: 409, code: 'MKT_NOT_ENOUGH_STOCK' })
    expect(failure(await order(uid('no-existe'), 1))).toMatchObject({ status: 404, code: 'MKT_COLLECTION_NOT_FOUND' })
    expect((await post('/v1/orders', OWNER, { collectionId: granReserva.id, quantity: 1 })).status).toBe(403)

    const created = OrderSchema.parse(dataOf((await order(granReserva.id, 2)).json))
    expect(created).toMatchObject({ status: 'AWAITING_PAYMENT', quantity: 2, unitPrice: { amountMinor: 28000 }, total: { amountMinor: 56000, currency: 'BOB' }, payment: { provider: 'TEST', status: 'PENDING' }, tokens: [] })
    expect((await get<Collection>(`/v1/collections/${granReserva.id}`, OWNER)).counts).toMatchObject({ available: 58, reserved: 2 })
    // La pasarela demora: sigue esperando. Aprobado: «pago recibido» y los NFT del pedido.
    const simulate = (paymentId: string, outcome: string) => post(`/v1/payments/test/${paymentId}/simulate`, CONSUMER, { outcome })
    expect(dataOf((await simulate(created.payment.id, 'DELAY')).json)).toMatchObject({ status: 'AWAITING_PAYMENT' })
    const paid = OrderSchema.parse(dataOf((await simulate(created.payment.id, 'APPROVE')).json))
    expect(paid).toMatchObject({ status: 'PAID', reservedUntil: null, payment: { status: 'APPROVED' }, tokens: [{ bottleNumber: 1, transfer: null }, { bottleNumber: 2, transfer: null }] })
    expect(failure(await simulate(created.payment.id, 'APPROVE'))).toMatchObject({ status: 409, code: 'MKT_PAYMENT_NOT_PENDING' })
    // El lote ya está anclado: lo vendido es canjeable desde la entrega, a nombre del consumidor.
    const sold = await get<Paged<Token>>(`/v1/collections/${granReserva.id}/tokens?status=REDEEMABLE`, OWNER)
    expect(sold.items.map((t) => [t.bottleNumber, t.owner.kind, t.owner.address])).toEqual([[1, 'CONSUMER', profile.address!.address], [2, 'CONSUMER', profile.address!.address]])

    // Rechazado: se devuelve al inventario. Sin pagar: caduca con el reloj de los mocks.
    const second = OrderSchema.parse(dataOf((await order(granReserva.id, 3)).json))
    expect(dataOf((await simulate(second.payment.id, 'REJECT')).json)).toMatchObject({ status: 'PAYMENT_FAILED', payment: { status: 'REJECTED' }, tokens: [] })
    const third = OrderSchema.parse(dataOf((await order(granReserva.id, 5)).json))
    advanceMockClock(60 * 60_000)
    expect(await get(`/v1/orders/${third.id}`, CONSUMER)).toMatchObject({ status: 'EXPIRED', reservedUntil: null })
    expect((await get<Collection>(`/v1/collections/${granReserva.id}`, OWNER)).counts).toMatchObject({ available: 58, reserved: 0, redeemable: 2 })
    const mine = await get<Paged<{ status: string }>>('/v1/orders', CONSUMER)
    // Delante de los pedidos sembrados de la cuenta de demostración (rc.2).
    expect(mine.items.map((o) => o.status)).toEqual(['EXPIRED', 'PAYMENT_FAILED', 'PAID', 'EXPIRED', 'PAYMENT_FAILED', 'PAID', 'PAID'])
    expect((await get<Paged<unknown>>('/v1/orders', as('carlos'))).total).toBe(0)
    expect(failure(await call(`/v1/orders/${created.id}`, { token: as('carlos') }))).toMatchObject({ status: 404, code: 'MKT_ORDER_NOT_FOUND' })
    // Con ventas, el precio de la colección queda bloqueado.
    expect(failure(await post(`/v1/platform/collections/${granReserva.id}`, OPS, { price: { amountMinor: 30000, currency: 'BOB' }, reason: 'Subida' }, 'PATCH'))).toMatchObject({ status: 409, code: 'TOK_PRICE_LOCKED' })
  })
})
