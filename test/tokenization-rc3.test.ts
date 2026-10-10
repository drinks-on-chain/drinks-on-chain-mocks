import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CHAIN_ALERT_SUBJECT_TYPES,
  ChainAlertSchema,
  LotClosureSchema,
  MockEmailSchema,
  PublicDossierVerificationSchema,
  TOKENIZATION_MAIL_TEMPLATES,
  WineryLotClosureSchema,
  type ApiErrorDetail,
  type ChainAlert,
  type Collection,
  type Dashboard,
  type Envelope,
  type LotClosure,
  type Paged,
} from '../src'
import { backofficeFixtures, chainFixtures, erpFixtures as F, SAME_SLUG_CASE, SINGANI_CASE, tokenizationFixtures as T } from '../src/fixtures'
import { getErpDb, mockChain, resetScenario, setScenario } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf } from './helpers'

// Ola 3, mocks 0.6.0-rc.3: contrato fijado desde el servidor (backend `91f037e`, pasos 3.1–3.6, sin
// ninguna ruta con 501) y precisiones del paso 3.6: cierre con faltante, conciliación, alertas y tablero.

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
  resetScenario()
})
afterAll(() => server.close())

const as = (key: string) => `mock.access.${key}`
const ALTOS_OWNER = as('altos_admin')
const OPS = as('operaciones')
const ADMIN = as('bo_admin')
const SUPPORT = as('soporte')
const CONSUMER = as('maria')
const CINTI = SINGANI_CASE.wineryId
const ALTOS = SAME_SLUG_CASE.wineryId
const collectionOf = (name: string, wineryId: string) => T.collections.find((c) => c.name === name && c.wineryId === wineryId)!
const granReserva = collectionOf(SINGANI_CASE.name, CINTI)
const portillo = collectionOf('Singani El Portillo 2025', ALTOS)
const CASE_CODE = F.lots.find((l) => l.id === SINGANI_CASE.lotId)!.lotCode!

let keySeq = 0
const post = <D = unknown>(path: string, token: string | null, body: unknown = {}) => call<D>(path, { method: 'POST', token, body, headers: { 'Idempotency-Key': uid(`rc3-test:${++keySeq}`) } })
const get = async <D>(path: string, token?: string) => dataOf((await call<D>(path, { token })).json)
function failure(res: { status: number; json: Envelope<unknown> }) {
  if (res.json.success) throw new Error(`Se esperaba un error y llegó ${res.status}`)
  return { status: res.status, code: res.json.error.code, details: (res.json.error.details ?? []) as ApiErrorDetail[] }
}
const shortfallCollection = async () => (await get<Paged<Collection>>(`/v1/platform/collections?wineryId=${ALTOS}`, SUPPORT)).items.find((c) => c.name === 'Singani El Portillo 2025')!

describe('cierre del lote con faltante (backend, paso 3.6)', () => {
  it('sin faltante y KEEP_ON_SALE: sigue NO_SHORTFALL con su decisión; con BURN decide administración y pasa por DECIDED → RESOLVED', async () => {
    const url = `/v1/platform/collections/${granReserva.id}/closure`
    const kept = LotClosureSchema.parse(dataOf((await post(`${url}/decide`, OPS, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Siguen a la venta' })).json))
    expect(kept).toMatchObject({ status: 'NO_SHORTFALL', unsoldPolicy: 'KEEP_ON_SALE', shortfall: 0, items: [], decision: { reason: 'Siguen a la venta' } })
    // Sigue sin decidirse del todo: administración puede cambiar a quemar los no vendidos.
    expect(failure(await post(`${url}/decide`, OPS, { unsoldPolicy: 'BURN', reason: 'Se retira' }))).toMatchObject({ status: 403, code: 'AUTH_INSUFFICIENT_PERMISSIONS' })
    const burning = LotClosureSchema.parse(dataOf((await post(`${url}/decide`, ADMIN, { unsoldPolicy: 'BURN', reason: 'Se retira la colección' })).json))
    expect(burning).toMatchObject({ status: 'DECIDED', unsoldPolicy: 'BURN' })
    expect(burning.items).toHaveLength(60)
    expect(burning.items.every((i) => i.outcome === 'BURN_UNSOLD' && i.burnTx?.status === 'PENDING')).toBe(true)
    // Ya decidido → 409 `CONFLICT` con el estado.
    expect(failure(await post(`${url}/decide`, ADMIN, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'CONFLICT', details: [{ meta: { closureStatus: 'DECIDED' } }] })
    mockChain.settle()
    expect(await get<LotClosure>(url, SUPPORT)).toMatchObject({ status: 'RESOLVED' })
    expect((await get<Collection>(`/v1/platform/collections/${granReserva.id}`, SUPPORT)).counts).toMatchObject({ burned: 60, available: 0 })
  })

  it('cualquier faltante exige administración, también sin NFT que quemar; con el contrato pausado → 409 CHN_CONTRACT_PAUSED', async () => {
    setScenario('faltante-vendidos')
    const collection = await shortfallCollection()
    const url = `/v1/platform/collections/${collection.id}/closure`
    // Todo vendido: el faltante cae entero sobre vendidos (ninguna quema), y aun así decide administración.
    for (const t of getErpDb().chain.tokens) if (t.collectionId === collection.id && t.status === 'MINTED') Object.assign(t, { status: 'SOLD', soldAt: '2026-09-24T10:00:00Z' })
    expect(failure(await post(`${url}/decide`, OPS, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Sin quemas' }))).toMatchObject({ status: 403, code: 'AUTH_INSUFFICIENT_PERMISSIONS' })
    await post(`/v1/platform/wineries/${ALTOS}/chain/pause`, ADMIN, { reason: 'Incidente' })
    mockChain.settle()
    expect(failure(await post(`${url}/decide`, ADMIN, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Con el contrato pausado' }))).toMatchObject({ status: 409, code: 'CHN_CONTRACT_PAUSED', details: [{ meta: { status: 'PAUSED' } }] })
    await post(`/v1/platform/wineries/${ALTOS}/chain/unpause`, ADMIN, { reason: 'Resuelto' })
    mockChain.settle()
    expect(dataOf((await post<LotClosure>(`${url}/decide`, ADMIN, { unsoldPolicy: 'KEEP_ON_SALE', reason: 'Se atienden uno a uno' })).json)).toMatchObject({ status: 'DECIDED' })
  })

  it('los ítems solo se añaden: los reservados ceden antes que los vendidos, y más botellas anuladas reabren el cierre', async () => {
    setScenario('faltante-botellas')
    const collection = await shortfallCollection()
    const url = `/v1/platform/collections/${collection.id}/closure`
    const before = LotClosureSchema.parse(await get(url, SUPPORT))
    expect(before).toMatchObject({ status: 'SHORTFALL_OPEN', shortfall: 20, unsoldToBurn: 20, soldWithoutBottle: 0 })
    // Resolver a mano un NFT sin vender no procede (se quema al decidir): 409 `CONFLICT`.
    expect(failure(await post(`${url}/items/${before.items[0]!.tokenId}/resolve`, OPS, { outcome: 'MANUAL_REFUND', note: 'No aplica' }))).toMatchObject({ status: 409, code: 'CONFLICT', details: [{ meta: { tokenStatus: 'MINTED' } }] })
    expect(failure(await post(`${url}/items/999999/resolve`, OPS, { outcome: 'MANUAL_REFUND', note: 'No existe' }))).toMatchObject({ status: 404, code: 'NOT_FOUND' })

    // Se vende y se reserva casi todo, y después se anulan 6 botellas más: el cierre crece con los
    // 3 sin vender que quedan, los 2 reservados y, solo entonces, 1 vendido (el pago más reciente).
    const db = getErpDb()
    const free = db.chain.tokens.filter((t) => t.collectionId === collection.id && t.status === 'MINTED' && !before.items.some((i) => i.tokenId === t.tokenId)).sort((a, b) => a.bottleNumber - b.bottleNumber)
    free.slice(0, free.length - 5).forEach((t, i) => Object.assign(t, { status: 'SOLD', soldAt: new Date(Date.UTC(2026, 8, 20, 12, 0, i)).toISOString() }))
    free.slice(-5, -3).forEach((t) => Object.assign(t, { status: 'RESERVED' }))
    const codes = db.bottleLots.find((b) => b.lotId === collection.lotId)!
    codes.voided.push(...Array.from({ length: 6 }, (_, i) => ({ ...codes.voided[0], serial: i + 1, replacedBy: null })) as typeof codes.voided)
    const after = LotClosureSchema.parse(await get(url, SUPPORT))
    expect(after.bottles).toBe(before.bottles - 6)
    expect(after).toMatchObject({ status: 'SHORTFALL_OPEN', shortfall: 26, unsoldToBurn: 23, soldWithoutBottle: 3 })
    expect(after.items.slice(0, 20).map((i) => i.tokenId)).toEqual(before.items.map((i) => i.tokenId))
    expect(after.items.slice(20).map((i) => i.status)).toEqual(['MINTED', 'MINTED', 'MINTED', 'RESERVED', 'RESERVED', 'SOLD'])
  })

  it('la bodega ve el cierre sin datos de pedidos; la lista de cierres y el tablero lo cuentan', async () => {
    setScenario('faltante-vendidos')
    const collection = await shortfallCollection()
    const mine = WineryLotClosureSchema.parse(await get(`/v1/collections/${collection.id}/closure`, ALTOS_OWNER))
    expect(mine).toMatchObject({ status: 'SHORTFALL_OPEN', shortfall: 20, soldWithoutBottle: 10 })
    for (const item of mine.items) expect(Object.keys(item).sort()).toEqual(['bottleNumber', 'burnTx', 'outcome', 'resolvedAt', 'status', 'tokenId'])
    const list = await get<Paged<Record<string, unknown>>>('/v1/platform/lot-closures?status=SHORTFALL_OPEN', SUPPORT)
    expect(list.items).toMatchObject([{ collectionId: collection.id, shortfall: 20 }])
    expect(list.items[0]).not.toHaveProperty('items')
    expect((await get<Dashboard>('/v1/platform/dashboard', ADMIN)).tokenization.shortfallsOpen).toBe(1)
  })
})

describe('conciliación, alertas y tablero (backend, paso 3.6)', () => {
  it('lanzar una conciliación: 409 CHN_DISABLED sin cadena y 422 en `subjectId` si no es un contrato o una colección existentes', async () => {
    const run = (body: unknown) => post('/v1/platform/chain/reconciliation/runs', OPS, body)
    expect(failure(await run({ scope: 'COLLECTION', subjectId: uid('no-existe') }))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'subjectId' }] })
    expect(failure(await run({ scope: 'CONTRACT', subjectId: 'CAAAA' }))).toMatchObject({ status: 422, details: [{ field: 'subjectId' }] })
    expect(failure(await run({ scope: 'CONTRACT' }))).toMatchObject({ status: 422, details: [{ field: 'subjectId' }] })
    expect((await run({ scope: 'COLLECTION', subjectId: portillo.id })).status).toBe(202)
    expect((await run({ scope: 'CONTRACT', subjectId: portillo.contract.address, depth: 'FULL' })).status).toBe(202)
    mockChain.setEnabled(false)
    expect(failure(await run({ scope: 'ALL' }))).toMatchObject({ status: 409, code: 'CHN_DISABLED' })
  })

  it('`subject.type` de las alertas ∈ los diez tipos del backend; el tablero las resume en `chain-alerts-critical` y `-warning`', async () => {
    expect([...CHAIN_ALERT_SUBJECT_TYPES]).toEqual(['CONTRACT', 'COLLECTION', 'LOT', 'MINT', 'TOKEN', 'TRANSACTION', 'EVENT', 'NETWORK', 'CODE', 'PLATFORM_ACCOUNT'])
    const types = (alerts: readonly ChainAlert[]) => alerts.every((a) => (CHAIN_ALERT_SUBJECT_TYPES as readonly string[]).includes(a.subject.type))
    expect(types(chainFixtures.alerts)).toBe(true)
    // En `normal` solo hay un aviso abierto: una entrada `WARNING`, ninguna `CRITICAL`.
    const chainEntries = async () => (await get<Dashboard>('/v1/platform/dashboard', ADMIN)).alerts.filter((a) => a.id.startsWith('chain-alerts-'))
    expect(await chainEntries()).toMatchObject([{ id: 'chain-alerts-warning', level: 'WARNING', message: '1 aviso de la cadena sin resolver.', link: '/cadena/alertas' }])

    setScenario('alerta-evento-inesperado')
    const unexpected = (await get<Paged<ChainAlert>>('/v1/platform/chain/alerts?code=UNEXPECTED_EVENT', SUPPORT)).items.map((a) => ChainAlertSchema.parse(a))
    const event = (await get<Paged<{ rpcEventId: string }>>('/v1/platform/chain/events?unmatched=true', SUPPORT)).items[0]!
    expect(unexpected).toMatchObject([{ subject: { type: 'EVENT', id: event.rpcEventId }, expected: { originatedBySystem: true } }])
    // Más alertas de todo tipo, y todas con un tipo de sujeto conocido.
    mockChain.indexerGap()
    mockChain.setCodeTtlDays(3)
    mockChain.drift({ kind: 'OWNER', wineryId: CINTI, tokenId: 0 })
    mockChain.mismatchNext('MINT_BATCH')
    const inReview = T.requests.find((r) => r.lot.name === 'Singani El Molino 2026' && r.status === 'IN_REVIEW')!
    await post(`/v1/platform/tokenization-requests/${inReview.id}/approve`, OPS)
    mockChain.settle()
    await post('/v1/platform/chain/reconciliation/runs', OPS, { scope: 'ALL', depth: 'FULL' })
    mockChain.indexerGap()
    const all = (await get<Paged<ChainAlert>>('/v1/platform/chain/alerts?limit=100', SUPPORT)).items
    expect(types(all)).toBe(true)
    expect([...new Set(all.map((a) => `${a.code}:${a.subject.type}`))].sort()).toEqual(['INDEXER_GAP:NETWORK', 'LOW_BALANCE:PLATFORM_ACCOUNT', 'MINT_RANGE_MISMATCH:MINT', 'OWNER_MISMATCH:CONTRACT', 'TTL_EXPIRING:CODE', 'TTL_EXPIRING:CONTRACT', 'UNEXPECTED_EVENT:EVENT'])
    const open = all.filter((a) => a.resolvedAt === null)
    const critical = open.filter((a) => a.level === 'CRITICAL').length
    const warning = open.filter((a) => a.level === 'WARNING').length
    expect(await chainEntries()).toMatchObject([
      { id: 'chain-alerts-critical', level: 'CRITICAL', message: `${critical} alertas críticas de la cadena sin resolver: nada se corrige solo.` },
      { id: 'chain-alerts-warning', level: 'WARNING', message: `${warning} avisos de la cadena sin resolver.` },
    ])
    expect((await get<Dashboard>('/v1/platform/dashboard', ADMIN)).chain.openAlerts).toEqual({ critical, warning })
  })
})

describe('buzón de los fixtures y pedidos del Marketplace', () => {
  it('`fixtures/backoffice/mailbox.json` lleva los correos de la tokenización, por fecha y con los mismos textos que en la sesión', () => {
    const mailbox = backofficeFixtures.mailbox.map((m) => MockEmailSchema.parse(m))
    expect(mailbox.map((m) => m.createdAt)).toEqual([...mailbox.map((m) => m.createdAt)].sort())
    expect(new Set(mailbox.map((m) => m.id)).size).toBe(mailbox.length)
    const tokenization = mailbox.filter((m) => (TOKENIZATION_MAIL_TEMPLATES as readonly string[]).includes(m.template))
    const count = (template: string, to?: string) => tokenization.filter((m) => m.template === template && (!to || m.to === to)).length
    // Una «recibida» por solicitud; cada aprobación, su emisión; dos cambios pedidos; un rechazo.
    expect(count('TOKENIZATION_REQUEST_RECEIVED')).toBe(T.requests.length)
    expect(count('TOKENIZATION_APPROVED')).toBe(T.collections.length)
    expect(count('NFT_MINTED')).toBe(T.collections.length)
    expect(count('TOKENIZATION_CHANGES_REQUESTED')).toBe(2)
    expect(count('TOKENIZATION_REJECTED')).toBe(1)
    expect(count('COLLECTION_STATUS_CHANGED')).toBe(T.collections.filter((c) => c.publishedAt).length)
    // A operaciones y administración (no a soporte): cada solicitud nueva y el reenvío de la preventa.
    expect(count('TOKENIZATION_REQUEST_FOR_OPERATIONS', 'operaciones@drinksonchain.test')).toBe(T.requests.length + 1)
    expect(count('TOKENIZATION_REQUEST_FOR_OPERATIONS', 'soporte@drinksonchain.test')).toBe(0)
    const minted = tokenization.find((m) => m.template === 'NFT_MINTED' && m.subject.includes('Gran Reserva'))!
    expect(minted).toMatchObject({ to: 'admin@cintiviejo.test', link: granReserva.contract.explorerUrl, app: null })
    const changes = tokenization.find((m) => m.template === 'TOKENIZATION_CHANGES_REQUESTED' && m.to === 'admin@cintiviejo.test')!
    expect(changes.text).toContain('Falta la nota de cata para la ficha de la colección.')
    expect(changes.link).toMatch(/^http:\/\/localhost:3002\/tokenizacion\/solicitudes\//)
    // Los de la Ola 1 siguen ahí.
    expect(mailbox.filter((m) => m.template === 'INVITATION').length).toBeGreaterThan(0)
  })

  it('escenario verificacion-no-coincide: `MEMO_MATCHES_HASH` en false con el anclaje confirmado', async () => {
    const url = `/v1/public/lots/${CASE_CODE}/verification`
    const good = PublicDossierVerificationSchema.parse(await get(url))
    setScenario('verificacion-no-coincide')
    const res = await call(url)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bad = PublicDossierVerificationSchema.parse(dataOf(res.json))
    expect(bad.checks.map((c) => [c.key, c.pass])).toEqual([['DOSSIER_CLOSED', true], ['ANCHOR_CONFIRMED', true], ['MEMO_MATCHES_HASH', false], ['ANCHOR_ACCOUNT_OFFICIAL', true]])
    expect(bad.anchor).toMatchObject({ status: 'ANCHORED', txHash: good.anchor!.txHash })
    expect(bad.anchor!.memoHashHex).not.toBe(bad.dossier.hash)
    expect(bad.dossier.hash).toBe(good.dossier.hash)
    // Un lote sin anclar no cambia.
    const other = Object.keys(chainFixtures.verifications).find((code) => chainFixtures.verifications[code]!.anchor === null)!
    expect(await get(`/v1/public/lots/${other}/verification`)).toMatchObject({ anchor: null })
  })

  it('las cuentas de los fixtures conservan su dirección; solo un alta sin verificar tiene `address: null`', async () => {
    expect(await get<{ address: unknown }>('/v1/me/consumer', CONSUMER)).toMatchObject({ emailVerified: true, address: { custodial: true } })
    expect((await call('/v1/users/me/wallet', { token: CONSUMER })).status).toBe(200)
  })
})
