import { advanceChain, raiseAlert, recordChainEvent, settleChain, type ChainCtx, type ChainEnv } from '../chain/engine'
import { anchorDossier, extendTtl, provisionIdentity, runReconciliation } from '../chain/service'
import { collectionOfLot, emptyChainState, identityOf, TESTNET_PASSPHRASE, tokensOf, type ChainState, type StoredCollection } from '../chain/state'
import type { UserRef } from '../chain/schemas'
import type { Lot, TraceActor } from '../erp/schemas'
import { actorOfMember } from '../erp/trace/backfill'
import { isoSeconds } from '../erp/trace/dates'
import { SINGANI_CASE } from '../erp/trace/demo'
import { bottleCodesSummary, bottleLotOf, createLot, ctxAt, lotBottling, lotDossier, refreshLotStage, type TraceCtx, type TraceState } from '../erp/trace/state'
import { mockAccountAddress, mockTxHash } from '../shared/strkey'
import { uid } from '../shared/uuid'
import type { CollectionCommercialInput } from './schemas'
import { addRequestNote, approveRequest, closureOf, createRequest, publishCollection, rejectRequest, requestChanges, resubmitRequest, takeRequest, updateRequest, withdrawRequest } from './service'

// Datos de demostración de la Ola 3 y escenarios de `/__mocks`. Como los de la Ola 2, se generan
// ejecutando los mismos servicios que los handlers (solicitud → revisión → aprobación → emisión →
// publicación → anclaje), cada paso con su fecha, sobre la red simulada.

const DAY_MS = 86_400_000

/** Lote de la preventa del recorrido H3 (contrato §14): Cinti Viejo, singani, estimación 3.000. */
export const PREVENTA_CASE = {
  name: 'Singani Preventa 2026',
  wineryId: uid('winery:cintiviejo'),
  lotId: uid('demo:preventa-2026:lot'),
  /** Cuota de la solicitud inicial. */
  quota: 100,
} as const

/**
 * Segunda bodega con una colección del **mismo `slug`** que otra (el `slug` es único por bodega, no
 * global): «Singani Preventa 2026» de Bodega Altos de Calamuchita, en preventa a Bs 150.
 */
export const SAME_SLUG_CASE = {
  name: PREVENTA_CASE.name,
  slug: 'singani-preventa-2026',
  wineryId: uid('winery:altos'),
  lotId: uid('demo:altos-preventa-2026:lot'),
  quota: 80,
  priceMinor: 15_000,
} as const

/** Personal de operaciones y administración de los fixtures (quien revisa y aprueba). */
export const DEMO_REVIEWERS = {
  operations: { userId: uid('user:operaciones'), fullName: 'Valeria Méndez' },
  analyst: { userId: uid('user:analista'), fullName: 'Camila Torrez' },
  admin: { userId: uid('user:bo_admin'), fullName: 'Jorge Salinas' },
} as const satisfies Record<string, UserRef>

/** Primer ledger de la red simulada y su cadencia (≈ 5 s por ledger, como testnet). */
const LEDGER_BASE = 1_480_000
const LEDGER_EPOCH = Date.parse('2026-09-01T00:00:00Z')
const ledgerAt = (iso: string): number => LEDGER_BASE + Math.max(0, Math.floor((Date.parse(iso) - LEDGER_EPOCH) / 5000))

const imageKey = (wineryId: string, name: string) => `org/${wineryId}/collections/2026/${name}`

function member(state: TraceState, key: string): TraceActor {
  const actor = actorOfMember(state, uid(`member:${key}`))
  if (!actor) throw new Error(`Semilla de la Ola 3: falta el miembro ${key}`)
  return actor
}

function lotByName(state: TraceState, wineryId: string, name: string): Lot {
  const lot = state.lots.find((l) => l.wineryId === wineryId && l.name === name)
  if (!lot) throw new Error(`Semilla de la Ola 3: falta el lote «${name}»`)
  return lot
}

/** Reloj de los pasos: `at(díasAntes, hora, minuto)` respecto de hoy, y la red confirmada un minuto después. */
function clock(state: TraceState, ctx: ChainCtx) {
  const base = Date.parse(`${ctx.today}T00:00:00Z`)
  const at = (daysAgo: number, hour = 14, minute = 0): ChainCtx => ({ ...ctx, ...ctxAt(ctx, isoSeconds(base - daysAgo * DAY_MS + hour * 3_600_000 + minute * 60_000), null), env: ctx.env })
  /** Deja que la red confirme todo lo pendiente, con fecha un minuto posterior al paso. */
  const settle = (step: ChainCtx): void => {
    const later = { ...step, ...ctxAt(step, isoSeconds(Date.parse(step.now) + 60_000), null), env: step.env }
    state.chain.ledger = Math.max(state.chain.ledger, ledgerAt(later.now))
    settleChain(state, later)
  }
  return { at, settle }
}

// ---------------------------------------------------------------------------
// Semilla
// ---------------------------------------------------------------------------

function seedPlatform(chain: ChainState, ctx: ChainCtx): void {
  Object.assign(chain.platform, {
    operationsAddress: mockAccountAddress('platform:operations'),
    anchorAddress: mockAccountAddress('platform:anchor'),
    operationsBalanceXlm: '9482.5310000',
    anchorBalanceXlm: '99.9998800',
    // El hash del código es un SHA-256 con forma válida, distinto del de `deployments/testnet.json`.
    wasmHash: mockTxHash('wasm:winery-nft'),
    codeTtlDays: 96,
    checkedAt: ctx.now,
    networkPassphrase: TESTNET_PASSPHRASE,
  })
  chain.ledger = LEDGER_BASE
  chain.indexer.lastLedger = LEDGER_BASE
  // Al código le quedan 96 días de vida el día de referencia (baja con el reloj de los mocks).
  chain.ttl.code = daysFrom(ctx, 96)
}

/** Fecha a `days` días del mediodía de hoy (vida del almacenamiento: `daysUntil` da `days` durante el día). */
const daysFrom = (ctx: ChainCtx, days: number): string => isoSeconds(Date.parse(`${ctx.today}T12:00:00Z`) + days * DAY_MS + 12 * 3_600_000)

/**
 * Vende NFT de una colección a compradores de demostración (lo que hará la compra de la Ola 4): los
 * primeros números de botella, con su fecha de pago y su pedido. `soldAt` crece con el número.
 */
export function sellDemoTokens(state: TraceState, ctx: ChainCtx, collection: StoredCollection, count: number, daysAgo = 4): void {
  const base = Date.parse(`${ctx.today}T15:00:00Z`) - daysAgo * DAY_MS
  const tokens = tokensOf(state.chain, collection.id)
    .filter((t) => t.status === 'MINTED')
    .sort((a, b) => a.bottleNumber - b.bottleNumber)
    .slice(0, count)
  tokens.forEach((t, i) => {
    // Pedidos de dos botellas, uno por comprador de demostración.
    const order = Math.floor(i / 2)
    const soldAt = isoSeconds(base + order * 37 * 60_000)
    Object.assign(t, { status: 'SOLD', owner: { kind: 'CONSUMER', address: mockAccountAddress(`demo-consumer:${collection.id}:${order}`) }, soldAt, orderId: uid(`demo-order:${collection.id}:${order}`) })
    t.onchain = { owner: t.owner.address, burned: false, checkedAt: soldAt }
  })
}

const PREVENTA_COMMERCIAL: CollectionCommercialInput = {
  name: 'Singani Preventa 2026',
  description: 'Preventa del singani de la vendimia 2026 de Destilería Cinti Viejo: Moscatel de Alejandría de los parrales de Camargo, destilado en alambique de cobre y con reposo de seis meses antes del embotellado.',
  pairing: 'Solo, en copa pequeña, o en un chuflay con ginger ale y limón.',
}

export type PreventaStage = 'SUBMITTED' | 'CHANGES_REQUESTED' | 'IN_REVIEW' | 'APPROVED' | 'MINTED' | 'PUBLISHED'

export interface PreventaOptions {
  upTo?: PreventaStage
  /** Días antes de hoy en que la bodega envía la solicitud (por defecto 5). */
  submittedDaysAgo?: number
  /** `false`: deja la emisión en vuelo (escenario `emision-en-curso`). */
  settle?: boolean
}

/**
 * Recorrido H3 sobre «Singani Preventa 2026»: la dueña autoriza 100 botellas, operaciones pide la
 * nota de cata, la dueña la añade y reenvía, operaciones aprueba sin precio (política sin definir),
 * la emisión se confirma y la colección se publica en preventa.
 */
export function runPreventaCase(state: TraceState, ctx: ChainCtx, options: PreventaOptions = {}): void {
  const { upTo = 'PUBLISHED', submittedDaysAgo = 5 } = options
  const d = submittedDaysAgo
  const { at, settle } = clock(state, ctx)
  const owner = member(state, 'cvj_admin')
  const lot = lotByName(state, PREVENTA_CASE.wineryId, PREVENTA_CASE.name)
  const ops = DEMO_REVIEWERS.operations
  const request = createRequest(
    state,
    at(d, 15),
    lot,
    { quantity: PREVENTA_CASE.quota, commercial: { ...PREVENTA_COMMERCIAL, imageKeys: [{ key: imageKey(lot.wineryId, 'singani-preventa-2026.jpg'), alt: 'Botella de Singani Preventa 2026 sobre una mesa de madera', isCover: true }] }, notes: 'Primera preventa de la destilería.', confirm: true },
    owner,
  )
  if (upTo === 'SUBMITTED') return
  takeRequest(state, at(d - 1, 13), request, ops)
  requestChanges(state, at(d - 1, 13, 20), request, 'Falta la nota de cata para la ficha de la colección.', ['commercial.tastingNotes'], ops)
  if (upTo === 'CHANGES_REQUESTED') return
  updateRequest(state, at(d - 2, 14), request, lot, { commercial: { tastingNotes: 'Nariz floral de moscatel, con azahar y cáscara de lima; boca limpia y sedosa, de final largo.' } }, owner)
  resubmitRequest(state, at(d - 2, 14, 5), request, lot, 'Añadida la nota de cata.', owner)
  takeRequest(state, at(d - 2, 16), request, ops)
  addRequestNote(state, at(d - 2, 16, 10), request, 'Datos completos. Precio pendiente de la política (A-32): se aprueba sin precio.', ops)
  if (upTo === 'IN_REVIEW') return
  const approved = at(d - 3, 13)
  const { collection } = approveRequest(state, approved, request, { reason: 'Datos completos; precio por anunciar' }, ops)
  if (upTo === 'APPROVED' || options.settle === false) return
  settle(approved)
  if (upTo === 'MINTED') return
  publishCollection(state, at(d - 3, 15), collection, ops, 'Apertura de la preventa')
}

/** Colección aprobada y emitida sobre un lote ya avanzado (hechos anteriores a su estado actual). */
function seedCollection(
  state: TraceState,
  ctx: ChainCtx,
  input: { lot: Lot; owner: TraceActor; quantity: number; daysAgo: number; commercial: CollectionCommercialInput; priceMinor?: number; publish?: boolean },
) {
  const { at, settle } = clock(state, ctx)
  const { lot, daysAgo: d } = input
  const ops = DEMO_REVIEWERS.operations
  // La solicitud se guarda directamente: cuando se envió, el lote aún estaba en una etapa tokenizable.
  const stage = lot.stage
  lot.stage = 'RESTING'
  let request
  try {
    request = createRequest(state, at(d, 15), lot, { quantity: Math.min(input.quantity, 1), commercial: input.commercial, confirm: true }, input.owner)
  } finally {
    lot.stage = stage
  }
  Object.assign(request, { quantity: input.quantity, resultingQuota: input.quantity, limitsAtSubmission: { ...request.limitsAtSubmission, basis: 'ESTIMATE', bottles: null, maxQuantity: Math.max(input.quantity, request.limitsAtSubmission.maxQuantity) } })
  state.lotEvents.filter((e) => e.lotId === lot.id && e.type === 'TOKENIZATION_AUTHORIZED').forEach((e) => Object.assign(e, { summary: `Tokenización autorizada: ${input.quantity} botellas`, data: { ...e.data, quantity: input.quantity, resultingQuota: input.quantity } }))
  takeRequest(state, at(d - 1, 13), request, ops)
  const approved = at(d - 1, 16)
  const { collection } = approveRequest(state, approved, request, { price: input.priceMinor ? { amountMinor: input.priceMinor, currency: 'BOB' } : undefined, reason: null }, ops, { skipLotRules: true })
  settle(approved)
  if (input.publish) publishCollection(state, at(d - 2, 14), collection, ops, null)
  return collection
}

/** Anclaje de relleno (`chain.anchor.backfill`): todo lote certificado, justo después de cerrarse su expediente. */
function anchorCertifiedLots(state: TraceState, ctx: ChainCtx): void {
  const { settle } = clock(state, ctx)
  for (const lot of state.lots) {
    const dossier = lotDossier(state, lot.id)
    if (lot.stage !== 'CERTIFIED' || dossier?.status !== 'CLOSED' || !dossier.closedAt) continue
    const step = { ...ctx, ...ctxAt(ctx, isoSeconds(Date.parse(dossier.closedAt) + 60_000), null), env: ctx.env }
    anchorDossier(state, step, lot)
    settle(step)
  }
}

/** Reordena los eventos de esos lotes por la fecha en que se registraron y renumera su `seq`. */
function resequenceLotEvents(state: TraceState, lotIds: readonly string[]): void {
  for (const lotId of lotIds) {
    const events = state.lotEvents.filter((e) => e.lotId === lotId).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.seq - b.seq)
    events.forEach((e, i) => (e.seq = i + 1))
    state.lotEvents = [...state.lotEvents.filter((e) => e.lotId !== lotId), ...events]
  }
}

/**
 * Los pasos de la semilla no se ejecutan en orden cronológico (cada caso se siembra entero): al
 * terminar, el ledger de cada transacción confirmada se recalcula por su fecha, para que ledgers y
 * fechas crezcan juntos, y los eventos del indexador siguen a su transacción.
 */
function resequenceLedgers(chain: ChainState): void {
  const confirmed = chain.transactions.filter((t) => t.ledger !== null && t.confirmedAt).sort((a, b) => a.confirmedAt!.localeCompare(b.confirmedAt!) || a.ledger! - b.ledger!)
  let last = LEDGER_BASE
  for (const tx of confirmed) {
    last = Math.max(last + 1, ledgerAt(tx.confirmedAt!) + 1)
    tx.ledger = last
  }
  const ledgerOfTx = new Map(confirmed.map((t) => [t.id, t.ledger!]))
  const seen = new Map<number, number>()
  for (const event of chain.events) {
    const ledger = event.matchedTransactionId ? ledgerOfTx.get(event.matchedTransactionId) : undefined
    if (ledger !== undefined) event.ledger = ledger
    const index = seen.get(event.ledger) ?? 0
    seen.set(event.ledger, index + 1)
    event.rpcEventId = `${String(event.ledger).padStart(10, '0')}-${String(index).padStart(10, '0')}`
  }
  chain.events.sort((a, b) => a.rpcEventId.localeCompare(b.rpcEventId))
  chain.ledger = Math.max(last, ledgerAt(confirmed.at(-1)?.confirmedAt ?? ''), chain.ledger)
}

/** Genera el estado de la Ola 3 sobre la trazabilidad ya sembrada (lotes de la Ola 2 incluidos). */
export function runChainSeed(state: TraceState, ctx: ChainCtx): void {
  state.chain = emptyChainState()
  const chain = state.chain
  seedPlatform(chain, ctx)
  const { at, settle } = clock(state, ctx)
  const CVJ = uid('winery:cintiviejo')
  const ALT = uid('winery:altos')
  const CUR = uid('winery:uriondo')

  // 1. Identidad de las bodegas que ya estaban activas (relleno `chain.identity.backfill`, SE-02).
  ;[CVJ, ALT, CUR].forEach((wineryId, i) => {
    if (!state.wineries.some((w) => w.id === wineryId)) return
    const step = at(40, 9, i * 10)
    provisionIdentity(state, step, wineryId, null)
    settle(step)
  })

  // Vida del almacenamiento de cada contrato (§8.3): la tarea de TTL la va alargando. Al de Altos le
  // quedan 9 días (su alerta `TTL_EXPIRING` sigue abierta); el de Cinti Viejo bajó de 14 hace seis
  // días y se alargó al día siguiente (paso 7).
  const ttlDays: Record<string, number> = { [CVJ]: 6, [ALT]: 9, [CUR]: 25 }
  for (const [wineryId, days] of Object.entries(ttlDays)) {
    const contract = identityOf(chain, wineryId)?.contract
    if (contract) chain.ttl.contracts[contract.address] = daysFrom(ctx, days)
  }

  // 2. «Singani Gran Reserva 2026»: preventa de 60 botellas antes de certificarse (su anclaje, en el paso 4).
  const caseLot = state.lots.find((l) => l.id === SINGANI_CASE.lotId)
  if (caseLot) {
    seedCollection(state, ctx, {
      lot: caseLot,
      owner: member(state, 'cvj_admin'),
      quantity: 60,
      daysAgo: 21,
      priceMinor: 28_000,
      publish: true,
      commercial: {
        name: 'Singani Gran Reserva 2026',
        description: 'Edición limitada de la Parcela 2 de Destilería Cinti Viejo: 2.950 botellas de singani con Denominación de Origen, 180 días de reposo y expediente de trazabilidad completo.',
        tastingNotes: 'Flor de azahar, durazno blanco y un fondo mineral; entrada suave y final persistente.',
        pairing: 'Quesos de cabra, frutos secos y postres de cítricos.',
        imageKeys: [
          { key: imageKey(CVJ, 'singani-gran-reserva-2026.jpg'), alt: 'Botella de Singani Gran Reserva 2026', isCover: true },
          { key: imageKey(CVJ, 'singani-gran-reserva-2026-parrales.jpg'), alt: 'Parrales de Moscatel de Alejandría en el cañón de Cinti' },
        ],
      },
    })
  }

  // 3. «Singani El Portillo 2025» (Altos, embotellado): colección lista sin publicar y una ampliación enviada.
  const portillo = state.lots.find((l) => l.wineryId === ALT && l.name === 'Singani El Portillo 2025')
  if (portillo) {
    seedCollection(state, ctx, {
      lot: portillo,
      owner: member(state, 'altos_admin'),
      quantity: 240,
      daysAgo: 9,
      commercial: {
        name: 'Singani El Portillo 2025',
        description: 'Singani de altura de la parcela El Portillo de Bodega Altos de Calamuchita, embotellado en 2025 tras su reposo en acero.',
        imageKeys: [{ key: imageKey(ALT, 'singani-el-portillo-2025.jpg'), alt: 'Botella de Singani El Portillo 2025', isCover: true }],
      },
    })
    createRequest(state, at(1, 16), portillo, { quantity: 500, notes: 'Queremos ofrecer más botellas antes de la feria de noviembre.', confirm: true }, member(state, 'altos_admin'))
  }

  // 4. Recorrido H3: lote nuevo en origen y su preventa publicada.
  createLot(
    state,
    { ...at(6, 14), actor: member(state, 'cvj_admin') },
    CVJ,
    { name: PREVENTA_CASE.name, harvestYear: Number(ctx.today.slice(0, 4)), productType: 'SINGANI', estimatedBottles: 3000, plannedFormatCl: 75, targetAbvPercent: 40, plannedTerroirIds: [uid('terroir:cvj_04')], notes: 'Lote de la preventa de 2026.' },
    { id: PREVENTA_CASE.lotId },
  )
  runPreventaCase(state, ctx)

  // Relleno `chain.anchor.backfill`: el expediente cerrado en H2 queda anclado.
  anchorCertifiedLots(state, ctx)

  // 5. Bandeja: una solicitud en revisión, otra con cambios pedidos, una retirada y una rechazada.
  const molino = state.lots.find((l) => l.wineryId === CVJ && l.name === 'Singani El Molino 2026')
  if (molino) {
    const owner = member(state, 'cvj_admin')
    const first = createRequest(state, at(15, 15), molino, { quantity: 1400, confirm: true }, owner)
    withdrawRequest(state, at(14, 10), first, 'Me equivoqué de cantidad: queremos empezar con menos botellas.', owner)
    const second = createRequest(
      state,
      at(2, 17),
      molino,
      {
        quantity: 400,
        commercial: {
          name: 'Singani El Molino 2026',
          description: 'Singani joven de la parcela El Molino, destilado en septiembre de 2026 y en reposo hasta marzo de 2027.',
          tastingNotes: 'Aromas de flor blanca y pera; fresco y directo.',
          imageKeys: [{ key: imageKey(CVJ, 'singani-el-molino-2026.jpg'), alt: 'Alambique de cobre de la destilería', isCover: true }],
        },
        notes: 'Preventa para el club de la destilería.',
        confirm: true,
      },
      owner,
    )
    takeRequest(state, at(1, 14), second, DEMO_REVIEWERS.operations)
    addRequestNote(state, at(1, 14, 30), second, 'La destilación sigue abierta: revisar la fecha estimada de canje antes de aprobar.', DEMO_REVIEWERS.operations)
  }
  const angostura = state.lots.find((l) => l.wineryId === ALT && l.name === 'Tannat La Angostura 2024')
  if (angostura) {
    const request = createRequest(state, at(6, 11), angostura, { quantity: 1200, commercial: { name: 'Tannat La Angostura 2024', description: 'Tannat de la parcela La Angostura, con doce meses de crianza en roble.' }, confirm: true }, member(state, 'altos_admin'))
    takeRequest(state, at(5, 10), request, DEMO_REVIEWERS.analyst)
    requestChanges(state, at(5, 10, 40), request, 'Falta la foto de portada de la colección.', ['commercial.imageKeys'], DEMO_REVIEWERS.analyst)
  }
  const uriondo = state.lots.find((l) => l.wineryId === CUR && l.name === 'Singani Casa Uriondo 2025')
  const uriondoOwner = actorOfMember(state, state.wineries.find((w) => w.id === CUR)?.members?.find((m) => m.memberRole === 'OWNER')?.id)
  if (uriondo && uriondoOwner) {
    const request = createRequest(state, at(30, 12), uriondo, { quantity: 300, commercial: { name: 'Singani Casa Uriondo 2025', description: 'Singani de Casa Uriondo de la vendimia 2025.' }, confirm: true }, uriondoOwner)
    takeRequest(state, at(29, 10), request, DEMO_REVIEWERS.operations)
    rejectRequest(state, at(28, 16), request, 'La bodega tiene documentación pendiente; podrá volver a pedirlo cuando se regularice.', DEMO_REVIEWERS.operations)
  }

  // 5 bis. El `slug` es único por bodega: Altos tiene su propia «Singani Preventa 2026» (mismo
  // `slug` que la de Cinti Viejo), en origen, con precio y publicada.
  if (state.wineries.some((w) => w.id === ALT)) {
    const owner = member(state, 'altos_admin')
    const lot = createLot(
      state,
      { ...at(4, 10), actor: owner },
      ALT,
      { name: SAME_SLUG_CASE.name, harvestYear: Number(ctx.today.slice(0, 4)), productType: 'SINGANI', estimatedBottles: 800, plannedFormatCl: 75, targetAbvPercent: 40, notes: 'Primera preventa de singani de la bodega.' },
      { id: SAME_SLUG_CASE.lotId },
    )
    const request = createRequest(
      state,
      at(4, 11),
      lot,
      {
        quantity: SAME_SLUG_CASE.quota,
        commercial: {
          name: SAME_SLUG_CASE.name,
          description: 'Preventa del singani de altura de Bodega Altos de Calamuchita: Moscatel de Alejandría de la vendimia 2026, destilado en la propia bodega.',
          tastingNotes: 'Flores blancas y fruta de carozo; boca fresca, de final limpio.',
          imageKeys: [{ key: imageKey(ALT, 'singani-preventa-2026.jpg'), alt: 'Botella de Singani Preventa 2026 de Altos de Calamuchita', isCover: true }],
        },
        confirm: true,
      },
      owner,
    )
    takeRequest(state, at(3, 10), request, DEMO_REVIEWERS.analyst)
    const approved = at(3, 11)
    const { collection } = approveRequest(state, approved, request, { price: { amountMinor: SAME_SLUG_CASE.priceMinor, currency: 'BOB' }, reason: 'Datos completos' }, DEMO_REVIEWERS.analyst)
    settle(approved)
    publishCollection(state, at(3, 12), collection, DEMO_REVIEWERS.analyst, 'Apertura de la preventa')
  }

  // Los hechos de tokenización de los lotes ya avanzados se sembraron después que su trazabilidad:
  // la línea de tiempo de cada lote queda en orden cronológico.
  resequenceLotEvents(state, [caseLot?.id, portillo?.id].filter((id): id is string => Boolean(id)))

  // 6. Cierres de las colecciones de lotes ya embotellados (sin faltante).
  for (const collection of chain.collections) closureOf(state, at(0, 6), collection)

  // 7. Conciliaciones y alertas: una diferencia antigua ya resuelta, un aviso abierto y dos ejecuciones limpias.
  const old = at(10, 6, 30)
  chain.platform.anchorBalanceXlm = '4.2000000'
  const run = runReconciliation(state, old, { scope: 'ALL', depth: 'FULL' }, 'SCHEDULED')
  chain.platform.anchorBalanceXlm = '99.9998800'
  const low = chain.alerts.find((a) => a.runId === run.id)
  if (low) Object.assign(low, { resolvedAt: at(10, 13).now, resolution: { by: DEMO_REVIEWERS.admin.fullName, note: 'Cuenta de anclaje recargada con Friendbot.', auto: false } })
  // Una diferencia que la propia conciliación abre y cierra: hace seis días al contrato de Cinti Viejo
  // le quedaban 12 días de vida (`TTL_EXPIRING`); la tarea de TTL lo alargó esa madrugada
  // (`EXTEND_TTL`) y la ejecución siguiente cerró sola la alerta (`resolution.auto`).
  runReconciliation(state, at(6, 6, 30), { scope: 'ALL', depth: 'FULL' }, 'SCHEDULED')
  const extension = at(5, 7)
  extendTtl(state, extension, { wineryId: CVJ })
  extendTtl(state, { ...extension, now: isoSeconds(Date.parse(extension.now) + 60_000) }, 'CODE')
  settle(extension)
  runReconciliation(state, at(5, 10, 30), { scope: 'ALL', depth: 'FULL' }, 'SCHEDULED')
  // La tarea de TTL avisó hace dos días del contrato de Altos (sigue abierta: nadie lo ha alargado).
  raiseAlert(state, at(2, 7), {
    code: 'TTL_EXPIRING',
    level: 'WARNING',
    subject: { type: 'CONTRACT', id: identityOf(chain, ALT)?.contract?.address ?? ALT },
    wineryId: ALT,
    message: 'Entradas del contrato de Bodega Altos de Calamuchita con menos de 14 días de vida y sin extensión en curso',
    expected: { minDays: 14 },
    actual: { days: 11 },
  })
  runReconciliation(state, at(0, 6, 30), { scope: 'ALL', depth: 'FULL' }, 'SCHEDULED')
  runReconciliation(state, at(0, 11), { scope: 'ALL', depth: 'LIGHT' }, 'SCHEDULED')
  resequenceLedgers(chain)
  // La extensión del código lo dejó con 30 días más; el día de referencia le quedan 96.
  chain.ttl.code = daysFrom(ctx, 96)
  chain.indexer = { lastLedger: chain.ledger, lagSeconds: chain.indexer.lagSeconds }
  // Los avisos de la semilla no se envían: el buzón de los fixtures es el de la Ola 1.
  chain.notices = []
}

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

const TOKENIZATION_EVENT_TYPES = ['TOKENIZATION_AUTHORIZED', 'NFT_MINTED', 'COLLECTION_PUBLISHED', 'TOKENS_REDEEMABLE', 'SHORTFALL_DETECTED']

function dropTransactions(chain: ChainState, ids: ReadonlySet<string>): void {
  chain.transactions = chain.transactions.filter((t) => !ids.has(t.id))
  chain.events = chain.events.filter((e) => !e.matchedTransactionId || !ids.has(e.matchedTransactionId))
  chain.alerts = chain.alerts.filter((a) => !ids.has(a.subject.id))
  for (const id of ids) delete chain.due[id]
}

/** Quita la tokenización de un lote (solicitudes, colección, emisiones, NFT y cierre), como si nunca se hubiera pedido. */
export function purgeLotTokenization(state: TraceState, lotId: string): void {
  const chain = state.chain
  const collection = collectionOfLot(chain, lotId)
  const mintIds = new Set(chain.mints.filter((m) => m.collectionId === collection?.id).flatMap((m) => m.txIds))
  for (const t of chain.tokens) if (t.lotId === lotId && t.burnTxId) mintIds.add(t.burnTxId)
  dropTransactions(chain, mintIds)
  chain.requests = chain.requests.filter((r) => r.lotId !== lotId)
  chain.mints = chain.mints.filter((m) => m.collectionId !== collection?.id)
  chain.tokens = chain.tokens.filter((t) => t.lotId !== lotId)
  chain.closures = chain.closures.filter((c) => c.lotId !== lotId)
  chain.collections = chain.collections.filter((c) => c.lotId !== lotId)
  chain.alerts = chain.alerts.filter((a) => a.subject.id !== collection?.id)
  state.lotEvents = state.lotEvents.filter((e) => e.lotId !== lotId || !TOKENIZATION_EVENT_TYPES.includes(e.type))
}

/** Quita el anclaje de un lote: vuelve a `CERTIFIED` (o a la etapa que le toque) sin transacción de anclaje. */
export function purgeLotAnchor(state: TraceState, ctx: TraceCtx, lotId: string): void {
  const chain = state.chain
  const anchor = chain.anchors.find((a) => a.lotId === lotId)
  if (!anchor) return
  dropTransactions(chain, new Set([anchor.txId]))
  chain.anchors = chain.anchors.filter((a) => a.lotId !== lotId)
  state.lotEvents = state.lotEvents.filter((e) => e.lotId !== lotId || (e.type !== 'DOSSIER_ANCHORED' && e.type !== 'TOKENS_REDEEMABLE'))
  const collection = collectionOfLot(chain, lotId)
  if (collection) collection.redeemableSince = null
  const bottling = lotBottling(state, lotId)
  if (bottling) Object.assign(bottling, { isAnchoredOnChain: false, blockchainAnchorTxHash: null, anchoredAt: null })
  const lot = state.lots.find((l) => l.id === lotId)
  if (lot) refreshLotStage(state, ctx, lot)
}

export const CHAIN_SCENARIOS = [
  'identidad-preparandose',
  'emision-en-curso',
  'emision-fallida',
  'anclaje-pendiente',
  'faltante-botellas',
  'alerta-evento-inesperado',
  'cambios-pedidos',
  // 0.6.0-rc.2
  'faltante-vendidos',
  'identidad-sin-aprovisionar',
  'cadena-sin-configurar',
] as const
export type ChainScenarioName = (typeof CHAIN_SCENARIOS)[number]

/** Botellas que faltan en los escenarios `faltante-botellas` y `faltante-vendidos`. */
export const SHORTFALL_SCENARIO_BOTTLES = 20
/** NFT que quedan sin vender en `faltante-vendidos`: el resto del faltante son NFT **vendidos** sin botella. */
export const SHORTFALL_SCENARIO_UNSOLD = 10

/** Deja una bodega sin identidad en la red (`NOT_PROVISIONED`): sin cuenta, sin contrato y sin nada emitido. */
function dropIdentity(state: TraceState, wineryId: string): void {
  const chain = state.chain
  for (const lot of state.lots) if (lot.wineryId === wineryId && (collectionOfLot(chain, lot.id) || chain.requests.some((r) => r.lotId === lot.id))) purgeLotTokenization(state, lot.id)
  const identity = identityOf(chain, wineryId)
  const txIds = new Set(chain.transactions.filter((t) => t.wineryId === wineryId).map((t) => t.id))
  for (const id of [identity?.accountTxId, identity?.contractTxId]) if (id) txIds.add(id)
  if (identity?.contract) {
    delete chain.ttl.contracts[identity.contract.address]
    chain.events = chain.events.filter((e) => e.contractAddress !== identity.contract!.address)
    chain.alerts = chain.alerts.filter((a) => a.subject.id !== identity.contract!.address)
  }
  dropTransactions(chain, txIds)
  chain.identities = chain.identities.filter((i) => i.wineryId !== wineryId)
  chain.alerts = chain.alerts.filter((a) => a.wineryId !== wineryId)
}

/**
 * Deja la base (recién cargada de los fixtures) en la situación del escenario. Las transacciones
 * que quedan en vuelo avanzan después con el reloj de la red (`mockChain.advance()`, o solas en el
 * navegador).
 */
export function applyChainScenario(state: TraceState, ctx: ChainCtx, name: ChainScenarioName): void {
  const chain = state.chain
  const ALT = uid('winery:altos')
  switch (name) {
    case 'identidad-preparandose': {
      // Altos recién activada: su cuenta y su contrato aún se están creando (aprobar → TOK_WINERY_CHAIN_NOT_READY).
      for (const lot of state.lots) if (lot.wineryId === ALT && collectionOfLot(chain, lot.id)) purgeLotTokenization(state, lot.id)
      const identity = identityOf(chain, ALT)
      dropTransactions(chain, new Set([identity?.accountTxId, identity?.contractTxId].filter((id): id is string => Boolean(id))))
      chain.identities = chain.identities.filter((i) => i.wineryId !== ALT)
      chain.alerts = chain.alerts.filter((a) => a.wineryId !== ALT)
      provisionIdentity(state, ctx, ALT, null)
      advanceChain(state, ctx)
      return
    }
    case 'identidad-sin-aprovisionar':
      // Altos sigue `ACTIVE` pero el relleno de identidades aún no la alcanzó: `NOT_PROVISIONED`, sin
      // transacciones en vuelo. Operaciones la aprovisiona con `chain/provision`.
      dropIdentity(state, ALT)
      return
    case 'cadena-sin-configurar':
      // El entorno no tiene la cadena configurada: provision, pause y unpause → 409 `CHN_DISABLED`.
      dropIdentity(state, ALT)
      chain.enabled = false
      return
    case 'emision-en-curso':
    case 'emision-fallida':
      purgeLotTokenization(state, PREVENTA_CASE.lotId)
      runPreventaCase(state, ctx, { upTo: 'IN_REVIEW', submittedDaysAgo: 3 })
      if (name === 'emision-fallida') chain.forcedFailures.push({ kind: 'MINT_BATCH', code: 'CHN_AUTH_FAILED' })
      approveRequest(state, ctx, chain.requests.find((r) => r.lotId === PREVENTA_CASE.lotId)!, { reason: 'Datos completos; precio por anunciar' }, DEMO_REVIEWERS.operations)
      if (name === 'emision-fallida') settleChain(state, ctx)
      else advanceChain(state, ctx)
      return
    case 'anclaje-pendiente': {
      const lot = state.lots.find((l) => l.id === SINGANI_CASE.lotId)
      if (!lot) return
      purgeLotAnchor(state, ctx, lot.id)
      anchorDossier(state, ctx, lot)
      return
    }
    case 'faltante-botellas':
    case 'faltante-vendidos': {
      // Se autorizó sobre la estimación y se embotelló menos: 20 NFT sin botella.
      const lot = state.lots.find((l) => l.wineryId === ALT && l.name === 'Singani El Portillo 2025')
      if (!lot) return
      const bottles = bottleCodesSummary(bottleLotOf(state, lot.id)).active
      purgeLotTokenization(state, lot.id)
      const collection = seedCollection(state, ctx, {
        lot,
        owner: member(state, 'altos_admin'),
        quantity: bottles + SHORTFALL_SCENARIO_BOTTLES,
        daysAgo: 9,
        publish: true,
        commercial: {
          name: 'Singani El Portillo 2025',
          description: 'Singani de altura de la parcela El Portillo de Bodega Altos de Calamuchita, embotellado en 2025 tras su reposo en acero.',
          imageKeys: [{ key: imageKey(ALT, 'singani-el-portillo-2025.jpg'), alt: 'Botella de Singani El Portillo 2025', isCover: true }],
        },
      })
      // `faltante-vendidos`: la preventa se vendió casi entera; quedan 10 NFT sin vender, así que
      // otros 10 **vendidos** se quedan sin botella (devolución o sustitución, ítem a ítem).
      if (name === 'faltante-vendidos') sellDemoTokens(state, ctx, collection, bottles + SHORTFALL_SCENARIO_BOTTLES - SHORTFALL_SCENARIO_UNSOLD)
      closureOf(state, ctx, collection)
      return
    }
    case 'alerta-evento-inesperado': {
      // Un `role_granted` que no pidió el sistema en el contrato de Cinti Viejo.
      const identity = identityOf(chain, PREVENTA_CASE.wineryId)
      if (!identity?.contract) return
      chain.ledger += 3
      const intruder = mockAccountAddress('scenario:unexpected-account')
      const event = recordChainEvent(state, ctx, { contractAddress: identity.contract.address, wineryId: identity.wineryId, type: 'role_granted', tx: null, txHash: mockTxHash('scenario:unexpected-event'), data: { role: 'minter', account: intruder, caller: identity.accountAddress } })
      raiseAlert(state, ctx, {
        code: 'UNEXPECTED_EVENT',
        level: 'CRITICAL',
        subject: { type: 'CHAIN_EVENT', id: event.id },
        wineryId: identity.wineryId,
        message: 'Evento `role_granted` en el contrato de Destilería Cinti Viejo que no originó el sistema',
        expected: null,
        actual: { type: 'role_granted', role: 'minter', account: intruder, txHash: event.txHash },
      })
      return
    }
    case 'cambios-pedidos':
      purgeLotTokenization(state, PREVENTA_CASE.lotId)
      runPreventaCase(state, ctx, { upTo: 'CHANGES_REQUESTED', submittedDaysAgo: 2 })
      return
  }
}

/** Entorno de la semilla: perfiles y configuración de los fixtures del back office. */
export function seedChainEnv(
  state: Pick<TraceState, 'wineries'>,
  profiles: readonly { wineryId: string; slug: string; lotPrefix: string | null }[],
  settings: readonly { key: string; value: unknown }[],
  overrides: readonly { key: string; wineryId: string; value: unknown }[],
  urls: { publicApiBaseUrl: string; homeDomain: string },
): ChainEnv {
  return {
    winery(wineryId) {
      const w = state.wineries.find((x) => x.id === wineryId)
      const p = profiles.find((x) => x.wineryId === wineryId)
      return { id: wineryId, slug: p?.slug ?? wineryId, tradeName: w?.commercialName ?? 'Bodega', lotPrefix: p?.lotPrefix ?? 'DOC', status: w?.certificationStatus ?? 'INVITED' }
    },
    setting: (key, wineryId) => (overrides.find((o) => o.key === key && o.wineryId === wineryId) ?? settings.find((s) => s.key === key))?.value,
    ...urls,
  }
}
