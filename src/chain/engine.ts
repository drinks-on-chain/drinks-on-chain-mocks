import type { CertificationStatus } from '../erp/schemas'
import { appendLotEvent, lotBottling, refreshLotStage, type TraceCtx, type TraceState } from '../erp/trace/state'
import { mockTxHash } from '../shared/strkey'
import { uid } from '../shared/uuid'
import type { ChainAlert, ChainAlertLevel, ChainEvent, ChainSubject, ChainTransaction, ChainTxKind, ChainTxStatus } from './schemas'
import { collectionOfLot, identityOf, mintsOf, pushNotice, tokensOf, TTL_EXTENSION_DAYS, txById, type ChainState, type ForcedChainFailure, type StoredCollection, type StoredToken } from './state'
import { explorerTxUrl, isTxInFlight } from './views'

// Red simulada de la Ola 3 (contrato §2.3): las rutas registran intenciones y un «worker» las hace
// avanzar `PENDING → BUILDING → SUBMITTED → CONFIRMED` con el reloj de la red (`ChainState.elapsedMs`),
// que se controla desde fuera (`advanceChain`, `settleChain`). Al confirmarse, cada tipo de
// transacción aplica sus efectos en la misma «transacción de base de datos»: la emisión crea los
// NFT, el anclaje pasa el lote a `ANCHORED`, la identidad queda `ACTIVE`… Funciones puras sobre el
// estado: las usan los handlers y el generador de fixtures.

/** Lo que el dominio necesita saber de una bodega (perfil de la Ola 1). */
export interface ChainWineryInfo {
  id: string
  slug: string
  tradeName: string
  lotPrefix: string
  status: CertificationStatus
}

/** Entorno de la operación: bodegas, configuración efectiva y bases de las URL públicas. */
export interface ChainEnv {
  winery(wineryId: string): ChainWineryInfo
  /** Valor efectivo de un parámetro de configuración para una bodega (o el global). */
  setting(key: string, wineryId: string | null): unknown
  /** `PUBLIC_API_BASE_URL`: base de `token_uri` y de las imágenes públicas. */
  publicApiBaseUrl: string
  /** `STELLAR_HOME_DOMAIN`. */
  homeDomain: string
}

export type ChainCtx = TraceCtx & { env: ChainEnv }

/** Lo que tarda cada paso de una transacción en la red simulada (ms del reloj de la red). */
export const CHAIN_STEP_MS = 3000

/** Errores transitorios (contrato §2.3): pasan por `RETRYING` y se reintenta solo. */
export const TRANSIENT_CHAIN_ERRORS = ['CHN_RPC_UNAVAILABLE', 'CHN_TX_TIMEOUT', 'CHN_BAD_SEQUENCE', 'CHN_INSUFFICIENT_FEE', 'CHN_TRY_AGAIN_LATER', 'CHN_ARCHIVED_ENTRY'] as const

const ERROR_MESSAGES: Record<string, string> = {
  CHN_RPC_UNAVAILABLE: 'El RPC de la red no respondió',
  CHN_TX_TIMEOUT: 'La transacción no entró en un ledger a tiempo',
  CHN_BAD_SEQUENCE: 'Número de secuencia en conflicto',
  CHN_INSUFFICIENT_FEE: 'Comisión insuficiente',
  CHN_TRY_AGAIN_LATER: 'La red pidió reintentar más tarde',
  CHN_ARCHIVED_ENTRY: 'Una entrada del contrato está archivada',
  CHN_CONTRACT_ERROR: 'El contrato rechazó la operación',
  CHN_AUTH_FAILED: 'La firma de autorización no es válida',
  CHN_INSUFFICIENT_BALANCE: 'La cuenta de operaciones no tiene saldo suficiente',
  CHN_INTENT_REJECTED: 'La intención no cuadra con la base de datos: no se firmó',
  CHN_MINT_DISABLED: 'La emisión está desactivada en este entorno (CHAIN_MINT_ENABLED)',
  CHN_WINERY_NOT_ACTIVE: 'La bodega no está activa: la emisión espera a que se reactive',
}

/** Códigos con los que una emisión espera en `PENDING` sin fallar (se reanuda sola al desaparecer la causa). */
export const MINT_HOLD_CODES = ['CHN_MINT_DISABLED', 'CHN_WINERY_NOT_ACTIVE'] as const

/** Comisión simulada por tipo (stroops), del orden de `docs/costes.md` del repo de contratos. */
const FEES: Partial<Record<ChainTxKind, number>> = {
  CREATE_WINERY_ACCOUNT: 200,
  DEPLOY_WINERY_CONTRACT: 2_150_000,
  MINT_BATCH: 70_000,
  ANCHOR_DOSSIER: 100,
  PAUSE_CONTRACT: 65_000,
  UNPAUSE_CONTRACT: 65_000,
  BURN_UNSOLD: 80_000,
  EXTEND_TTL: 420_000,
}
/** Extender el código cuesta ≈ 6,5 XLM por 30 días (precisiones de la apertura): tope propio de esa intención. */
const EXTEND_CODE_FEE = 65_000_000
const EXTEND_CODE_MAX_FEE = '100000000'
const FIRST_MINT_FEE = 1_389_000

/** Stroops → XLM con 7 decimales (`"0.1389000"`). */
export function stroopsToXlm(stroops: number | string): string {
  const n = BigInt(stroops)
  return `${n / 10_000_000n}.${String(n % 10_000_000n).padStart(7, '0')}`
}

// ---------------------------------------------------------------------------
// Intenciones
// ---------------------------------------------------------------------------

export interface TxInput {
  kind: ChainTxKind
  /** Clave única de la intención: registrarla dos veces no crea otra transacción. */
  intentKey: string
  subject: ChainSubject
  wineryId: string | null
  /** Parámetros validados (solo identificadores de dominio; sin secretos). */
  intent: Record<string, unknown>
  requestedBy?: { userId: string | null; fullName: string | null; source: 'API' | 'WORKER' }
}

const WINERY_SIGNED: ChainTxKind[] = ['CREATE_WINERY_ACCOUNT', 'MINT_BATCH', 'SET_TOKEN_URI_BASE', 'UNPAUSE_CONTRACT']

/** Registra una intención (outbox): devuelve su transacción en `PENDING` (o la que ya existía con esa `intentKey`). */
export function enqueueTx(state: TraceState, ctx: ChainCtx, input: TxInput): ChainTransaction {
  const chain = state.chain
  const existing = chain.transactions.find((t) => t.intentKey === input.intentKey)
  if (existing) return existing
  const anchor = input.kind === 'ANCHOR_DOSSIER'
  const wineryAccount = input.wineryId ? identityOf(chain, input.wineryId)?.accountAddress : null
  const tx: ChainTransaction = {
    id: ctx.newId('chain-tx'),
    kind: input.kind,
    status: 'PENDING',
    network: chain.network,
    txHash: null,
    explorerUrl: null,
    ledger: null,
    confirmedAt: null,
    attempts: 0,
    lastError: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    intentKey: input.intentKey,
    subject: input.subject,
    wineryId: input.wineryId,
    intent: input.intent,
    sourceAccount: anchor ? chain.platform.anchorAddress : chain.platform.operationsAddress,
    signers: [
      anchor
        ? { role: 'ANCHOR', address: chain.platform.anchorAddress, wineryId: null }
        : { role: 'OPERATIONS', address: chain.platform.operationsAddress, wineryId: null },
      ...(WINERY_SIGNED.includes(input.kind) && wineryAccount ? [{ role: 'WINERY' as const, address: wineryAccount, wineryId: input.wineryId }] : []),
    ],
    feeChargedStroops: null,
    rentFeeStroops: null,
    maxFeeStroops: input.kind === 'EXTEND_TTL' && input.intent.target === 'CODE' ? EXTEND_CODE_MAX_FEE : '10000000',
    result: null,
    history: [{ attempt: 1, status: 'PENDING', at: ctx.now, txHash: null, sequence: null, errorCode: null, detail: null }],
    nextAttemptAt: null,
    requestedBy: input.requestedBy ?? { userId: null, fullName: null, source: 'WORKER' },
    abandoned: null,
    correlationId: null,
  }
  chain.transactions.push(tx)
  chain.due[tx.id] = chain.elapsedMs + CHAIN_STEP_MS
  return tx
}

function setStatus(tx: ChainTransaction, ctx: ChainCtx, status: ChainTxStatus, errorCode: string | null = null, detail: string | null = null): void {
  tx.status = status
  tx.updatedAt = ctx.now
  tx.history.push({ attempt: Math.max(1, tx.attempts), status, at: ctx.now, txHash: tx.txHash, sequence: tx.txHash ? String(parseInt(tx.txHash.slice(0, 10), 16)) : null, errorCode, detail })
}

/** Abre una alerta (la conciliación y los fallos de transacción). */
export function raiseAlert(
  state: TraceState,
  ctx: ChainCtx,
  input: { code: string; level: ChainAlertLevel; subject: { type: string; id: string }; wineryId: string | null; message: string; expected?: unknown; actual?: unknown; runId?: string | null },
): ChainAlert {
  const alert: ChainAlert = {
    id: ctx.newId('chain-alert'),
    code: input.code,
    level: input.level,
    subject: input.subject,
    wineryId: input.wineryId,
    expected: (input.expected ?? null) as ChainAlert['expected'],
    actual: (input.actual ?? null) as ChainAlert['actual'],
    message: input.message,
    runId: input.runId ?? null,
    detectedAt: ctx.now,
    resolvedAt: null,
    resolution: null,
  }
  state.chain.alerts.push(alert)
  // §11: las alertas `CRITICAL` se avisan por correo a operaciones.
  if (alert.level === 'CRITICAL') pushNotice(state.chain, { at: ctx.now, type: 'ALERT_CRITICAL', wineryId: alert.wineryId, alertId: alert.id, message: alert.message, data: { code: alert.code } })
  return alert
}

/** Temas del evento tal como los emite el contrato (el nombre y sus argumentos indexados). */
function eventTopics(type: string, data: Record<string, unknown>): string[] {
  const topic = (key: string) => (data[key] === undefined || data[key] === null ? [] : [String(data[key])])
  switch (type) {
    case 'role_granted':
    case 'role_revoked':
      return [type, ...topic('role'), ...topic('account')]
    case 'consecutive_mint':
      return [type, ...topic('to')]
    case 'lot_minted':
      return [type, ...topic('lot'), ...topic('to')]
    case 'transfer':
      return [type, ...topic('from'), ...topic('to')]
    case 'burn':
      return [type, ...topic('from')]
    default:
      return [type]
  }
}

/** Evento de contrato que registra el indexador. */
export function recordChainEvent(
  state: TraceState,
  ctx: ChainCtx,
  input: { contractAddress: string; wineryId: string | null; type: string; data: Record<string, unknown>; tx: ChainTransaction | null; txHash?: string; ledger?: number },
): ChainEvent {
  const chain = state.chain
  const ledger = input.tx?.ledger ?? input.ledger ?? chain.ledger
  const index = chain.events.filter((e) => e.ledger === ledger).length
  const event: ChainEvent = {
    id: ctx.newId('chain-event'),
    rpcEventId: `${String(ledger).padStart(10, '0')}-${String(index).padStart(10, '0')}`,
    network: chain.network,
    contractAddress: input.contractAddress,
    wineryId: input.wineryId,
    ledger,
    ledgerClosedAt: ctx.now,
    txHash: input.tx?.txHash ?? input.txHash ?? mockTxHash(`event:${ledger}:${index}`),
    type: input.type,
    topics: eventTopics(input.type, input.data),
    data: input.data,
    matchedTransactionId: input.tx?.id ?? null,
    originatedBySystem: input.tx !== null,
    processedAt: ctx.now,
  }
  chain.events.push(event)
  chain.indexer.lastLedger = Math.max(chain.indexer.lastLedger, ledger)
  return event
}

// ---------------------------------------------------------------------------
// Efectos al confirmar o fallar
// ---------------------------------------------------------------------------

/** ¿Se puede publicar la colección ahora? Devuelve el motivo que lo impide o `null`. */
export function publishBlocker(state: TraceState, ctx: ChainCtx, collection: StoredCollection): { code: string; message: string; meta?: Record<string, unknown> } | null {
  const chain = state.chain
  const last = mintsOf(chain, collection.id).at(-1)
  if (!last || last.status !== 'CONFIRMED') {
    return { code: 'TOK_MINT_NOT_CONFIRMED', message: 'La emisión de la colección aún no está confirmada en la red', meta: { mintStatus: last?.status ?? 'PENDING' } }
  }
  const winery = ctx.env.winery(collection.wineryId)
  if (winery.status !== 'ACTIVE') return { code: 'TOK_WINERY_NOT_ACTIVE', message: 'La bodega no está activa', meta: { status: winery.status } }
  if (identityOf(chain, collection.wineryId)?.contract?.paused) return { code: 'CHN_CONTRACT_PAUSED', message: 'El contrato de la bodega está pausado en la red' }
  return null
}

/** Cambia el estado comercial de una colección y lo deja en su historial. */
export function setCollectionStatus(collection: StoredCollection, ctx: ChainCtx, status: StoredCollection['status'], by: string, reason: string | null): void {
  collection.status = status
  collection.updatedAt = ctx.now
  if (status === 'PUBLISHED' && !collection.publishedAt) collection.publishedAt = ctx.now
  if (status === 'CLOSED') collection.closedAt = ctx.now
  collection.statusHistory.push({ status, at: ctx.now, by, reason })
}

function lotOf(state: TraceState, lotId: string) {
  const lot = state.lots.find((l) => l.id === lotId)
  if (!lot) throw new Error(`Red simulada: el lote ${lotId} no existe`)
  return lot
}

function confirmMint(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): void {
  const chain = state.chain
  const mint = chain.mints.find((m) => m.id === tx.intent.mintId)
  const collection = mint && chain.collections.find((c) => c.id === mint.collectionId)
  const identity = collection && identityOf(chain, collection.wineryId)
  if (!mint || !collection || !identity?.contract || !identity.accountAddress) throw new Error('Red simulada: emisión sin colección o sin contrato')
  const amount = Number(tx.intent.amount)
  if (takeMismatch(chain, 'MINT_BATCH')) {
    // El valor devuelto y `lot_minted` no cuadran con lo pedido: no se registran los NFT ni se publica nada.
    mint.status = 'FAILED'
    tx.result = { returnValue: null, contractEvents: ['consecutive_mint'] }
    raiseAlert(state, ctx, {
      code: 'MINT_RANGE_MISMATCH',
      level: 'CRITICAL',
      subject: { type: 'MINT', id: mint.id },
      wineryId: collection.wineryId,
      message: 'La emisión se confirmó en la red pero su rango no cuadra: sin evento. No se registran sus NFT ni se publica la colección',
      expected: { amount, lot: mint.lotArg, to: identity.accountAddress },
      actual: { returnValue: null, event: null, txHash: tx.txHash },
    })
    return
  }
  // Ids `u32` continuos entre los lotes del mismo contrato (DS-08).
  const firstTokenId = chain.tokens.filter((t) => t.wineryId === collection.wineryId).length
  const firstBottleNumber = tokensOf(chain, collection.id).length + 1
  for (let i = 0; i < amount; i++) {
    const token: StoredToken = {
      id: uid(`token:${identity.contract.address}:${firstTokenId + i}`),
      collectionId: collection.id,
      wineryId: collection.wineryId,
      lotId: collection.lotId,
      tokenId: firstTokenId + i,
      bottleNumber: firstBottleNumber + i,
      status: 'MINTED',
      owner: { kind: 'WINERY', address: identity.accountAddress },
      mintId: mint.id,
      mintTxId: tx.id,
      soldAt: null,
      redeemableAt: null,
      redeemWindowEndsAt: null,
      burnedAt: null,
      burnTxId: null,
      burnReason: null,
      onchain: { owner: identity.accountAddress, burned: false, checkedAt: ctx.now },
    }
    chain.tokens.push(token)
  }
  const range = { firstTokenId, lastTokenId: firstTokenId + amount - 1, firstBottleNumber, lastBottleNumber: firstBottleNumber + amount - 1 }
  mint.ranges.push(range)
  tx.result = { returnValue: range.lastTokenId, contractEvents: ['consecutive_mint', 'lot_minted'] }
  const contract = identity.contract.address
  recordChainEvent(state, ctx, { contractAddress: contract, wineryId: collection.wineryId, type: 'consecutive_mint', tx, data: { to: identity.accountAddress, fromTokenId: range.firstTokenId, toTokenId: range.lastTokenId } })
  recordChainEvent(state, ctx, { contractAddress: contract, wineryId: collection.wineryId, type: 'lot_minted', tx, data: { lot: mint.lotArg, to: identity.accountAddress, firstTokenId: range.firstTokenId, lastTokenId: range.lastTokenId, amount } })
  const all = mint.txIds.map((id) => txById(chain, id))
  if (!all.every((t) => t?.status === 'CONFIRMED')) {
    mint.status = 'IN_PROGRESS'
    return
  }
  mint.status = 'CONFIRMED'
  mint.confirmedAt = ctx.now
  collection.updatedAt = ctx.now
  const lot = lotOf(state, collection.lotId)
  appendLotEvent(state, ctx, lot, {
    type: 'NFT_MINTED',
    occurredAt: ctx.now,
    actor: null,
    summary: `${mint.quantity} botellas en preventa`,
    data: { collectionId: collection.id, mintId: mint.id, quantity: mint.quantity, firstBottleNumber: mint.ranges[0]!.firstBottleNumber, lastBottleNumber: range.lastBottleNumber, txHash: tx.txHash },
    resource: { type: 'collection', id: collection.id },
  })
  pushNotice(chain, { at: ctx.now, type: 'NFT_MINTED', wineryId: collection.wineryId, collectionId: collection.id, data: { quantity: mint.quantity, sequence: mint.sequence, contract, txHash: tx.txHash } })
  if (collection.status !== 'MINTING') return
  if (collection.publishOnMint && !publishBlocker(state, ctx, collection)) {
    setCollectionStatus(collection, ctx, 'PUBLISHED', 'Sistema', 'Publicada al confirmarse la emisión')
    pushNotice(chain, { at: ctx.now, type: 'COLLECTION_PUBLISHED', wineryId: collection.wineryId, collectionId: collection.id })
    appendLotEvent(state, ctx, lot, { type: 'COLLECTION_PUBLISHED', occurredAt: ctx.now, actor: null, summary: `Colección «${collection.commercial.name}» publicada`, data: { collectionId: collection.id }, resource: { type: 'collection', id: collection.id } })
  } else setCollectionStatus(collection, ctx, 'READY', 'Sistema', 'Emisión confirmada')
}

function confirmAnchor(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): void {
  const chain = state.chain
  const anchor = chain.anchors.find((a) => a.txId === tx.id)
  if (!anchor) throw new Error('Red simulada: anclaje sin registro')
  const lot = lotOf(state, anchor.lotId)
  // El servidor lee la transacción y comprueba memo y cuenta de origen.
  if (takeMismatch(chain, 'ANCHOR_DOSSIER')) {
    anchor.mismatch = true
    raiseAlert(state, ctx, {
      code: 'ANCHOR_MISMATCH',
      level: 'CRITICAL',
      subject: { type: 'LOT', id: lot.id },
      wineryId: lot.wineryId,
      message: 'La transacción de anclaje se confirmó, pero su memo o su cuenta de origen no son los esperados: el anclaje no se da por bueno',
      expected: { memoHashHex: anchor.memoHashHex, account: chain.platform.anchorAddress },
      actual: { memoHashHex: mockTxHash(`mismatch:${anchor.memoHashHex}`), account: chain.platform.anchorAddress, txHash: tx.txHash },
    })
    return
  }
  anchor.verifiedAt = ctx.now
  refreshLotStage(state, ctx, lot)
  appendLotEvent(state, ctx, lot, {
    type: 'DOSSIER_ANCHORED',
    occurredAt: ctx.now,
    actor: null,
    summary: 'Expediente anclado en la red Stellar',
    data: { txHash: tx.txHash, ledger: tx.ledger, memoHashHex: anchor.memoHashHex, network: chain.network },
    resource: { type: 'lot_dossier', id: lot.id },
  })
  // Campos legados del embotellado (se mantienen hasta H4).
  const bottling = lotBottling(state, lot.id)
  if (bottling) Object.assign(bottling, { isAnchoredOnChain: true, blockchainAnchorTxHash: tx.txHash, anchoredAt: ctx.now })
  const collection = collectionOfLot(chain, lot.id)
  if (!collection) return
  collection.redeemableSince = ctx.now
  collection.updatedAt = ctx.now
  const windowDays = Number(ctx.env.setting('canje.ventanaDias', collection.wineryId) ?? 365) || 365
  const windowEnds = new Date(Date.parse(ctx.now) + windowDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  let redeemable = 0
  for (const token of tokensOf(chain, collection.id)) {
    if (token.status !== 'SOLD') continue
    Object.assign(token, { status: 'REDEEMABLE', redeemableAt: ctx.now, redeemWindowEndsAt: windowEnds })
    redeemable += 1
  }
  appendLotEvent(state, ctx, lot, {
    type: 'TOKENS_REDEEMABLE',
    occurredAt: ctx.now,
    actor: null,
    summary: 'Las botellas de la colección ya se pueden canjear',
    data: { collectionId: collection.id, redeemableTokens: redeemable, windowDays },
    resource: { type: 'collection', id: collection.id },
  })
}

function confirmBurn(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): void {
  const chain = state.chain
  const token = chain.tokens.find((t) => t.id === tx.subject.id)
  if (!token) return
  Object.assign(token, { status: 'BURNED', burnedAt: ctx.now, burnTxId: tx.id, burnReason: 'SHORTFALL', onchain: { owner: null, burned: true, checkedAt: ctx.now } })
  const identity = identityOf(chain, token.wineryId)
  if (identity?.contract) recordChainEvent(state, ctx, { contractAddress: identity.contract.address, wineryId: token.wineryId, type: 'burn', tx, data: { tokenId: token.tokenId, from: identity.accountAddress } })
  const closure = chain.closures.find((c) => c.collectionId === token.collectionId)
  const item = closure?.items.find((i) => i.tokenId === token.tokenId)
  if (!closure || !item) return
  Object.assign(item, { status: 'BURNED', resolvedAt: ctx.now })
  if (closure.status === 'DECIDED' && closure.items.every((i) => i.outcome !== 'PENDING' && i.resolvedAt !== null)) closure.status = 'RESOLVED'
}

function onConfirmed(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): void {
  const chain = state.chain
  const identity = tx.wineryId ? identityOf(chain, tx.wineryId) : null
  switch (tx.kind) {
    case 'CREATE_WINERY_ACCOUNT':
      if (!identity) return
      identity.contractTxId = enqueueTx(state, ctx, {
        kind: 'DEPLOY_WINERY_CONTRACT',
        intentKey: `identity:${identity.wineryId}:contract`,
        subject: { type: 'WINERY', id: identity.wineryId },
        wineryId: identity.wineryId,
        intent: { wineryId: identity.wineryId, wasmHash: chain.platform.wasmHash, name: identity.contract?.name, symbol: identity.contract?.symbol, baseUri: identity.contract?.baseUri },
        requestedBy: tx.requestedBy,
      }).id
      return
    case 'DEPLOY_WINERY_CONTRACT':
      if (!identity?.contract) return
      identity.contract.deployedAt = ctx.now
      identity.status = 'ACTIVE'
      identity.since = ctx.now
      identity.lastError = null
      tx.result = { returnValue: identity.contract.address, contractEvents: ['role_granted', 'base_uri_updated'] }
      recordChainEvent(state, ctx, { contractAddress: identity.contract.address, wineryId: identity.wineryId, type: 'role_granted', tx, data: { role: 'operator', account: chain.platform.operationsAddress, caller: identity.accountAddress } })
      recordChainEvent(state, ctx, { contractAddress: identity.contract.address, wineryId: identity.wineryId, type: 'base_uri_updated', tx, data: { base_uri: identity.contract.baseUri } })
      // Las entradas del contrato nacen con 30 días de vida (§8.3).
      chain.ttl.contracts[identity.contract.address] = plusDays(ctx.now, TTL_EXTENSION_DAYS)
      return
    case 'MINT_BATCH':
      return confirmMint(state, ctx, tx)
    case 'ANCHOR_DOSSIER':
      return confirmAnchor(state, ctx, tx)
    case 'PAUSE_CONTRACT':
    case 'UNPAUSE_CONTRACT': {
      if (!identity?.contract) return
      const paused = tx.kind === 'PAUSE_CONTRACT'
      identity.contract.paused = paused
      identity.status = paused ? 'PAUSED' : 'ACTIVE'
      recordChainEvent(state, ctx, { contractAddress: identity.contract.address, wineryId: identity.wineryId, type: paused ? 'paused' : 'unpaused', tx, data: { caller: paused ? chain.platform.operationsAddress : identity.accountAddress } })
      return
    }
    case 'BURN_UNSOLD':
      return confirmBurn(state, ctx, tx)
    case 'EXTEND_TTL': {
      // La tarea `chain.ttl.extend` (03:00): alarga la vida del código o de las entradas de un contrato.
      const target = String(tx.intent.target ?? 'CODE')
      const days = Number(tx.intent.days ?? TTL_EXTENSION_DAYS)
      const from = (current: string | null | undefined) => (current && current > ctx.now ? current : ctx.now)
      if (target === 'CODE') chain.ttl.code = plusDays(from(chain.ttl.code), days)
      else chain.ttl.contracts[target] = plusDays(from(chain.ttl.contracts[target]), days)
      tx.result = { returnValue: null, contractEvents: [] }
      return
    }
    default:
  }
}

const plusDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** ¿La siguiente confirmación de ese tipo no supera la comprobación del servidor? (la consume). */
function takeMismatch(chain: ChainState, kind: ChainTxKind): boolean {
  const index = chain.forcedMismatches.indexOf(kind)
  if (index < 0) return false
  chain.forcedMismatches.splice(index, 1)
  return true
}

function onFailed(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): void {
  const chain = state.chain
  const error = tx.lastError!
  if (tx.kind === 'MINT_BATCH') {
    const mint = chain.mints.find((m) => m.id === tx.intent.mintId)
    if (mint) mint.status = 'FAILED'
  }
  if (tx.kind === 'CREATE_WINERY_ACCOUNT' || tx.kind === 'DEPLOY_WINERY_CONTRACT') {
    const identity = tx.wineryId ? identityOf(chain, tx.wineryId) : null
    if (identity) Object.assign(identity, { status: 'FAILED', lastError: { code: error.code, message: error.message } })
  }
  // Como el backend: una intención rechazada o una cuenta sin saldo tienen su propio código de alerta.
  raiseAlert(state, ctx, {
    code: error.code === 'CHN_INTENT_REJECTED' ? 'CHN_INTENT_REJECTED' : error.code === 'CHN_INSUFFICIENT_BALANCE' ? 'LOW_BALANCE' : 'TX_FAILED',
    level: ['CHN_AUTH_FAILED', 'CHN_INTENT_REJECTED', 'CHN_INSUFFICIENT_BALANCE'].includes(error.code) ? 'CRITICAL' : 'WARNING',
    subject: { type: 'TRANSACTION', id: tx.id },
    wineryId: tx.wineryId,
    message: `${tx.kind} falló (${error.code}): ${error.message}`,
    expected: 'CONFIRMED',
    actual: { status: 'FAILED', code: error.code, detail: error.message },
  })
}

// ---------------------------------------------------------------------------
// Avance de la red
// ---------------------------------------------------------------------------

function takeFailure(chain: ChainState, tx: ChainTransaction): ForcedChainFailure | null {
  const index = chain.forcedFailures.findIndex((f) => !f.kind || f.kind === tx.kind)
  return index < 0 ? null : chain.forcedFailures.splice(index, 1)[0]!
}

function stepTx(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): void {
  const chain = state.chain
  const scheduled = chain.due[tx.id] ?? chain.elapsedMs
  const next = () => {
    chain.due[tx.id] = scheduled + CHAIN_STEP_MS
  }
  switch (tx.status) {
    case 'PENDING':
    case 'RETRYING':
      if (tx.kind === 'MINT_BATCH') {
        // ADR-011: la intención espera en `PENDING` hasta que se active la emisión; igual con la
        // bodega suspendida o revocada (`CHN_WINERY_NOT_ACTIVE`). No falla ni abre alerta.
        const hold = mintHold(chain, ctx, tx)
        if (hold) {
          tx.status = 'PENDING'
          tx.lastError = { code: hold, message: ERROR_MESSAGES[hold]!, retryable: true }
          tx.updatedAt = ctx.now
          delete chain.due[tx.id]
          return
        }
      }
      tx.attempts += 1
      tx.nextAttemptAt = null
      setStatus(tx, ctx, 'BUILDING')
      return next()
    case 'BUILDING':
      tx.txHash = mockTxHash(`${tx.id}:${tx.attempts}`)
      tx.explorerUrl = explorerTxUrl(tx.txHash)
      setStatus(tx, ctx, 'SUBMITTED')
      return next()
    case 'SUBMITTED': {
      const failure = takeFailure(chain, tx)
      if (failure) {
        const code = failure.code ?? 'CHN_AUTH_FAILED'
        const retryable = (TRANSIENT_CHAIN_ERRORS as readonly string[]).includes(code)
        tx.lastError = { code, message: failure.message ?? ERROR_MESSAGES[code] ?? 'La red rechazó la transacción', retryable }
        if (retryable) {
          tx.nextAttemptAt = new Date(Date.parse(ctx.now) + 10_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
          setStatus(tx, ctx, 'RETRYING', code, tx.lastError.message)
          return next()
        }
        setStatus(tx, ctx, 'FAILED', code, tx.lastError.message)
        delete chain.due[tx.id]
        return onFailed(state, ctx, tx)
      }
      chain.ledger += 1
      tx.ledger = chain.ledger
      tx.confirmedAt = ctx.now
      tx.lastError = null
      const firstMint = tx.kind === 'MINT_BATCH' && !chain.tokens.some((t) => t.wineryId === tx.wineryId)
      const extendCode = tx.kind === 'EXTEND_TTL' && tx.intent.target === 'CODE'
      tx.feeChargedStroops = String(firstMint ? FIRST_MINT_FEE : extendCode ? EXTEND_CODE_FEE : (FEES[tx.kind] ?? 50_000))
      tx.rentFeeStroops = tx.kind === 'ANCHOR_DOSSIER' || tx.kind === 'CREATE_WINERY_ACCOUNT' ? '0' : String(Math.round(Number(tx.feeChargedStroops) * 0.6))
      setStatus(tx, ctx, 'CONFIRMED')
      delete chain.due[tx.id]
      return onConfirmed(state, ctx, tx)
    }
    default:
      delete chain.due[tx.id]
  }
}

/** Motivo por el que una emisión debe esperar ahora, o `null`. */
function mintHold(chain: ChainState, ctx: ChainCtx, tx: ChainTransaction): (typeof MINT_HOLD_CODES)[number] | null {
  if (!chain.mintEnabled) return 'CHN_MINT_DISABLED'
  if (tx.wineryId && ctx.env.winery(tx.wineryId).status !== 'ACTIVE') return 'CHN_WINERY_NOT_ACTIVE'
  return null
}

/** Reanuda las emisiones que esperaban (`CHN_MINT_DISABLED`, `CHN_WINERY_NOT_ACTIVE`) cuando su causa desaparece. */
export function resumeHeldMints(state: TraceState, ctx: ChainCtx): number {
  const chain = state.chain
  let resumed = 0
  for (const tx of chain.transactions) {
    if (tx.kind !== 'MINT_BATCH' || tx.status !== 'PENDING' || chain.due[tx.id] !== undefined) continue
    if (!(MINT_HOLD_CODES as readonly string[]).includes(tx.lastError?.code ?? '') || mintHold(chain, ctx, tx)) continue
    tx.lastError = null
    chain.due[tx.id] = chain.elapsedMs + CHAIN_STEP_MS
    resumed += 1
  }
  return resumed
}

/** Ejecuta los pasos que ya tocan según el reloj de la red. Devuelve cuántos dio. */
export function processChain(state: TraceState, ctx: ChainCtx): number {
  const chain = state.chain
  resumeHeldMints(state, ctx)
  let steps = 0
  while (steps < 100_000) {
    const due = Object.entries(chain.due)
      .filter(([, at]) => at <= chain.elapsedMs)
      .sort((a, b) => a[1] - b[1])[0]
    if (!due) break
    const tx = txById(chain, due[0])
    if (!tx || !isTxInFlight(tx)) {
      delete chain.due[due[0]]
      continue
    }
    stepTx(state, ctx, tx)
    steps += 1
  }
  return steps
}

/** Adelanta el reloj de la red (por defecto, un paso) y procesa lo que toque. */
export function advanceChain(state: TraceState, ctx: ChainCtx, ms: number = CHAIN_STEP_MS): number {
  state.chain.elapsedMs += Math.max(0, ms)
  return processChain(state, ctx)
}

/** Adelanta la red hasta que no quede ninguna transacción en vuelo (confirmadas o fallidas). */
export function settleChain(state: TraceState, ctx: ChainCtx): number {
  const chain = state.chain
  resumeHeldMints(state, ctx)
  let steps = 0
  for (let guard = 0; guard < 10_000; guard++) {
    const pending = Object.values(chain.due)
    if (pending.length === 0) break
    chain.elapsedMs = Math.max(chain.elapsedMs, Math.min(...pending))
    steps += processChain(state, ctx)
  }
  return steps
}

/** ¿Queda alguna transacción avanzando? */
export const hasChainWork = (chain: ChainState): boolean => Object.keys(chain.due).length > 0

/** Reintento manual de una transacción `FAILED` (o reanudación de una emisión en espera): vuelve a `PENDING`. */
export function requeueTx(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): void {
  const chain = state.chain
  tx.lastError = null
  tx.txHash = null
  tx.explorerUrl = null
  setStatus(tx, ctx, 'PENDING')
  chain.due[tx.id] = chain.elapsedMs + CHAIN_STEP_MS
  if (tx.kind === 'MINT_BATCH') {
    const mint = chain.mints.find((m) => m.id === tx.intent.mintId)
    if (mint) mint.status = mint.ranges.length > 0 ? 'IN_PROGRESS' : 'PENDING'
  }
  if (tx.kind === 'CREATE_WINERY_ACCOUNT' || tx.kind === 'DEPLOY_WINERY_CONTRACT') {
    const identity = tx.wineryId ? identityOf(chain, tx.wineryId) : null
    if (identity) Object.assign(identity, { status: 'PROVISIONING', lastError: null })
  }
}

/** Activa o desactiva la emisión (`CHAIN_MINT_ENABLED`); al activarla, las emisiones en espera continúan. */
export function setMintEnabled(state: TraceState, ctx: ChainCtx, enabled: boolean): void {
  state.chain.mintEnabled = enabled
  if (enabled) resumeHeldMints(state, ctx)
}
