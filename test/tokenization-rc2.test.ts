import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ChainAlertSchema,
  CollectionSchema,
  ConsumerProfileSchema,
  ConsumerSignupAcceptedSchema,
  LotClosureSchema,
  MintSchema,
  OrderSchema,
  PublicChainRegistrySchema,
  PublicDossierVerificationSchema,
  PurchaseSettingsSchema,
  ReconciliationRunSchema,
  sha256Hex,
  TOKENIZATION_MAIL_TEMPLATES,
  WineryChainAccountViewSchema,
  type ApiErrorDetail,
  type ChainAlert,
  type ChainTransaction,
  type Collection,
  type Dashboard,
  type Envelope,
  type LotClosure,
  type Paged,
  type PlatformChainAccounts,
  type TokenizationApproval,
  type WineryChainIdentity,
} from '../src'
import { chainFixtures, erpFixtures as F, PREVENTA_CASE, SAME_SLUG_CASE, SINGANI_CASE, tokenizationFixtures as T } from '../src/fixtures'
import {
  advanceMockClock,
  DATA_SCENARIOS,
  getErpDb,
  MARKETPLACE_DEMO_ACCOUNT,
  MARKETPLACE_DRAFT_CONTRACT,
  mockChain,
  mockMailbox,
  mockTokenization,
  resetScenario,
  setScenario,
  SHORTFALL_SCENARIO_BOTTLES,
  SHORTFALL_SCENARIO_UNSOLD,
} from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf } from './helpers'

// Ola 3, mocks 0.6.0-rc.2: precisiones del backend con los pasos 3.1–3.5 implementados (`slug` por
// bodega, `CHN_DISABLED`, `CHN_WINERY_NOT_ACTIVE`, alertas `MINT_RANGE_MISMATCH` y `ANCHOR_MISMATCH`,
// verificación pública) y los pedidos del ERP, el Backoffice y el Marketplace.

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
const ALTOS_OWNER = as('altos_admin')
const OPS = as('operaciones')
const ADMIN = as('bo_admin')
const SUPPORT = as('soporte')
const CONSUMER = as(MARKETPLACE_DEMO_ACCOUNT.key)

const CINTI = SINGANI_CASE.wineryId
const ALTOS = SAME_SLUG_CASE.wineryId
const lotNamed = (name: string, wineryId = CINTI) => F.lots.find((l) => l.name === name && l.wineryId === wineryId)!
const origin = lotNamed('Singani Edición Aniversario 2026')
const collectionOf = (name: string, wineryId = CINTI) => T.collections.find((c) => c.name === name && c.wineryId === wineryId)!
const preventa = collectionOf(PREVENTA_CASE.name)
const altosPreventa = collectionOf(SAME_SLUG_CASE.name, ALTOS)
const granReserva = collectionOf(SINGANI_CASE.name)
const requestOf = (lotName: string, status: string) => T.requests.find((r) => r.lot.name === lotName && r.status === status)!
const CASE_CODE = F.lots.find((l) => l.id === SINGANI_CASE.lotId)!.lotCode!

let keySeq = 0
const post = <D = unknown>(path: string, token: string | null, body: unknown = {}, method = 'POST') => call<D>(path, { method, token, body, headers: { 'Idempotency-Key': uid(`rc2-test:${++keySeq}`) } })
const get = async <D>(path: string, token?: string) => dataOf((await call<D>(path, { token })).json)
function failure(res: { status: number; json: Envelope<unknown> }) {
  if (res.json.success) throw new Error(`Se esperaba un error y llegó ${res.status}`)
  return { status: res.status, code: res.json.error.code, details: (res.json.error.details ?? []) as ApiErrorDetail[] }
}
const COVER = (wineryId: string) => ({ key: `org/${wineryId}/collections/2026/portada.jpg`, alt: 'Botella de la colección', isCover: true })
const alerts = async (query: string) => (await get<Paged<ChainAlert>>(`/v1/platform/chain/alerts?${query}`, SUPPORT)).items.map((a) => ChainAlertSchema.parse(a))
const reconcile = async (body: unknown = { scope: 'ALL', depth: 'FULL' }) => ReconciliationRunSchema.parse(dataOf((await post('/v1/platform/chain/reconciliation/runs', OPS, body)).json))
const mails = (to: string) => mockMailbox.list({ to }).filter((m) => (TOKENIZATION_MAIL_TEMPLATES as readonly string[]).includes(m.template))

describe('precisiones del backend (pasos 3.1–3.5)', () => {
  it('el `slug` de una colección es único por bodega: dos bodegas lo comparten y `external_url` lleva el de la bodega', async () => {
    expect(altosPreventa.slug).toBe(preventa.slug)
    expect(altosPreventa.wineryId).not.toBe(preventa.wineryId)
    // Antes `{MKT}/colecciones/{slug}`; ahora `{MKT}/colecciones/{slugBodega}/{slug}` (sin pasaporte todavía).
    const urlOf = async (c: Collection) => (await get<{ external_url: string }>(`/v1/public/nft/${c.winery.slug}/${T.tokens.find((t) => t.collectionId === c.id)!.tokenId}`)).external_url
    expect(await urlOf(preventa)).toBe('http://localhost:3005/colecciones/destileria-cinti-viejo/singani-preventa-2026')
    expect(await urlOf(altosPreventa)).toBe('http://localhost:3005/colecciones/altos-de-calamuchita/singani-preventa-2026')
    expect(await urlOf(granReserva)).toBe(`http://localhost:3005/b/${CASE_CODE}`)

    // Mismo nombre en la **misma** bodega → 409 `TOK_SLUG_TAKEN`.
    const same = dataOf((await post<{ id: string }>(`/v1/lots/${origin.id}/tokenization-requests`, OWNER, { quantity: 10, commercial: { name: PREVENTA_CASE.name, description: 'Otra colección con el mismo nombre.', imageKeys: [COVER(CINTI)] }, confirm: true })).json)
    await post(`/v1/platform/tokenization-requests/${same.id}/take`, OPS)
    expect(failure(await post(`/v1/platform/tokenization-requests/${same.id}/approve`, OPS))).toMatchObject({ status: 409, code: 'TOK_SLUG_TAKEN', details: [{ field: 'commercial.name', meta: { slug: 'singani-preventa-2026' } }] })
    // En **otra** bodega sí: Altos aprueba una «Singani Gran Reserva 2026» (el nombre de una de Cinti Viejo).
    const pending = requestOf('Tannat La Angostura 2024', 'CHANGES_REQUESTED')
    mockTokenization.resubmitAsWinery(pending.id, { commercial: { name: SINGANI_CASE.name, imageKeys: [COVER(ALTOS)] } })
    await post(`/v1/platform/tokenization-requests/${pending.id}/take`, OPS)
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${pending.id}/approve`, OPS)).json)
    expect(approved.collection).toMatchObject({ slug: granReserva.slug, wineryId: ALTOS, status: 'MINTING' })
    expect((await get<Paged<Collection>>(`/v1/platform/collections?q=${granReserva.slug}`, SUPPORT)).items.map((c) => c.winery.slug).sort()).toEqual(['altos-de-calamuchita', 'destileria-cinti-viejo'])
  })

  it('aprobar devuelve la emisión con sus `MINT_BATCH` ya registradas; en cada escenario, emisión y transacciones cuadran', async () => {
    const inReview = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${inReview.id}/approve`, OPS)).json)
    const mint = MintSchema.parse(approved.mint)
    expect(mint).toMatchObject({ status: 'PENDING', quantity: 400, ranges: [] })
    expect(mint.transactions).toMatchObject([{ kind: 'MINT_BATCH', status: 'PENDING', txHash: null, attempts: 0 }])
    expect(approved.collection.mints[0]!.transactions.map((t) => t.id)).toEqual(mint.transactions.map((t) => t.id))
    const listed = await get<Paged<{ id: string; kind: string; status: string }>>(`/v1/platform/collections/${approved.collection.id}/transactions`, SUPPORT)
    expect(listed.items.map((t) => [t.id, t.kind, t.status])).toEqual([[mint.transactions[0]!.id, 'MINT_BATCH', 'PENDING']])

    // Coherencia (pedido del Backoffice): una emisión `CONFIRMED` tiene todas sus transacciones `CONFIRMED`,
    // y toda `MINT_BATCH` que no lo esté pertenece a una emisión que tampoco lo está. La lista de
    // transacciones de la colección es la unión de las de **todas** sus emisiones (más las quemas):
    // con una ampliación en curso conviven la inicial confirmada y la `MINT_BATCH` nueva en vuelo.
    for (const scenario of ['normal', ...DATA_SCENARIOS] as const) {
      resetErpDb()
      setScenario(scenario)
      for (let round = 0; round < 2; round++) {
        const collections = (await get<Paged<Collection>>('/v1/platform/collections?limit=100', SUPPORT)).items
        for (const summary of collections) {
          const c = CollectionSchema.parse(await get(`/v1/platform/collections/${summary.id}`, SUPPORT))
          const txs = (await get<Paged<{ id: string; kind: string; status: string }>>(`/v1/platform/collections/${c.id}/transactions?limit=100`, SUPPORT)).items
          const label = `${scenario} · ${c.name}`
          for (const m of c.mints) {
            if (m.status === 'CONFIRMED') expect(m.transactions.map((t) => t.status), label).toEqual(m.transactions.map(() => 'CONFIRMED'))
            for (const t of m.transactions) expect(txs.find((x) => x.id === t.id), label).toMatchObject({ kind: 'MINT_BATCH', status: t.status })
          }
          const ofMints = new Set(c.mints.flatMap((m) => m.transactions.map((t) => t.id)))
          expect(txs.filter((t) => t.kind === 'MINT_BATCH').every((t) => ofMints.has(t.id)), label).toBe(true)
          expect(c.mintStatus, label).toBe(c.mints.at(-1)!.status)
        }
        mockChain.settle()
      }
    }
  })

  it('`CHN_DISABLED`: con la cadena sin configurar, provision, pause y unpause → 409 y el registro sale vacío', async () => {
    setScenario('cadena-sin-configurar')
    await get('/v1/platform/chain/accounts', SUPPORT)
    expect(mockChain.isEnabled()).toBe(false)
    expect(failure(await post(`/v1/platform/wineries/${ALTOS}/chain/provision`, OPS, { reason: 'Reintento' }))).toMatchObject({ status: 409, code: 'CHN_DISABLED' })
    expect(failure(await post(`/v1/platform/wineries/${CINTI}/chain/pause`, ADMIN, { reason: 'Incidente' }))).toMatchObject({ status: 409, code: 'CHN_DISABLED' })
    expect(failure(await post(`/v1/platform/wineries/${CINTI}/chain/unpause`, ADMIN, { reason: 'Incidente' }))).toMatchObject({ status: 409, code: 'CHN_DISABLED' })
    const registry = PublicChainRegistrySchema.parse(await get('/v1/public/chain/registry'))
    expect(registry).toMatchObject({ platform: { operationsAccount: null, anchorAccount: null }, wineries: [] })
    expect(await (await fetch(`${API}/.well-known/stellar.toml`)).text()).not.toMatch(/"G[A-Z2-7]{55}"/)
    // Activada la cadena, operaciones aprovisiona a la bodega que quedó sin identidad.
    mockChain.setEnabled(true)
    expect((await post(`/v1/platform/wineries/${ALTOS}/chain/provision`, OPS, { reason: 'Cadena configurada' })).status).toBe(202)
    mockChain.settle()
    expect((await get<{ identity: WineryChainIdentity }>(`/v1/platform/wineries/${ALTOS}/chain-account`, SUPPORT)).identity.status).toBe('ACTIVE')
    // `stellar.toml` ya no publica los contratos (`[[CURRENCIES]]`, S-7): su fuente es el registro.
    resetErpDb()
    resetScenario()
    expect(await (await fetch(`${API}/.well-known/stellar.toml`)).text()).not.toContain('[[CURRENCIES]]')
    expect((await get<{ wineries: unknown[] }>('/v1/public/chain/registry')).wineries).toHaveLength(3)
  })

  it('`CHN_WINERY_NOT_ACTIVE`: con la bodega suspendida la emisión espera en PENDING (como `CHN_MINT_DISABLED`) y continúa al reactivarla', async () => {
    const inReview = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${inReview.id}/approve`, OPS)).json)
    const txId = approved.mint.transactions[0]!.id
    expect((await post(`/v1/platform/wineries/${CINTI}/suspend`, OPS, { reason: 'Documentación pendiente' })).status).toBe(200)
    mockChain.settle()
    const held = await get<ChainTransaction>(`/v1/platform/chain/transactions/${txId}`, SUPPORT)
    expect(held).toMatchObject({ status: 'PENDING', txHash: null, lastError: { code: 'CHN_WINERY_NOT_ACTIVE', retryable: true } })
    expect(mockChain.pending().map((t) => t.id)).toContain(txId)
    // Espera: no falla ni abre alerta, y no se puede «reintentar» (no está `FAILED`).
    expect(await alerts('status=open&code=TX_FAILED')).toEqual([])
    expect(failure(await post(`/v1/platform/chain/transactions/${txId}/retry`, OPS, { reason: 'Probar' }))).toMatchObject({ status: 409, code: 'CHN_TX_NOT_RETRYABLE' })
    expect((await get<Collection>(`/v1/platform/collections/${approved.collection.id}`, SUPPORT)).mintStatus).toBe('PENDING')
    expect((await post(`/v1/platform/wineries/${CINTI}/reactivate`, OPS, { reason: 'Regularizada' })).status).toBe(200)
    mockChain.settle()
    expect(await get<ChainTransaction>(`/v1/platform/chain/transactions/${txId}`, SUPPORT)).toMatchObject({ status: 'CONFIRMED', lastError: null })
    expect((await get<Collection>(`/v1/platform/collections/${approved.collection.id}`, SUPPORT)).counts.minted).toBe(400)
  })

  it('alertas `MINT_RANGE_MISMATCH` y `ANCHOR_MISMATCH`: lo confirmado en la red que no cuadra no se da por bueno', async () => {
    mockChain.mismatchNext('MINT_BATCH')
    const inReview = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${inReview.id}/approve`, OPS, { publishOnMint: true })).json)
    mockChain.settle()
    const collection = await get<Collection>(`/v1/platform/collections/${approved.collection.id}`, SUPPORT)
    // La transacción está confirmada, pero la emisión queda `FAILED`: sin NFT y sin publicar.
    expect(collection).toMatchObject({ status: 'MINTING', mintStatus: 'FAILED', counts: { minted: 0 } })
    expect(collection.mints[0]).toMatchObject({ status: 'FAILED', ranges: [], transactions: [{ status: 'CONFIRMED' }] })
    expect(await alerts('status=open&code=MINT_RANGE_MISMATCH')).toMatchObject([{ level: 'CRITICAL', subject: { type: 'MINT', id: approved.mint.id }, wineryId: CINTI, expected: { amount: 400, lot: 'CVJ-L2026-004' }, actual: { event: null } }])
    expect((await get<Dashboard>('/v1/platform/dashboard', ADMIN)).tokenization.mintFailures).toBe(1)
    // Las alertas críticas llegan por correo a operaciones.
    expect(mockMailbox.latest({ to: 'operaciones@drinksonchain.test', template: 'CHAIN_ALERT_CRITICAL' })).toMatchObject({ subject: 'Alerta crítica de la cadena: MINT_RANGE_MISMATCH', link: 'http://localhost:3003/cadena/alertas' })

    // Anclaje: el lote sigue `CERTIFIED`; en privado `FAILED`, en público `PENDING` y sin transacción (S-17).
    setScenario('anclaje-pendiente')
    await get('/v1/platform/chain/accounts', SUPPORT)
    mockChain.mismatchNext('ANCHOR_DOSSIER')
    mockChain.settle()
    expect(await alerts('status=open&code=ANCHOR_MISMATCH')).toMatchObject([{ level: 'CRITICAL', subject: { type: 'LOT', id: SINGANI_CASE.lotId }, expected: { memoHashHex: expect.stringMatching(/^[0-9a-f]{64}$/) } }])
    expect(await get<{ stage: string }>(`/v1/lots/${SINGANI_CASE.lotId}`, OWNER)).toMatchObject({ stage: 'CERTIFIED' })
    expect((await get<{ anchor: { status: string; verifiedAt: string | null } }>(`/v1/lots/${SINGANI_CASE.lotId}/dossier`, OWNER)).anchor).toMatchObject({ status: 'FAILED', verifiedAt: null })
    const verification = PublicDossierVerificationSchema.parse(await get(`/v1/public/lots/${CASE_CODE}/verification`))
    expect(verification.anchor).toMatchObject({ status: 'PENDING', txHash: null, explorerUrl: null })
    expect(verification.checks.map((c) => [c.key, c.pass])).toEqual([['DOSSIER_CLOSED', true], ['ANCHOR_CONFIRMED', false], ['MEMO_MATCHES_HASH', null], ['ANCHOR_ACCOUNT_OFFICIAL', null]])
  })

  it('verificación pública: ya no es 501; 429 con `Retry-After`; escenarios «huella alterada» y «verificación 404»', async () => {
    const url = `/v1/public/lots/${CASE_CODE}/verification`
    const ok = await call(url)
    expect(ok.status).toBe(200)
    const verification = PublicDossierVerificationSchema.parse(dataOf(ok.json))
    expect(verification.checks.every((c) => c.pass === true)).toBe(true)
    const bytes = async () => (await fetch(`${API}/v1/public/lots/${CASE_CODE}/dossier`)).text()
    expect(sha256Hex(await bytes())).toBe(verification.dossier.hash)
    expect(verification.anchor!.memoHashHex).toBe(verification.dossier.hash)

    // Huella alterada: el servidor sigue diciendo que el anclaje es bueno, pero los bytes que se
    // descargan ya no dan la huella anclada: el visor, que la recalcula, debe avisar.
    setScenario('huella-alterada')
    const altered = await bytes()
    expect(() => JSON.parse(altered) as unknown).not.toThrow()
    expect(sha256Hex(altered)).not.toBe(verification.dossier.hash)
    expect(PublicDossierVerificationSchema.parse(await get(url)).anchor!.memoHashHex).toBe(verification.dossier.hash)

    // Verificación 404 con el pasaporte disponible; no cuenta para el freno a la enumeración.
    setScenario('verificacion-no-encontrada')
    for (let i = 0; i < 25; i++) expect(failure(await call(url))).toMatchObject({ status: 404, code: 'PUB_CODE_NOT_FOUND' })
    expect((await call(`/v1/public/lots/${CASE_CODE}`)).status).toBe(200)

    setScenario('pasaporte-saturado')
    const limited = await call(url)
    expect(failure(limited)).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('`ChainAlert.subject.type` es texto libre: los mocks usan los tipos del backend y exportan la lista orientativa', async () => {
    mockChain.setCodeTtlDays(5)
    mockChain.indexerGap()
    await reconcile()
    const open = await alerts('status=open&limit=100')
    expect(open.map((a) => `${a.code}:${a.subject.type}:${a.subject.id.length > 12 ? '…' : a.subject.id}`).sort()).toEqual(['TTL_EXPIRING:CONTRACT:…', 'TTL_EXPIRING:PLATFORM:WASM'])
    const resolved = await alerts('status=resolved&limit=100')
    expect(resolved.map((a) => `${a.code}:${a.subject.type}`)).toEqual(expect.arrayContaining(['INDEXER_GAP:PLATFORM', 'LOW_BALANCE:PLATFORM_ACCOUNT', 'TTL_EXPIRING:CONTRACT']))
  })
})

describe('Backoffice: cierre con NFT vendidos sin botella, reenvío de la bodega y conciliación', () => {
  it('escenario faltante-vendidos: se queman los no vendidos y los vendidos sin botella se resuelven ítem a ítem', async () => {
    setScenario('faltante-vendidos')
    const collection = (await get<Paged<Collection>>(`/v1/platform/collections?wineryId=${ALTOS}`, SUPPORT)).items.find((c) => c.name === 'Singani El Portillo 2025')!
    const url = `/v1/platform/collections/${collection.id}`
    const closure = LotClosureSchema.parse(await get(`${url}/closure`, SUPPORT))
    const sold = 1060 - SHORTFALL_SCENARIO_UNSOLD
    expect(closure).toMatchObject({ status: 'SHORTFALL_OPEN', bottles: 1040, minted: 1060, sold, unsold: SHORTFALL_SCENARIO_UNSOLD, shortfall: SHORTFALL_SCENARIO_BOTTLES, unsoldToBurn: 10, soldWithoutBottle: 10 })
    expect(collection.counts).toMatchObject({ minted: 1060, available: 10, sold })
    // Primero los no vendidos (los números más altos); después los vendidos, del pago más reciente al más antiguo (A-30).
    const unsoldItems = closure.items.filter((i) => i.status === 'MINTED')
    const soldItems = closure.items.filter((i) => i.status === 'SOLD')
    expect(unsoldItems.map((i) => i.bottleNumber)).toEqual(Array.from({ length: 10 }, (_, i) => 1060 - i))
    expect(soldItems.map((i) => i.bottleNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => 1041 + i))
    expect(soldItems.every((i) => i.orderId !== null && i.paidAt !== null && i.outcome === 'PENDING')).toBe(true)
    expect(soldItems.map((i) => i.paidAt)).toEqual([...soldItems.map((i) => i.paidAt)].sort().reverse())
    expect(new Set(soldItems.map((i) => i.orderId)).size).toBe(5)
    // La bodega no ve los datos de los pedidos.
    const mine = await get<LotClosure>(`/v1/collections/${collection.id}/closure`, ALTOS_OWNER)
    expect(mine.items.find((i) => i.status === 'SOLD')).not.toHaveProperty('orderId')
    expect(mine.items.find((i) => i.status === 'SOLD')).not.toHaveProperty('paidAt')

    // Un vendido no se resuelve antes de decidir… ni se quema: decide administración.
    const first = soldItems[0]!
    const resolve = (tokenId: number, body: unknown, token = OPS) => post<LotClosure>(`${url}/closure/items/${tokenId}/resolve`, token, body)
    expect(failure(await resolve(unsoldItems[0]!.tokenId, { outcome: 'MANUAL_REFUND', note: 'No aplica' }))).toMatchObject({ status: 409 })
    const decided = dataOf((await post<LotClosure>(`${url}/closure/decide`, ADMIN, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Se queman los 10 sin vender; los vendidos se atienden uno a uno' })).json)
    expect(decided.status).toBe('DECIDED')
    expect(decided.items.filter((i) => i.outcome === 'BURN_UNSOLD')).toHaveLength(10)
    expect(decided.items.filter((i) => i.outcome === 'PENDING').map((i) => i.status)).toEqual(Array.from({ length: 10 }, () => 'SOLD'))
    mockChain.settle()
    // Quemados los no vendidos, el cierre sigue `DECIDED` hasta resolver el último vendido.
    expect((await get<LotClosure>(`${url}/closure`, SUPPORT)).status).toBe('DECIDED')
    expect(failure(await post(`${url}/close`, OPS, { reason: 'Fin de la venta' }))).toMatchObject({ status: 409, code: 'TOK_CLOSURE_PENDING' })
    expect(failure(await resolve(first.tokenId, { outcome: 'MANUAL_REFUND' }))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' })
    expect((await resolve(first.tokenId, { outcome: 'MANUAL_REFUND', note: 'Devolución por transferencia' }, SUPPORT)).status).toBe(403)
    const one = dataOf((await resolve(first.tokenId, { outcome: 'MANUAL_REFUND', note: 'Devolución por transferencia bancaria' })).json)
    expect(one.status).toBe('DECIDED')
    expect(one.items.find((i) => i.tokenId === first.tokenId)).toMatchObject({ outcome: 'MANUAL_REFUND', note: 'Devolución por transferencia bancaria', status: 'SOLD', burnTx: null })
    expect(failure(await resolve(first.tokenId, { outcome: 'MANUAL_SUBSTITUTE', note: 'Otra vez' }))).toMatchObject({ status: 409 })
    let last: LotClosure = one
    for (const item of soldItems.slice(1)) last = dataOf((await resolve(item.tokenId, { outcome: 'MANUAL_SUBSTITUTE', note: 'Botella de la añada siguiente' })).json)
    expect(last.status).toBe('RESOLVED')
    expect(last.items.every((i) => i.resolvedAt !== null)).toBe(true)
    const after = await get<Collection>(url, SUPPORT)
    // Los NFT vendidos siguen vivos (A-30): solo se quemaron los no vendidos.
    expect(after.counts).toMatchObject({ minted: 1060, burned: 10, sold, available: 0 })
    expect((await post(`${url}/close`, OPS, { reason: 'Fin de la venta' })).status).toBe(200)
  })

  it('mockTokenization.resubmitAsWinery: la bodega atiende los cambios pedidos y la solicitud vuelve a la bandeja', async () => {
    const inReview = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    await post(`/v1/platform/tokenization-requests/${inReview.id}/request-changes`, OPS, { message: 'Falta el maridaje y otra foto.', fields: ['commercial.pairing', 'commercial.imageKeys'] })
    expect((await get<Paged<{ id: string }>>('/v1/platform/tokenization-requests?status=SUBMITTED', SUPPORT)).items.map((r) => r.id)).not.toContain(inReview.id)
    // Sin indicar nada, completa lo que pidió operaciones.
    const resubmitted = mockTokenization.resubmitAsWinery(inReview.id)
    expect(resubmitted).toMatchObject({ status: 'SUBMITTED', assignee: null, submittedBy: { fullName: 'Rosa Camargo' } })
    expect(resubmitted.commercialDraft.pairing).toBeTruthy()
    expect(resubmitted.commercialDraft.imageKeys).toHaveLength(1)
    expect(resubmitted.changeRequests.at(-1)!.resolvedAt).not.toBeNull()
    expect(resubmitted.history.at(-1)).toMatchObject({ status: 'SUBMITTED', by: 'Rosa Camargo', note: 'Atendidos los cambios pedidos.' })
    expect((await get<Paged<{ id: string }>>('/v1/platform/tokenization-requests?status=SUBMITTED', SUPPORT)).items.map((r) => r.id)).toContain(inReview.id)
    // Queda en la bitácora y avisa a operaciones.
    const audit = await get<Paged<{ action: string; actor: { fullName: string } }>>(`/v1/platform/audit?action=TOKENIZATION_RESUBMITTED`, ADMIN)
    expect(audit.items[0]).toMatchObject({ action: 'TOKENIZATION_RESUBMITTED', actor: { fullName: 'Rosa Camargo' } })
    expect(mockMailbox.latest({ to: 'operaciones@drinksonchain.test', template: 'TOKENIZATION_REQUEST_FOR_OPERATIONS' })?.subject).toBe('Solicitud de tokenización reenviada: Destilería Cinti Viejo')
    // Con datos propios y otra cantidad; fuera de `CHANGES_REQUESTED` → 409.
    await post(`/v1/platform/tokenization-requests/${inReview.id}/take`, OPS)
    await post(`/v1/platform/tokenization-requests/${inReview.id}/request-changes`, OPS, { message: 'Baja la cantidad.' })
    expect(mockTokenization.resubmitAsWinery(inReview.id, { quantity: 300, commercial: { tastingNotes: 'Nota nueva.' }, message: 'Ahora 300.' })).toMatchObject({ status: 'SUBMITTED', quantity: 300, commercialDraft: { tastingNotes: 'Nota nueva.' } })
    expect(() => mockTokenization.resubmitAsWinery(inReview.id)).toThrowError(/SUBMITTED/)
    // También puede enviar una solicitud nueva o retirarla.
    const created = mockTokenization.submitAsWinery(origin.id, { quantity: 50, commercial: { name: 'Edición Aniversario', description: 'Edición limitada por el aniversario de la destilería.', imageKeys: [COVER(CINTI)] } })
    expect(created).toMatchObject({ status: 'SUBMITTED', kind: 'INITIAL', quantity: 50 })
    expect(mockTokenization.withdrawAsWinery(created.id)).toMatchObject({ status: 'WITHDRAWN' })
  })

  it('conciliación: una ejecución abre alertas y otra las cierra sola; indexador con retraso; `codeTtlDays` baja con el reloj', async () => {
    const accounts = () => get<PlatformChainAccounts>('/v1/platform/chain/accounts', SUPPORT)
    const board = async () => (await get<Dashboard>('/v1/platform/dashboard', ADMIN)).chain
    expect((await accounts()).codeTtlDays).toBe(96)
    expect((await board()).indexerLagSeconds).toBe(12)

    // La red «dice» otra cosa que la base: un NFT cambió de dueño, un contrato aparece pausado y un rol de más.
    const token = T.tokens.find((t) => t.collectionId === preventa.id)!
    mockChain.drift({ kind: 'OWNER', wineryId: CINTI, tokenId: token.tokenId })
    mockChain.drift({ kind: 'PAUSE', wineryId: ALTOS, paused: true })
    mockChain.drift({ kind: 'ROLE', wineryId: ALTOS })
    // La conciliación ligera no lee cada NFT ni cada contrato.
    expect(await reconcile({ scope: 'ALL', depth: 'LIGHT' })).toMatchObject({ status: 'OK', issuesOpened: 0 })
    const run = await reconcile()
    expect(run).toMatchObject({ status: 'DIFFERENCES', issuesOpened: 3, issuesAutoResolved: 0, depth: 'FULL', trigger: 'MANUAL' })
    const detail = await get<{ alerts: ChainAlert[] }>(`/v1/platform/chain/reconciliation/runs/${run.id}`, SUPPORT)
    expect(detail.alerts.map((a) => [a.code, a.level, a.subject.type]).sort()).toEqual([
      ['OWNER_MISMATCH', 'CRITICAL', 'COLLECTION'],
      ['PAUSE_MISMATCH', 'CRITICAL', 'CONTRACT'],
      ['ROLE_MISMATCH', 'CRITICAL', 'CONTRACT'],
    ])
    expect(detail.alerts.find((a) => a.code === 'OWNER_MISMATCH')).toMatchObject({ subject: { id: preventa.id }, expected: { tokenId: token.tokenId, owner: token.owner.address }, actual: { tokens: 1 } })
    // Nunca corrige datos: el NFT sigue a nombre de la bodega en la base.
    expect((await get<Paged<{ owner: { address: string }; onchain: { owner: string } }>>(`/v1/platform/collections/${preventa.id}/tokens?limit=1`, SUPPORT)).items[0]).toMatchObject({ owner: { address: token.owner.address }, onchain: { owner: expect.not.stringMatching(token.owner.address) } })
    expect((await get<Paged<{ type: string }>>('/v1/platform/chain/events?unmatched=true', SUPPORT)).items.map((e) => e.type).sort()).toEqual(['paused', 'role_granted', 'transfer'])
    expect((await board()).openAlerts).toMatchObject({ critical: 3 })
    // Solo el alcance pedido: conciliar la colección no cierra las alertas de los contratos.
    mockChain.clearDrift()
    expect(await reconcile({ scope: 'COLLECTION', subjectId: preventa.id, depth: 'FULL' })).toMatchObject({ status: 'OK', issuesOpened: 0, issuesAutoResolved: 1 })
    const closed = await reconcile()
    expect(closed).toMatchObject({ status: 'OK', issuesOpened: 0, issuesAutoResolved: 2 })
    expect((await alerts('status=resolved&code=PAUSE_MISMATCH'))[0]).toMatchObject({ resolvedAt: closed.finishedAt, resolution: { by: 'Sistema', auto: true } })
    expect((await board()).openAlerts).toMatchObject({ critical: 0 })

    // Indexador: se queda atrás → alerta y retraso visible; la conciliación lo pone al día.
    const gap = mockChain.indexerGap(300)
    expect(gap).toMatchObject({ code: 'INDEXER_GAP', level: 'WARNING', subject: { type: 'PLATFORM', id: 'INDEXER' } })
    expect((await board()).indexerLagSeconds).toBe(1500)
    expect(await reconcile({ scope: 'ALL' })).toMatchObject({ issuesAutoResolved: 1 })
    expect((await board()).indexerLagSeconds).toBe(12)

    // Vida del código: baja con el reloj; por debajo de 14 días la conciliación completa avisa (crítica)
    // y, al confirmarse la extensión (`EXTEND_TTL`), se cierra sola.
    advanceMockClock(85 * 86_400_000)
    expect((await accounts()).codeTtlDays).toBe(11)
    expect(await reconcile()).toMatchObject({ status: 'DIFFERENCES' })
    const ttl = await alerts('status=open&code=TTL_EXPIRING&level=CRITICAL')
    expect(ttl).toMatchObject([{ subject: { type: 'PLATFORM', id: 'WASM' }, expected: { minDays: 14 }, actual: { days: 11 } }])
    const extension = mockChain.extendTtl('CODE')
    expect(extension).toMatchObject({ kind: 'EXTEND_TTL', status: 'PENDING' })
    for (const identity of chainFixtures.identities) mockChain.extendTtl({ wineryId: identity.wineryId }, 120)
    mockChain.settle()
    expect((await accounts()).codeTtlDays).toBe(41)
    expect(await get<ChainTransaction>(`/v1/platform/chain/transactions/${extension.id}`, SUPPORT)).toMatchObject({ status: 'CONFIRMED', feeChargedStroops: '65000000', maxFeeStroops: '100000000' })
    expect(await reconcile()).toMatchObject({ status: 'OK' })
    expect(await alerts('status=open&code=TTL_EXPIRING')).toEqual([])
    // El backend aún puede no haberlo leído (`null`).
    mockChain.setCodeTtlDays(null)
    expect((await accounts()).codeTtlDays).toBeNull()
  })
})

describe('ERP: cuenta de la bodega vacía e identidad sin aprovisionar', () => {
  it('escenario empty: `chain-account` sin NFT, sin lotes, sin transacciones y sin costes', async () => {
    const normal = WineryChainAccountViewSchema.parse(await get('/v1/organizations/current/chain-account', OWNER))
    expect(normal.byLot.length).toBeGreaterThan(0)
    setScenario('empty')
    const empty = WineryChainAccountViewSchema.parse(await get('/v1/organizations/current/chain-account', OWNER))
    expect(empty).toMatchObject({ identity: normal.identity, totals: { minted: 0, available: 0, sold: 0, burned: 0 }, byLot: [], recentTransactions: [], chainCosts: { feesChargedXlm: '0.0000000', since: null } })
    expect(WineryChainAccountViewSchema.parse(await get(`/v1/platform/wineries/${CINTI}/chain-account`, SUPPORT)).byLot).toEqual([])
    expect((await get<Paged<unknown>>('/v1/collections', OWNER)).total).toBe(0)
  })

  it('escenario identidad-sin-aprovisionar: bodega ACTIVE con identidad NOT_PROVISIONED y nada en vuelo', async () => {
    setScenario('identidad-sin-aprovisionar')
    const account = WineryChainAccountViewSchema.parse(await get('/v1/organizations/current/chain-account', ALTOS_OWNER))
    expect(account).toMatchObject({ identity: { wineryId: ALTOS, status: 'NOT_PROVISIONED', account: null, contract: null, pendingTransactions: [], lastError: null }, byLot: [], recentTransactions: [] })
    expect(getErpDb().wineries.find((w) => w.id === ALTOS)!.certificationStatus).toBe('ACTIVE')
    expect(mockChain.pending()).toEqual([])
    const lot = lotNamed('Singani El Portillo 2025', ALTOS)
    expect(await get<{ tokenizable: boolean; chainIdentity: { status: string }; collection: unknown }>(`/v1/lots/${lot.id}/tokenization`, ALTOS_OWNER)).toMatchObject({ chainIdentity: { status: 'NOT_PROVISIONED' }, collection: null })
    expect((await get<{ wineries: { slug: string }[] }>('/v1/public/chain/registry')).wineries.map((w) => w.slug)).not.toContain('altos-de-calamuchita')
    // La otra bodega no cambia; operaciones aprovisiona a esta.
    expect((await get<{ identity: WineryChainIdentity }>('/v1/organizations/current/chain-account', OWNER)).identity.status).toBe('ACTIVE')
    expect((await post(`/v1/platform/wineries/${ALTOS}/chain/provision`, OPS, { reason: 'Relleno de identidades' })).status).toBe(202)
    mockChain.settle()
    expect((await get<{ identity: WineryChainIdentity }>('/v1/organizations/current/chain-account', ALTOS_OWNER)).identity).toMatchObject({ status: 'ACTIVE', contract: { symbol: 'ALT', paused: false } })
  })

  it('el embotellado no lleva `explorerUrl` (el OpenAPI no lo trae): el enlace del anclaje está en el expediente', async () => {
    const bottling = (await get<Paged<Record<string, unknown>>>('/v1/bottling?limit=100', OWNER)).items.find((b) => b.lotId === SINGANI_CASE.lotId)!
    expect(bottling).toMatchObject({ isAnchoredOnChain: true, blockchainAnchorTxHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(bottling).not.toHaveProperty('explorerUrl')
    const dossier = await get<{ anchor: { explorerUrl: string; txHash: string } }>(`/v1/lots/${SINGANI_CASE.lotId}/dossier`, OWNER)
    expect(dossier.anchor.txHash).toBe(bottling.blockchainAnchorTxHash)
    expect(dossier.anchor.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${dossier.anchor.txHash}`)
  })
})

describe('correos de la tokenización en el buzón simulado (§11)', () => {
  it('solicitud recibida, cambios pedidos, aprobada, NFT emitidos, publicada, rechazada y faltante', async () => {
    const owner = 'admin@cintiviejo.test'
    const ops = 'operaciones@drinksonchain.test'
    mockMailbox.clear()
    const created = dataOf((await post<{ id: string }>(`/v1/lots/${origin.id}/tokenization-requests`, OWNER, { quantity: 120, commercial: { name: 'Singani Edición Aniversario 2026', description: 'Edición limitada por el aniversario de la destilería.', imageKeys: [COVER(CINTI)] }, confirm: true })).json)
    expect(mails(owner).map((m) => m.template)).toEqual(['TOKENIZATION_REQUEST_RECEIVED'])
    expect(mails(owner)[0]).toMatchObject({ subject: 'Recibimos tu solicitud de tokenización de «Singani Edición Aniversario 2026» (CVJ-L2026-003)', link: `http://localhost:3002/tokenizacion/solicitudes/${created.id}`, app: 'ERP' })
    expect(mails(ops)[0]).toMatchObject({ template: 'TOKENIZATION_REQUEST_FOR_OPERATIONS', subject: 'Solicitud de tokenización nueva: Destilería Cinti Viejo', link: `http://localhost:3003/tokenizacion/solicitudes/${created.id}`, app: 'BACKOFFICE' })
    expect(mails('administracion@drinksonchain.test')).toHaveLength(1)
    expect(mails('soporte@drinksonchain.test')).toHaveLength(0)

    await post(`/v1/platform/tokenization-requests/${created.id}/take`, OPS)
    await post(`/v1/platform/tokenization-requests/${created.id}/request-changes`, OPS, { message: 'Falta la nota de cata.', fields: ['commercial.tastingNotes'] })
    expect(mails(owner)[0]).toMatchObject({ template: 'TOKENIZATION_CHANGES_REQUESTED' })
    expect(mails(owner)[0]!.text).toContain('Falta la nota de cata.')
    mockTokenization.resubmitAsWinery(created.id)
    expect(mails(ops)[0]!.subject).toBe('Solicitud de tokenización reenviada: Destilería Cinti Viejo')

    await post(`/v1/platform/tokenization-requests/${created.id}/take`, OPS)
    const approved = dataOf((await post<TokenizationApproval>(`/v1/platform/tokenization-requests/${created.id}/approve`, OPS, { publishOnMint: true })).json)
    expect(mails(owner)[0]).toMatchObject({ template: 'TOKENIZATION_APPROVED', link: `http://localhost:3002/tokenizacion/colecciones/${approved.collection.id}` })
    expect(mails(owner)[0]!.text).toContain('La emisión de sus NFT ya está en curso')
    // Al confirmarse la emisión: NFT emitidos (con enlace al contrato) y, por «publicar al emitir», colección publicada.
    mockChain.settle()
    const minted = mockMailbox.latest({ to: owner, template: 'NFT_MINTED' })!
    expect(minted.link).toBe(approved.collection.contract.explorerUrl)
    expect(minted.text).toContain('120 NFT')
    expect(mockMailbox.latest({ to: owner, template: 'COLLECTION_STATUS_CHANGED' })!.subject).toBe('Colección publicada: «Singani Edición Aniversario 2026»')
    await post(`/v1/platform/collections/${approved.collection.id}/pause`, OPS, { reason: 'Revisión de la ficha' })
    expect(mockMailbox.latest({ to: owner, template: 'COLLECTION_STATUS_CHANGED' })).toMatchObject({ subject: 'Colección pausada: «Singani Edición Aniversario 2026»' })

    // Rechazo con su motivo.
    const inReview = requestOf('Singani El Molino 2026', 'IN_REVIEW')
    await post(`/v1/platform/tokenization-requests/${inReview.id}/reject`, OPS, { reason: 'La destilación sigue abierta.' })
    const rejected = mockMailbox.latest({ to: owner, template: 'TOKENIZATION_REJECTED' })!
    expect(rejected.text).toContain('Motivo: La destilación sigue abierta.')

    // Faltante: la bodega descarta el lote de su preventa (0 botellas para 80 NFT).
    expect((await post(`/v1/lots/${SAME_SLUG_CASE.lotId}/discard`, ALTOS_OWNER, { reason: 'Granizo: se perdió la cosecha' })).status).toBeLessThan(300)
    expect((await get<LotClosure>(`/v1/platform/collections/${altosPreventa.id}/closure`, SUPPORT)).shortfall).toBe(80)
    const shortfall = mockMailbox.latest({ to: 'admin@altos.test', template: 'LOT_SHORTFALL_DETECTED' })!
    expect(shortfall.subject).toBe('Faltante de botellas en «Singani Preventa 2026»')
    expect(shortfall.text).toContain('faltan 80')
    // Un escenario de datos no llena el buzón con los avisos de rehacerse.
    mockMailbox.clear()
    setScenario('cambios-pedidos')
    await get('/v1/platform/tokenization-requests', SUPPORT)
    expect(mockMailbox.list()).toEqual([])
  })
})

describe('BORRADOR del Marketplace (§13.1), rc.2: alta con verificación, pedidos sembrados y máximo por compra', () => {
  const signup = (body: Record<string, unknown>) => call<unknown>('/v1/auth/signup', { body })
  const NEW = { email: 'lucia@correo.test', password: 'vendimia-2026', fullName: 'Lucía Arce', acceptTerms: true, ageDeclaration: true, captchaToken: 'ok', website: '' }

  it('alta: 202 VERIFICATION_SENT con captcha y campo trampa; `emailVerified` pasa a true al verificar el correo', async () => {
    mockMailbox.clear()
    const res = await signup(NEW)
    expect(res.status).toBe(202)
    expect(res.headers.get('x-mock-draft')).toBe(MARKETPLACE_DRAFT_CONTRACT)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(ConsumerSignupAcceptedSchema.parse(dataOf(res.json))).toEqual({ status: 'VERIFICATION_SENT' })
    const mail = mockMailbox.latest({ to: NEW.email, template: 'EMAIL_VERIFY' })!
    expect(mail).toMatchObject({ app: 'MARKETPLACE', link: `http://localhost:3005/verificar-correo?token=${mail.token}` })

    // Aún sin verificar: puede entrar, y su perfil lo dice.
    const login = async () => dataOf((await call<{ tokens: { accessToken: string }; user: { audience: string } }>('/v1/auth/login', { body: { email: NEW.email, password: NEW.password } })).json)
    const session = await login()
    expect(session.user.audience).toBe('CONSUMER')
    const profile = async () => ConsumerProfileSchema.parse(await get('/v1/me/consumer', session.tokens.accessToken))
    expect(await profile()).toMatchObject({ email: NEW.email, emailVerified: false, address: { custodial: true } })
    expect((await call('/v1/auth/verify-email', { body: { token: mail.token } })).status).toBe(204)
    expect((await profile()).emailVerified).toBe(true)
    expect(failure(await call('/v1/auth/verify-email', { body: { token: mail.token } }))).toMatchObject({ status: 422, code: 'AUTH_EMAIL_TOKEN_INVALID' })
    // Las cuentas de los fixtures ya están verificadas.
    expect(ConsumerProfileSchema.parse(await get('/v1/me/consumer', CONSUMER)).emailVerified).toBe(true)

    // Campo trampa relleno o correo ya registrado: 202 igual, sin crear nada ni enviar correo.
    mockMailbox.clear()
    const users = getErpDb().users.length
    expect((await signup({ ...NEW, email: 'bot@correo.test', website: 'https://spam.test' })).status).toBe(202)
    expect((await signup(NEW)).status).toBe(202)
    expect(getErpDb().users).toHaveLength(users)
    expect(mockMailbox.list()).toEqual([])
    // Captcha, declaraciones y contraseña.
    expect(failure(await signup({ ...NEW, email: 'otra@correo.test', captchaToken: 'fail' }))).toMatchObject({ status: 422, code: 'CAPTCHA_INVALID', details: [{ field: 'captchaToken' }] })
    expect(failure(await signup({ ...NEW, email: 'otra@correo.test', acceptTerms: false, ageDeclaration: undefined })).details.map((d) => d.field).sort()).toEqual(['acceptTerms', 'ageDeclaration'])
    expect(failure(await signup({ ...NEW, email: 'otra@correo.test', captchaToken: undefined }))).toMatchObject({ status: 422, details: [{ field: 'captchaToken' }] })
    expect(failure(await signup({ ...NEW, email: 'otra@correo.test', password: 'corta' }))).toMatchObject({ status: 422, details: [{ field: 'password' }] })

    // El alta del OpenAPI vigente (sin captcha) no cambia: 201 con sesión.
    const legacy = await signup({ email: 'pedro@correo.test', password: 'vendimia-2026', fullName: 'Pedro Salvatierra' })
    expect(legacy.status).toBe(201)
    expect(legacy.headers.get('x-mock-draft')).toBeNull()
    expect(dataOf(legacy.json)).toMatchObject({ user: { audience: 'CONSUMER' }, tokens: { tokenType: 'Bearer' } })
  })

  it('pedidos sembrados de la cuenta de demostración y máximo por compra consultable', async () => {
    const orders = (await get<Paged<unknown>>('/v1/orders', CONSUMER)).items.map((o) => OrderSchema.parse(o))
    expect(orders.map((o) => o.status)).toEqual(['EXPIRED', 'PAYMENT_FAILED', 'PAID', 'PAID'])
    expect(orders.map((o) => o.createdAt)).toEqual([...orders.map((o) => o.createdAt)].sort().reverse())
    const [expired, failed, paid] = orders as [(typeof orders)[number], (typeof orders)[number], (typeof orders)[number]]
    expect(paid).toMatchObject({ quantity: 2, payment: { provider: 'TEST', status: 'APPROVED' }, reservedUntil: null })
    expect(paid.tokens).toHaveLength(2)
    expect(paid.total.amountMinor).toBe(paid.unitPrice.amountMinor * 2)
    expect(paid.payment.paidAt).not.toBeNull()
    expect(failed).toMatchObject({ payment: { status: 'REJECTED', paidAt: null }, tokens: [] })
    expect(expired).toMatchObject({ payment: { status: 'PENDING' }, tokens: [], reservedUntil: null })
    // Cada pedido lleva la bodega de su colección: su ficha se resuelve con los dos `slug`.
    for (const o of orders) expect((await call(`/v1/public/collections/${o.collection.winery.slug}/${o.collection.slug}`)).status).toBe(200)
    expect(await get(`/v1/orders/${paid.id}`, CONSUMER)).toMatchObject({ id: paid.id, status: 'PAID' })
    // No cambian la disponibilidad del catálogo ni son de otra cuenta.
    const catalog = await get<Paged<{ id: string; availability: { available: number } }>>('/v1/public/collections')
    const { publicFixtures } = await import('../src/fixtures')
    expect(catalog.items.map((c) => [c.id, c.availability.available])).toEqual(publicFixtures.collections.map((c) => [c.id, c.availability.available]))
    expect((await get<Paged<unknown>>('/v1/orders', as('carlos'))).total).toBe(0)

    const settingsRes = await call('/v1/public/purchase-settings')
    expect(settingsRes.headers.get('x-mock-draft')).toBe(MARKETPLACE_DRAFT_CONTRACT)
    const settings = PurchaseSettingsSchema.parse(dataOf(settingsRes.json))
    expect(settings).toEqual({ maxBottlesPerOrder: 10, reservationMinutes: 30, currency: 'BOB' })
    // Es el mismo límite que aplica el pedido, y sigue a la configuración del back office.
    const order = (quantity: number) => post('/v1/orders', CONSUMER, { collectionId: granReserva.id, quantity })
    expect(failure(await order(settings.maxBottlesPerOrder + 1))).toMatchObject({ status: 422, code: 'MKT_MAX_PER_ORDER', details: [{ expected: 10 }] })
    expect((await order(settings.maxBottlesPerOrder)).status).toBe(201)
    expect((await post('/v1/platform/settings/compra.maxBotellasPorCompra', ADMIN, { value: 4, reason: 'Prueba del límite' }, 'PUT')).status).toBe(200)
    expect((await get<{ maxBottlesPerOrder: number }>('/v1/public/purchase-settings')).maxBottlesPerOrder).toBe(4)
    expect(failure(await order(5))).toMatchObject({ status: 422, code: 'MKT_MAX_PER_ORDER', details: [{ expected: 4, actual: 5 }] })
    // Una preventa con precio se puede comprar: sus NFT quedan `SOLD` (aún no canjeables) con su pedido.
    const presale = OrderSchema.parse(dataOf((await post('/v1/orders', CONSUMER, { collectionId: altosPreventa.id, quantity: 2 })).json))
    expect(presale).toMatchObject({ collection: { slug: SAME_SLUG_CASE.slug, winery: { slug: 'altos-de-calamuchita' } }, total: { amountMinor: 2 * SAME_SLUG_CASE.priceMinor } })
    await post(`/v1/payments/test/${presale.payment.id}/simulate`, CONSUMER, { outcome: 'APPROVE' })
    expect(getErpDb().chain.tokens.filter((t) => t.orderId === presale.id).map((t) => t.status)).toEqual(['SOLD', 'SOLD'])
    expect((await get<Paged<Record<string, unknown>>>(`/v1/platform/collections/${altosPreventa.id}/tokens?status=SOLD`, SUPPORT)).items[0]).not.toHaveProperty('orderId')
  })
})
