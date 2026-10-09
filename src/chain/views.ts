import { hexToBase64 } from '../shared/strkey'
import type { ChainTransaction, ChainTxRef, DossierAnchor, PublicDossierAnchor, WineryChainIdentity } from './schemas'
import { anchorOfLot, identityOf, txById, type ChainState, type StoredIdentity } from './state'

// Vistas del dominio `chain` (DTO a partir del estado guardado) y enlaces al explorador. Los
// enlaces los construye siempre el servidor (contrato §0): las apps nunca escriben el host.

/** `STELLAR_EXPLORER_BASE_URL` de los mocks (testnet). */
export const MOCK_EXPLORER_BASE_URL = 'https://stellar.expert/explorer/testnet'

export const explorerTxUrl = (txHash: string | null): string | null => (txHash ? `${MOCK_EXPLORER_BASE_URL}/tx/${txHash}` : null)
export const explorerAccountUrl = (address: string): string => `${MOCK_EXPLORER_BASE_URL}/account/${address}`
export const explorerContractUrl = (address: string): string => `${MOCK_EXPLORER_BASE_URL}/contract/${address}`

/** Lo que ven el ERP y el Marketplace de una transacción (`ChainTxRefDto`). */
export function toTxRef(tx: ChainTransaction): ChainTxRef {
  return {
    id: tx.id,
    kind: tx.kind,
    status: tx.status,
    network: tx.network,
    txHash: tx.txHash,
    explorerUrl: tx.explorerUrl,
    ledger: tx.ledger,
    confirmedAt: tx.confirmedAt,
    attempts: tx.attempts,
    lastError: tx.lastError,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  }
}

export function txRefOf(chain: ChainState, id: string | null): ChainTxRef | null {
  const tx = txById(chain, id)
  return tx ? toTxRef(tx) : null
}

const IN_FLIGHT = ['PENDING', 'BUILDING', 'SUBMITTED', 'RETRYING']
export const isTxInFlight = (tx: Pick<ChainTransaction, 'status'>): boolean => IN_FLIGHT.includes(tx.status)

const IDENTITY_KINDS = ['CREATE_WINERY_ACCOUNT', 'DEPLOY_WINERY_CONTRACT', 'PAUSE_CONTRACT', 'UNPAUSE_CONTRACT']

/** Identidad de una bodega (`WineryChainIdentityDto`); sin fila, `NOT_PROVISIONED`. */
export function identityView(chain: ChainState, wineryId: string, stored: StoredIdentity | null = identityOf(chain, wineryId)): WineryChainIdentity {
  if (!stored) return { wineryId, network: chain.network, status: 'NOT_PROVISIONED', account: null, contract: null, pendingTransactions: [], lastError: null }
  const createdTx = txRefOf(chain, stored.accountTxId)
  const deployedTx = txRefOf(chain, stored.contractTxId)
  return {
    wineryId,
    network: chain.network,
    status: stored.status,
    // La cuenta y el contrato solo se publican con su transacción confirmada.
    account:
      stored.accountAddress && createdTx?.status === 'CONFIRMED'
        ? { address: stored.accountAddress, explorerUrl: explorerAccountUrl(stored.accountAddress), homeDomain: stored.homeDomain, createdTx }
        : null,
    contract:
      stored.contract && deployedTx?.status === 'CONFIRMED'
        ? {
            address: stored.contract.address,
            explorerUrl: explorerContractUrl(stored.contract.address),
            wasmHash: chain.platform.wasmHash,
            name: stored.contract.name,
            symbol: stored.contract.symbol,
            baseUri: stored.contract.baseUri,
            operatorAddress: chain.platform.operationsAddress,
            paused: stored.contract.paused,
            deployedTx,
            deployedAt: stored.contract.deployedAt,
          }
        : null,
    pendingTransactions: chain.transactions.filter((t) => t.wineryId === wineryId && isTxInFlight(t) && IDENTITY_KINDS.includes(t.kind)).map(toTxRef),
    lastError: stored.lastError,
  }
}

/** Anclaje del expediente de un lote (`DossierAnchorDto`) o `null` si aún no tiene transacción. */
export function dossierAnchorView(chain: ChainState | undefined, lotId: string): DossierAnchor | null {
  if (!chain) return null
  const anchor = anchorOfLot(chain, lotId)
  const tx = anchor ? txById(chain, anchor.txId) : null
  if (!anchor || !tx) return null
  const anchored = tx.status === 'CONFIRMED' && anchor.verifiedAt !== null
  return {
    // Un anclaje confirmado que no supera la comprobación (`ANCHOR_MISMATCH`) queda `FAILED`.
    status: anchored ? 'ANCHORED' : tx.status === 'FAILED' || anchor.mismatch ? 'FAILED' : tx.status === 'SUBMITTED' || tx.status === 'CONFIRMED' ? 'SUBMITTED' : 'PENDING',
    network: chain.network,
    account: chain.platform.anchorAddress,
    memoHashHex: anchor.memoHashHex,
    memoHashBase64: hexToBase64(anchor.memoHashHex),
    txHash: tx.txHash,
    ledger: tx.ledger,
    anchoredAt: anchored ? tx.confirmedAt : null,
    explorerUrl: tx.explorerUrl,
    verifiedAt: anchor.verifiedAt,
    transaction: toTxRef(tx),
  }
}

/** Anclaje tal como se publica (`PublicDossierAnchorDto`): `FAILED` y `SUBMITTED` salen como `PENDING` (S-17). */
export function publicAnchorView(chain: ChainState | undefined, lotId: string): PublicDossierAnchor | null {
  const anchor = dossierAnchorView(chain, lotId)
  if (!anchor) return null
  const anchored = anchor.status === 'ANCHORED'
  return {
    status: anchored ? 'ANCHORED' : 'PENDING',
    network: anchor.network,
    account: anchor.account,
    memoHashHex: anchor.memoHashHex,
    memoHashBase64: anchor.memoHashBase64,
    txHash: anchored ? anchor.txHash : null,
    ledger: anchored ? anchor.ledger : null,
    anchoredAt: anchor.anchoredAt,
    explorerUrl: anchored ? anchor.explorerUrl : null,
  }
}
