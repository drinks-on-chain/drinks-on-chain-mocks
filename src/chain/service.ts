import { ApiError } from '../erp/handlers/errors'
import type { Lot } from '../erp/schemas'
import { lotDossier, stateError, type TraceState } from '../erp/trace/state'
import { mockAccountAddress, mockContractAddress } from '../shared/strkey'
import { enqueueTx, raiseAlert, requeueTx, type ChainCtx } from './engine'
import type { ChainAlert, ChainTransaction, PlatformAccountStatus, PlatformChainAccounts, ReconciliationRun, ReconciliationRunDetail, StartReconciliation, UserRef } from './schemas'
import { anchorOfLot, identityOf, mintsOf, tokensOf, txById, type StoredAnchor, type StoredIdentity } from './state'
import { explorerAccountUrl, isTxInFlight } from './views'

// Reglas del dominio `chain` (contrato de la Ola 3 §2.4, §3, §7.1 y §8.2): identidad de la bodega,
// anclaje del expediente, reintento y abandono de transacciones, conciliación y alertas.

export const txNotFound = () => new ApiError(404, 'CHN_TX_NOT_FOUND', 'Transacción no encontrada')

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

export function platformAccounts(state: TraceState): PlatformChainAccounts {
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
    codeTtlDays: p.codeTtlDays,
  }
}

// ----- Conciliación y alertas (§8.2) -----

export function resolveAlert(_state: TraceState, ctx: ChainCtx, alert: ChainAlert, note: string, by: UserRef): ChainAlert {
  if (alert.resolvedAt) throw stateError('CHN_ALERT_ALREADY_RESOLVED', 'La alerta ya está resuelta')
  alert.resolvedAt = ctx.now
  alert.resolution = { by: by.fullName, note, auto: false }
  return alert
}

/**
 * `POST /v1/platform/chain/reconciliation/runs`: compara la base con la red. En los mocks la red
 * es la propia base, así que solo abre alertas por lo que la base ya sabe incoherente (cuota
 * superada, faltante de botellas, transacciones atascadas, saldos bajos) y cierra solas las
 * `TX_STUCK` cuya transacción ya terminó. Nunca corrige datos (S-19). Termina en la misma petición.
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
  const collections = chain.collections.filter((c) => body.scope === 'ALL' || (body.scope === 'COLLECTION' && c.id === subjectId) || (body.scope === 'CONTRACT' && identityOf(chain, c.wineryId)?.contract?.address === subjectId))
  const openAlert = (code: string, id: string) => chain.alerts.some((a) => a.code === code && a.subject.id === id && a.resolvedAt === null)
  const open = (input: Parameters<typeof raiseAlert>[2]) => {
    if (openAlert(input.code, input.subject.id)) return
    raiseAlert(state, ctx, { ...input, runId: run.id })
    run.issuesOpened += 1
  }
  for (const c of collections) {
    const tokens = tokensOf(chain, c.id)
    const confirmed = mintsOf(chain, c.id).reduce((n, m) => n + m.ranges.reduce((k, r) => k + r.lastTokenId - r.firstTokenId + 1, 0), 0)
    // TOTAL_MINTED_MISMATCH, BALANCE_MISMATCH, OWNER_MISMATCH, BURN_MISMATCH, QUOTA_EXCEEDED, BOTTLES_SHORTFALL
    run.checks += run.depth === 'FULL' ? 6 : 4
    if (confirmed !== tokens.length) open({ code: 'TOTAL_MINTED_MISMATCH', level: 'CRITICAL', subject: { type: 'COLLECTION', id: c.id }, wineryId: c.wineryId, message: `«${c.commercial.name}»: la base y la red no coinciden en el total emitido`, expected: tokens.length, actual: confirmed })
    if (tokens.length > c.quota) open({ code: 'QUOTA_EXCEEDED', level: 'CRITICAL', subject: { type: 'COLLECTION', id: c.id }, wineryId: c.wineryId, message: `«${c.commercial.name}»: hay más NFT emitidos que cuota aprobada`, expected: c.quota, actual: tokens.length })
    const closure = chain.closures.find((x) => x.collectionId === c.id)
    if (closure?.status === 'SHORTFALL_OPEN') open({ code: 'BOTTLES_SHORTFALL', level: 'WARNING', subject: { type: 'COLLECTION', id: c.id }, wineryId: c.wineryId, message: `«${c.commercial.name}»: hay ${closure.shortfall} NFT más que botellas`, expected: closure.bottles, actual: closure.minted })
  }
  if (body.scope === 'ALL') {
    run.checks += 3
    for (const tx of chain.transactions) {
      if (isTxInFlight(tx) && tx.status !== 'PENDING' && Date.parse(ctx.now) - Date.parse(tx.updatedAt) > 15 * 60_000) {
        open({ code: 'TX_STUCK', level: 'WARNING', subject: { type: 'TRANSACTION', id: tx.id }, wineryId: tx.wineryId, message: `La transacción ${tx.kind} lleva más de 15 minutos sin confirmarse`, expected: 'CONFIRMED', actual: tx.status })
      }
    }
    const accounts = platformAccounts(state)
    for (const [role, account] of [['OPERATIONS', accounts.operations], ['ANCHOR', accounts.anchor]] as const) {
      if (account.status !== 'OK') open({ code: 'LOW_BALANCE', level: 'WARNING', subject: { type: 'PLATFORM_ACCOUNT', id: role }, wineryId: null, message: `Saldo bajo en la cuenta ${role === 'OPERATIONS' ? 'de operaciones' : 'de anclaje'}`, expected: account.minBalanceXlm, actual: account.balanceXlm })
    }
    for (const alert of chain.alerts) {
      if (alert.code !== 'TX_STUCK' || alert.resolvedAt) continue
      const tx = txById(chain, alert.subject.id)
      if (tx && !isTxInFlight(tx)) {
        alert.resolvedAt = ctx.now
        alert.resolution = { by: 'Sistema', note: 'La transacción ya terminó', auto: true }
        run.issuesAutoResolved += 1
      }
    }
  }
  run.status = run.issuesOpened > 0 ? 'DIFFERENCES' : 'OK'
  run.finishedAt = ctx.now
  return run
}

export function runDetail(state: TraceState, run: ReconciliationRun): ReconciliationRunDetail {
  return { ...run, alerts: state.chain.alerts.filter((a) => a.runId === run.id) }
}
