import { ApiError } from '../erp/handlers/errors'
import type { Lot } from '../erp/schemas'
import { lotDossier, stateError, type TraceState } from '../erp/trace/state'
import { mockAccountAddress, mockContractAddress } from '../shared/strkey'
import { enqueueTx, raiseAlert, recordChainEvent, requeueTx, type ChainCtx } from './engine'
import type { ChainAlert, ChainTransaction, PlatformAccountStatus, PlatformChainAccounts, ReconciliationRun, ReconciliationRunDetail, StartReconciliation, UserRef } from './schemas'
import { anchorOfLot, codeTtlDaysOf, daysUntil, identityOf, INDEXER_BASE_LAG_SECONDS, mintsOf, tokensOf, TTL_EXTENSION_DAYS, TTL_MIN_DAYS, txById, type StoredAnchor, type StoredIdentity } from './state'
import { explorerAccountUrl, isTxInFlight } from './views'

// Reglas del dominio `chain` (contrato de la Ola 3 §2.4, §3, §7.1 y §8.2): identidad de la bodega,
// anclaje del expediente, reintento y abandono de transacciones, conciliación y alertas.

export const txNotFound = () => new ApiError(404, 'CHN_TX_NOT_FOUND', 'Transacción no encontrada')

/** `CHN_DISABLED` (409): la cadena no está configurada en este entorno (provision, pause y unpause). */
export function assertChainEnabled(state: TraceState): void {
  if (!state.chain.enabled) throw stateError('CHN_DISABLED', 'La cadena no está configurada en este entorno')
}

const requested = (by: UserRef | null) => ({ userId: by?.userId ?? null, fullName: by?.fullName ?? null, source: by ? ('API' as const) : ('WORKER' as const) })

// ----- Identidad de la bodega (§3.1, §3.5) -----

/** `name` del contrato: nombre comercial recortado a 40 bytes en frontera de carácter (DS-13). */
export function contractName(tradeName: string): string {
  const encoder = new TextEncoder()
  let out = ''
  for (const ch of tradeName) {
    if (encoder.encode(out + ch).length > 40) break
    out += ch
  }
  return out
}

/**
 * Aprovisiona la identidad de una bodega (al activarse o desde `chain/provision`): registra
 * `CREATE_WINERY_ACCOUNT`; al confirmarse, la red encadena `DEPLOY_WINERY_CONTRACT`. Idempotente
 * por `intentKey`; una identidad `FAILED` reintenta la transacción que falló.
 */
export function provisionIdentity(state: TraceState, ctx: ChainCtx, wineryId: string, by: UserRef | null): StoredIdentity {
  const chain = state.chain
  const winery = ctx.env.winery(wineryId)
  let identity = identityOf(chain, wineryId)
  if (identity?.status === 'ACTIVE' || identity?.status === 'PAUSED') throw stateError('CHN_IDENTITY_ALREADY_ACTIVE', 'La bodega ya tiene su cuenta y su contrato en la red')
  if (identity?.status === 'PROVISIONING') return identity
  if (!identity) {
    identity = {
      wineryId,
      status: 'PROVISIONING',
      accountAddress: mockAccountAddress(`winery:${wineryId}`),
      accountTxId: null,
      homeDomain: ctx.env.homeDomain,
      contract: {
        address: mockContractAddress(`winery:${wineryId}`),
        name: contractName(winery.tradeName),
        symbol: winery.lotPrefix,
        baseUri: `${ctx.env.publicApiBaseUrl}/v1/public/nft/${winery.slug}/`,
        paused: false,
        deployedAt: null,
      },
      contractTxId: null,
      lastError: null,
      since: null,
    }
    chain.identities.push(identity)
  }
  const failed = [identity.accountTxId, identity.contractTxId].map((id) => txById(chain, id)).find((t) => t?.status === 'FAILED')
  if (failed) {
    requeueTx(state, ctx, failed)
    return identity
  }
  identity.status = 'PROVISIONING'
  identity.lastError = null
  identity.accountTxId = enqueueTx(state, ctx, {
    kind: 'CREATE_WINERY_ACCOUNT',
    intentKey: `identity:${wineryId}:account`,
    subject: { type: 'WINERY', id: wineryId },
    wineryId,
    intent: { wineryId, startingBalanceXlm: '2.0000000', homeDomain: ctx.env.homeDomain },
    requestedBy: requested(by),
  }).id
  return identity
}

/** `POST …/chain/pause` y `…/chain/unpause` (§3.5): pausa o reanuda el contrato **en la red**. */
export function setContractPaused(state: TraceState, ctx: ChainCtx, wineryId: string, paused: boolean, by: UserRef, auditRef: string): StoredIdentity {
  const chain = state.chain
  const identity = identityOf(chain, wineryId)
  if (!identity?.contract || (identity.status !== 'ACTIVE' && identity.status !== 'PAUSED')) {
    throw stateError('TOK_WINERY_CHAIN_NOT_READY', 'La bodega aún no tiene su contrato en la red', [{ field: null, message: 'Identidad sin contrato', code: 'TOK_WINERY_CHAIN_NOT_READY', meta: { status: identity?.status ?? 'NOT_PROVISIONED' } }])
  }
  const kind = paused ? 'PAUSE_CONTRACT' : 'UNPAUSE_CONTRACT'
  const inFlight = chain.transactions.some((t) => t.wineryId === wineryId && t.kind === kind && isTxInFlight(t))
  if (paused && (identity.contract.paused || inFlight)) throw stateError('CHN_CONTRACT_ALREADY_PAUSED', 'El contrato ya está pausado en la red')
  if (!paused && (!identity.contract.paused || inFlight)) throw stateError('CHN_CONTRACT_NOT_PAUSED', 'El contrato no está pausado en la red')
  enqueueTx(state, ctx, {
    kind,
    intentKey: `${paused ? 'pause' : 'unpause'}:${identity.contract.address}:${auditRef}`,
    subject: { type: 'CONTRACT', id: identity.contract.address },
    wineryId,
    intent: { wineryId, contract: identity.contract.address },
    requestedBy: requested(by),
  })
  return identity
}

// ----- Anclaje del expediente (§7.1) -----

/** Registra `ANCHOR_DOSSIER` para un lote certificado (tenga colección o no, A-22). Idempotente: un anclaje por expediente. */
export function anchorDossier(state: TraceState, ctx: ChainCtx, lot: Lot): StoredAnchor | null {
  const chain = state.chain
  const existing = anchorOfLot(chain, lot.id)
  if (existing) return existing
  const dossier = lotDossier(state, lot.id)
  if (dossier?.status !== 'CLOSED' || !dossier.hash) return null
  const tx = enqueueTx(state, ctx, {
    kind: 'ANCHOR_DOSSIER',
    intentKey: `anchor:${lot.id}`,
    subject: { type: 'LOT', id: lot.id },
    wineryId: lot.wineryId,
    intent: { lotId: lot.id, reference: lot.reference, memoHashHex: dossier.hash },
  })
  const anchor: StoredAnchor = { lotId: lot.id, wineryId: lot.wineryId, memoHashHex: dossier.hash, txId: tx.id, createdAt: ctx.now, verifiedAt: null }
  chain.anchors.push(anchor)
  return anchor
}

// ----- Transacciones (§2.4) -----

export function retryTx(state: TraceState, ctx: ChainCtx, tx: ChainTransaction): ChainTransaction {
  if (tx.status !== 'FAILED' || tx.abandoned) {
    throw stateError('CHN_TX_NOT_RETRYABLE', 'Solo se puede reintentar una transacción fallida', [{ field: null, message: `La transacción está en ${tx.status}`, code: 'CHN_TX_NOT_RETRYABLE', meta: { status: tx.status } }])
  }
  requeueTx(state, ctx, tx)
  return tx
}

/** Tipos que deben terminar: no se abandonan. */
export const NOT_ABANDONABLE = ['MINT_BATCH', 'ANCHOR_DOSSIER', 'CREATE_WINERY_ACCOUNT', 'DEPLOY_WINERY_CONTRACT'] as const

export function abandonTx(state: TraceState, ctx: ChainCtx, tx: ChainTransaction, reason: string, by: UserRef): ChainTransaction {
  if ((NOT_ABANDONABLE as readonly string[]).includes(tx.kind)) {
    throw stateError('CHN_TX_NOT_ABANDONABLE', 'Las emisiones, los anclajes y la identidad de una bodega deben terminar: no se abandonan', [
      { field: null, message: `Tipo ${tx.kind}`, code: 'CHN_TX_NOT_ABANDONABLE', meta: { kind: tx.kind } },
    ])
  }
  if (tx.status !== 'FAILED' || tx.abandoned) {
    throw stateError('CHN_TX_NOT_ABANDONABLE', 'Solo se abandona una transacción fallida', [{ field: null, message: `La transacción está en ${tx.status}`, code: 'CHN_TX_NOT_ABANDONABLE', meta: { kind: tx.kind, status: tx.status } }])
  }
  tx.abandoned = { at: ctx.now, by: by.fullName, reason }
  tx.updatedAt = ctx.now
  delete state.chain.due[tx.id]
  return tx
}

// ----- Cuentas de la plataforma (§2.4) -----

export function platformAccounts(state: TraceState, now: string = state.chain.platform.checkedAt): PlatformChainAccounts {
  const p = state.chain.platform
  const status = (address: string, balance: string, min: string): PlatformAccountStatus => ({
    address,
    explorerUrl: explorerAccountUrl(address),
    balanceXlm: balance,
    minBalanceXlm: min,
    status: !address ? 'MISSING' : Number(balance) < Number(min) ? 'LOW' : 'OK',
    checkedAt: p.checkedAt || null,
  })
  return {
    network: state.chain.network,
    operations: status(p.operationsAddress, p.operationsBalanceXlm, p.operationsMinBalanceXlm),
    anchor: status(p.anchorAddress, p.anchorBalanceXlm, p.anchorMinBalanceXlm),
    wasmHash: p.wasmHash,
    // Días de vida que le quedan al código según el reloj de los mocks (`null` hasta la primera lectura).
    codeTtlDays: codeTtlDaysOf(state.chain, now),
  }
}

// ----- Vida del almacenamiento (§8.3) -----

/**
 * Tarea `chain.ttl.extend`: registra `EXTEND_TTL` para el código (`'CODE'`) o para las entradas del
 * contrato de una bodega. Al confirmarse, su vida crece 30 días. Idempotente por día.
 */
export function extendTtl(state: TraceState, ctx: ChainCtx, target: 'CODE' | { wineryId: string }, days: number = TTL_EXTENSION_DAYS): ChainTransaction {
  const chain = state.chain
  if (target === 'CODE') {
    return enqueueTx(state, ctx, { kind: 'EXTEND_TTL', intentKey: `ttl:code:${ctx.now}`, subject: { type: 'PLATFORM', id: 'WASM' }, wineryId: null, intent: { target: 'CODE', wasmHash: chain.platform.wasmHash, days } })
  }
  const contract = identityOf(chain, target.wineryId)?.contract
  if (!contract) throw stateError('TOK_WINERY_CHAIN_NOT_READY', 'La bodega aún no tiene su contrato en la red')
  return enqueueTx(state, ctx, { kind: 'EXTEND_TTL', intentKey: `ttl:${contract.address}:${ctx.now}`, subject: { type: 'CONTRACT', id: contract.address }, wineryId: target.wineryId, intent: { target: contract.address, days } })
}

// ----- Indexador y divergencias con la red (solo en los mocks) -----

/** Ledgers de retraso a partir de los cuales el indexador abre `INDEXER_GAP`. */
export const INDEXER_GAP_LEDGERS = 60

/**
 * El indexador se queda atrás: la red avanza `ledgers` sin que se lean sus eventos. Abre la alerta
 * `INDEXER_GAP`; la siguiente conciliación relee el tramo, pone el indexador al día y la cierra sola.
 */
export function simulateIndexerGap(state: TraceState, ctx: ChainCtx, ledgers = 240): ChainAlert {
  const chain = state.chain
  chain.ledger += Math.max(INDEXER_GAP_LEDGERS, ledgers)
  chain.indexer.lagSeconds = (chain.ledger - chain.indexer.lastLedger) * 5
  const open = chain.alerts.find((a) => a.code === 'INDEXER_GAP' && a.resolvedAt === null)
  return (
    open ??
    raiseAlert(state, ctx, {
      code: 'INDEXER_GAP',
      level: 'WARNING',
      subject: { type: 'PLATFORM', id: 'INDEXER' },
      wineryId: null,
      message: `El indexador de eventos lleva ${chain.ledger - chain.indexer.lastLedger} ledgers de retraso: puede haber eventos sin leer`,
      expected: { ledger: chain.ledger },
      actual: { lastIndexedLedger: chain.indexer.lastLedger, lagSeconds: chain.indexer.lagSeconds },
    })
  )
}

export type ChainDriftInput =
  /** Un NFT cambia de dueño en la red sin pasar por el sistema (`OWNER_MISMATCH` en la conciliación completa). */
  | { kind: 'OWNER'; wineryId: string; tokenId: number; owner?: string }
  /** El contrato aparece pausado (o no) en la red sin que la base lo sepa (`PAUSE_MISMATCH`). */
  | { kind: 'PAUSE'; wineryId: string; paused: boolean }
  /** Un rol concedido en la red que el sistema no pidió (`ROLE_MISMATCH`). */
  | { kind: 'ROLE'; wineryId: string; account?: string }

/** Hace que la red «diga» otra cosa que la base, para que la conciliación lo detecte. Nunca toca los datos de negocio. */
export function driftChain(state: TraceState, ctx: ChainCtx, input: ChainDriftInput): void {
  const chain = state.chain
  const identity = identityOf(chain, input.wineryId)
  if (!identity?.contract) throw stateError('TOK_WINERY_CHAIN_NOT_READY', 'La bodega aún no tiene su contrato en la red')
  const contract = identity.contract.address
  const intruder = mockAccountAddress(`drift:${contract}`)
  chain.ledger += 1
  if (input.kind === 'OWNER') {
    const token = chain.tokens.find((t) => t.wineryId === input.wineryId && t.tokenId === input.tokenId)
    if (!token) throw new ApiError(404, 'NOT_FOUND', 'Ese NFT no existe en el contrato de la bodega')
    const owner = input.owner ?? intruder
    recordChainEvent(state, ctx, { contractAddress: contract, wineryId: input.wineryId, type: 'transfer', tx: null, data: { from: token.onchain.owner, to: owner, tokenId: token.tokenId } })
    token.onchain = { ...token.onchain, owner, checkedAt: ctx.now }
  } else if (input.kind === 'PAUSE') {
    chain.drift.paused[contract] = input.paused
    recordChainEvent(state, ctx, { contractAddress: contract, wineryId: input.wineryId, type: input.paused ? 'paused' : 'unpaused', tx: null, data: { caller: identity.accountAddress } })
  } else {
    const account = input.account ?? intruder
    chain.drift.roles[contract] = account
    recordChainEvent(state, ctx, { contractAddress: contract, wineryId: input.wineryId, type: 'role_granted', tx: null, data: { role: 'minter', account, caller: identity.accountAddress } })
  }
}

/** La red vuelve a coincidir con la base: la siguiente conciliación cierra sola las alertas abiertas por `driftChain`. */
export function clearChainDrift(state: TraceState, ctx: ChainCtx): void {
  const chain = state.chain
  chain.drift = { paused: {}, roles: {} }
  for (const t of chain.tokens) {
    const owner = t.status === 'BURNED' ? null : t.owner.address
    if (t.onchain.owner !== owner || t.onchain.burned !== (t.status === 'BURNED')) t.onchain = { owner, burned: t.status === 'BURNED', checkedAt: ctx.now }
  }
}

// ----- Conciliación y alertas (§8.2) -----

export function resolveAlert(_state: TraceState, ctx: ChainCtx, alert: ChainAlert, note: string, by: UserRef): ChainAlert {
  if (alert.resolvedAt) throw stateError('CHN_ALERT_ALREADY_RESOLVED', 'La alerta ya está resuelta')
  alert.resolvedAt = ctx.now
  alert.resolution = { by: by.fullName, note, auto: false }
  return alert
}

/** Diferencia que una conciliación encuentra entre la base y la red. */
type Difference = Parameters<typeof raiseAlert>[2]

/** Códigos que la conciliación evalúa: si su condición desaparece, la alerta se cierra sola. */
export const RECONCILED_ALERT_CODES = ['TOTAL_MINTED_MISMATCH', 'QUOTA_EXCEEDED', 'BOTTLES_SHORTFALL', 'OWNER_MISMATCH', 'BURN_MISMATCH', 'PAUSE_MISMATCH', 'ROLE_MISMATCH', 'TTL_EXPIRING', 'TX_STUCK', 'LOW_BALANCE', 'INDEXER_GAP'] as const

/**
 * `POST /v1/platform/chain/reconciliation/runs` (§8.2): compara la base con la red. En los mocks la
 * red es la propia base más lo que se haya desviado con `mockChain.drift()`: detecta el total
 * emitido, la cuota, el faltante de botellas y, en profundidad `FULL`, dueños y quemas de cada NFT,
 * la pausa y los roles de cada contrato y la vida del almacenamiento; con alcance `ALL`, además las
 * transacciones atascadas, los saldos, el código y el retraso del indexador. Abre una alerta por
 * cada diferencia nueva y **cierra sola** (`resolution.auto`) las que ya no se reproducen. Nunca
 * corrige datos (S-19). Termina en la misma petición.
 */
export function runReconciliation(state: TraceState, ctx: ChainCtx, body: StartReconciliation, trigger: ReconciliationRun['trigger'] = 'MANUAL'): ReconciliationRun {
  const chain = state.chain
  const subjectId = body.subjectId ?? null
  const running = chain.runs.find((r) => r.status === 'RUNNING' && r.scope === body.scope && r.subjectId === subjectId)
  if (running) {
    throw stateError('CHN_RECONCILIATION_RUNNING', 'Ya hay una conciliación en curso para ese alcance', [{ field: null, message: 'Conciliación en curso', code: 'CHN_RECONCILIATION_RUNNING', meta: { runId: running.id } }])
  }
  const run: ReconciliationRun = { id: ctx.newId('reconciliation-run'), scope: body.scope, subjectId, trigger, depth: body.depth ?? 'LIGHT', status: 'RUNNING', startedAt: ctx.now, finishedAt: null, checks: 0, issuesOpened: 0, issuesAutoResolved: 0 }
  chain.runs.push(run)
  const full = run.depth === 'FULL'
  const all = body.scope === 'ALL'
  const found: Difference[] = []
  /** Lo que esta ejecución comprobó (`código:sujeto`): solo eso puede cerrarse solo. */
  const evaluated = new Set<string>()
  const check = (code: string, id: string, difference: Omit<Difference, 'code' | 'subject'> & { subjectType: string } | null) => {
    run.checks += 1
    evaluated.add(`${code}:${id}`)
    if (difference) {
      const { subjectType, ...rest } = difference
      found.push({ ...rest, code, subject: { type: subjectType, id } })
    }
  }

  const collections = chain.collections.filter((c) => all || (body.scope === 'COLLECTION' && c.id === subjectId) || (body.scope === 'CONTRACT' && identityOf(chain, c.wineryId)?.contract?.address === subjectId))
  for (const c of collections) {
    const tokens = tokensOf(chain, c.id)
    const name = `«${c.commercial.name}»`
    const base = { subjectType: 'COLLECTION', wineryId: c.wineryId }
    const confirmed = mintsOf(chain, c.id).reduce((n, m) => n + m.ranges.reduce((k, r) => k + r.lastTokenId - r.firstTokenId + 1, 0), 0)
    check('TOTAL_MINTED_MISMATCH', c.id, confirmed !== tokens.length ? { ...base, level: 'CRITICAL', message: `${name}: la base y la red no coinciden en el total emitido`, expected: tokens.length, actual: confirmed } : null)
    check('QUOTA_EXCEEDED', c.id, tokens.length > c.quota ? { ...base, level: 'CRITICAL', message: `${name}: hay más NFT emitidos que cuota aprobada`, expected: c.quota, actual: tokens.length } : null)
    const closure = chain.closures.find((x) => x.collectionId === c.id)
    check('BOTTLES_SHORTFALL', c.id, closure?.status === 'SHORTFALL_OPEN' ? { ...base, level: 'WARNING', message: `${name}: hay ${closure.shortfall} NFT más que botellas`, expected: closure.bottles, actual: closure.minted } : null)
    if (!full) continue
    // Profundidad completa: dueño y quema de cada NFT, leídos de la red.
    const owners = tokens.filter((t) => t.status !== 'BURNED' && t.onchain.owner !== t.owner.address)
    check('OWNER_MISMATCH', c.id, owners.length > 0 ? { ...base, level: 'CRITICAL', message: `${name}: ${owners.length} NFT con un dueño en la red distinto del que dice la base`, expected: { tokenId: owners[0]!.tokenId, owner: owners[0]!.owner.address }, actual: { tokenId: owners[0]!.tokenId, owner: owners[0]!.onchain.owner, tokens: owners.length } } : null)
    const burns = tokens.filter((t) => (t.status === 'BURNED') !== t.onchain.burned)
    check('BURN_MISMATCH', c.id, burns.length > 0 ? { ...base, level: 'CRITICAL', message: `${name}: ${burns.length} NFT quemados en la red o en la base, pero no en las dos`, expected: { tokenId: burns[0]!.tokenId, burned: burns[0]!.status === 'BURNED' }, actual: { tokenId: burns[0]!.tokenId, burned: burns[0]!.onchain.burned, tokens: burns.length } } : null)
  }

  if (full && body.scope !== 'COLLECTION') {
    for (const identity of chain.identities) {
      const contract = identity.contract
      if (!contract?.deployedAt || (body.scope === 'CONTRACT' && contract.address !== subjectId)) continue
      const base = { subjectType: 'CONTRACT', wineryId: identity.wineryId }
      const tradeName = ctx.env.winery(identity.wineryId).tradeName
      const onchainPaused = chain.drift.paused[contract.address] ?? contract.paused
      check('PAUSE_MISMATCH', contract.address, onchainPaused !== contract.paused ? { ...base, level: 'CRITICAL', message: `El contrato de ${tradeName} está ${onchainPaused ? 'pausado' : 'activo'} en la red y ${contract.paused ? 'pausado' : 'activo'} en la base`, expected: { paused: contract.paused }, actual: { paused: onchainPaused } } : null)
      const role = chain.drift.roles[contract.address]
      check('ROLE_MISMATCH', contract.address, role ? { ...base, level: 'CRITICAL', message: `El contrato de ${tradeName} tiene un rol concedido que el sistema no pidió`, expected: { operator: chain.platform.operationsAddress }, actual: { role: 'minter', account: role } } : null)
      const days = daysUntil(chain.ttl.contracts[contract.address], ctx.now)
      const extending = chain.transactions.some((t) => t.kind === 'EXTEND_TTL' && t.intent.target === contract.address && isTxInFlight(t))
      check('TTL_EXPIRING', contract.address, days !== null && days < TTL_MIN_DAYS && !extending ? { ...base, level: 'WARNING', message: `Entradas del contrato de ${tradeName} con menos de ${TTL_MIN_DAYS} días de vida y sin extensión en curso`, expected: { minDays: TTL_MIN_DAYS }, actual: { days } } : null)
    }
  }

  if (all) {
    for (const tx of chain.transactions) {
      if (!isTxInFlight(tx) || tx.status === 'PENDING') continue
      const stuck = Date.parse(ctx.now) - Date.parse(tx.updatedAt) > 15 * 60_000
      check('TX_STUCK', tx.id, stuck ? { subjectType: 'TRANSACTION', level: 'WARNING', wineryId: tx.wineryId, message: `La transacción ${tx.kind} lleva más de 15 minutos sin confirmarse`, expected: 'CONFIRMED', actual: tx.status } : null)
    }
    // Las `TX_STUCK` abiertas de transacciones que ya terminaron también se dan por comprobadas.
    for (const alert of chain.alerts) if (alert.code === 'TX_STUCK' && alert.resolvedAt === null) evaluated.add(`TX_STUCK:${alert.subject.id}`)
    const accounts = platformAccounts(state, ctx.now)
    for (const [role, account] of [['OPERATIONS', accounts.operations], ['ANCHOR', accounts.anchor]] as const) {
      check(
        'LOW_BALANCE',
        role,
        account.status !== 'OK'
          ? { subjectType: 'PLATFORM_ACCOUNT', level: role === 'OPERATIONS' ? 'CRITICAL' : 'WARNING', wineryId: null, message: `El saldo de la cuenta de ${role === 'OPERATIONS' ? 'operaciones' : 'anclaje'} está por debajo del mínimo`, expected: { minBalanceXlm: account.minBalanceXlm }, actual: { balanceXlm: account.balanceXlm, status: account.status } }
          : null,
      )
    }
    if (full) {
      const codeDays = codeTtlDaysOf(chain, ctx.now)
      const extending = chain.transactions.some((t) => t.kind === 'EXTEND_TTL' && t.intent.target === 'CODE' && isTxInFlight(t))
      check('TTL_EXPIRING', 'WASM', codeDays !== null && codeDays < TTL_MIN_DAYS && !extending ? { subjectType: 'PLATFORM', level: 'CRITICAL', wineryId: null, message: `Al código de los contratos le quedan menos de ${TTL_MIN_DAYS} días de vida y no hay extensión en curso`, expected: { minDays: TTL_MIN_DAYS }, actual: { days: codeDays } } : null)
    }
    // El indexador: la conciliación relee el tramo pendiente y lo pone al día (§8.1).
    run.checks += 1
    evaluated.add('INDEXER_GAP:INDEXER')
    chain.indexer = { lastLedger: chain.ledger, lagSeconds: INDEXER_BASE_LAG_SECONDS }
  }

  const isOpen = (code: string, id: string) => chain.alerts.some((a) => a.code === code && a.subject.id === id && a.resolvedAt === null)
  for (const difference of found) {
    if (isOpen(difference.code, difference.subject.id)) continue
    raiseAlert(state, ctx, { ...difference, runId: run.id })
    run.issuesOpened += 1
  }
  const still = new Set(found.map((d) => `${d.code}:${d.subject.id}`))
  for (const alert of chain.alerts) {
    const key = `${alert.code}:${alert.subject.id}`
    if (alert.resolvedAt || !(RECONCILED_ALERT_CODES as readonly string[]).includes(alert.code) || !evaluated.has(key) || still.has(key)) continue
    alert.resolvedAt = ctx.now
    alert.resolution = { by: 'Sistema', note: alert.code === 'TX_STUCK' ? 'La transacción ya terminó' : 'La diferencia ya no se reproduce: la base y la red coinciden', auto: true }
    run.issuesAutoResolved += 1
  }
  run.status = run.issuesOpened > 0 ? 'DIFFERENCES' : 'OK'
  run.finishedAt = ctx.now
  return run
}

export function runDetail(state: TraceState, run: ReconciliationRun): ReconciliationRunDetail {
  return { ...run, alerts: state.chain.alerts.filter((a) => a.runId === run.id) }
}
