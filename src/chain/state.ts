import type { LotTokenizationMark } from '../erp/schemas/lots'
import type {
  CollectionCommercial,
  CollectionPrice,
  CollectionStatus,
  CollectionStatusHistoryEntry,
  LotClosure,
  LotClosureItem,
  Mint,
  PlatformTokenizationRequest,
  QuotaHistoryEntry,
  Token,
} from '../tokenization/schemas'
import type { ChainAlert, ChainEvent, ChainIdentityStatus, ChainNetwork, ChainTransaction, ChainTxKind, ReconciliationRun } from './schemas'

// Estado de la Ola 3 en la base en memoria (`TraceState.chain`): lo que el backend guarda en sus
// tablas de cadena y tokenización, en forma normalizada. Las vistas (`src/chain/views.ts`,
// `src/tokenization/views.ts`) arman los DTO; los servicios (`engine.ts`, `service.ts`) aplican las
// reglas. Sin dependencias de `src/erp/trace` (solo tipos), para que el estado del lote pueda leerlo.

/** Identidad de la bodega en la red (cuenta + contrato). Sin fila = `NOT_PROVISIONED`. */
export interface StoredIdentity {
  wineryId: string
  status: ChainIdentityStatus
  accountAddress: string | null
  accountTxId: string | null
  homeDomain: string | null
  contract: { address: string; name: string; symbol: string; baseUri: string; paused: boolean; deployedAt: string | null } | null
  contractTxId: string | null
  lastError: { code: string; message: string } | null
  /** Desde cuándo está `ACTIVE` (registro público). */
  since: string | null
}

/** Solicitud guardada: el DTO de plataforma sin lo que se calcula al leer (bodega, lote, sugerencia, revisión). */
export type StoredRequest = Omit<PlatformTokenizationRequest, 'winery' | 'lot' | 'priceSuggestion' | 'review'> & {
  /** `publishOnMint` de la aprobación. */
  publishOnMint?: boolean
}

export interface StoredCollection {
  id: string
  slug: string
  wineryId: string
  lotId: string
  status: CollectionStatus
  quota: number
  price: CollectionPrice | null
  commercial: CollectionCommercial
  pricePolicySnapshot: unknown
  priceHistory: CollectionPrice[]
  quotaHistory: QuotaHistoryEntry[]
  statusHistory: CollectionStatusHistoryEntry[]
  redeemableSince: string | null
  publishedAt: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
  /** Publicar sola cuando se confirme la emisión inicial. */
  publishOnMint: boolean
}

export type StoredMint = Omit<Mint, 'transactions'> & { txIds: string[] }

export type StoredToken = Omit<Token, 'contractAddress' | 'mintTx' | 'burnTx' | 'metadataUrl'> & {
  mintTxId: string
  burnTxId: string | null
  /** Pedido que lo compró (borrador de la Etapa 4): sale en los ítems del cierre con faltante, no en `TokenDto`. */
  orderId?: string | null
}

export type StoredClosureItem = Omit<LotClosureItem, 'burnTx'> & { burnTxId: string | null }
export type StoredClosure = Omit<LotClosure, 'items'> & { wineryId: string; items: StoredClosureItem[] }

/** Anclaje del expediente de un lote (uno por expediente). */
export interface StoredAnchor {
  lotId: string
  wineryId: string
  /** SHA-256 del expediente (hex): el memo de la transacción. */
  memoHashHex: string
  txId: string
  createdAt: string
  /** El servidor leyó la transacción y comprobó memo y cuenta. */
  verifiedAt: string | null
  /** La transacción se confirmó pero su memo o su cuenta no son los esperados (`ANCHOR_MISMATCH`): no se da por bueno. */
  mismatch?: boolean
}

/** Fallo forzado de la red simulada (`failNextChainTransaction`). */
export interface ForcedChainFailure {
  /** Solo las transacciones de este tipo (por defecto, la siguiente que se envíe). */
  kind?: ChainTxKind
  /** Código de `lastError` (por defecto `CHN_AUTH_FAILED`, definitivo). Uno transitorio (`CHN_RPC_UNAVAILABLE`…) pasa por `RETRYING` y se confirma en el intento siguiente. */
  code?: string
  message?: string
}

/**
 * Aviso de dominio pendiente de enviarse por correo (lo que el backend publica en su outbox, §11).
 * Los servicios puros lo dejan aquí; los handlers lo convierten en correos del buzón simulado.
 */
export interface ChainNotice {
  type:
    | 'REQUEST_SUBMITTED'
    | 'REQUEST_RESUBMITTED'
    | 'CHANGES_REQUESTED'
    | 'REQUEST_APPROVED'
    | 'REQUEST_REJECTED'
    | 'NFT_MINTED'
    | 'COLLECTION_PUBLISHED'
    | 'COLLECTION_PAUSED'
    | 'COLLECTION_RESUMED'
    | 'SHORTFALL_DETECTED'
    | 'ALERT_CRITICAL'
  wineryId: string | null
  requestId?: string
  collectionId?: string
  alertId?: string
  /** Texto libre del hecho: mensaje de los cambios pedidos, motivo del rechazo… */
  message?: string | null
  data?: Record<string, unknown>
}

/** Lo que la conciliación «lee de la red» y no coincide con la base (solo en los mocks). */
export interface ChainDrift {
  /** Contratos pausados en la red sin que la base lo sepa (o al revés): dirección → pausado en la red. */
  paused: Record<string, boolean>
  /** Rol concedido en la red que el sistema no pidió: dirección del contrato → cuenta. */
  roles: Record<string, string>
}

export interface ChainPlatformState {
  operationsAddress: string
  anchorAddress: string
  operationsBalanceXlm: string
  anchorBalanceXlm: string
  operationsMinBalanceXlm: string
  anchorMinBalanceXlm: string
  wasmHash: string
  /**
   * Días de vida del código tal como se guardaron en la semilla de 0.6.0-rc.1. Desde rc.2 manda
   * `ChainState.ttl.code` (fecha hasta la que vive): `codeTtlDaysOf()` lo calcula con el reloj.
   */
  codeTtlDays: number
  checkedAt: string
  networkPassphrase: string
}

export interface ChainState {
  network: ChainNetwork
  /** Último ledger cerrado de la red simulada. */
  ledger: number
  /** Tiempo transcurrido de la red simulada (ms): el reloj que hace avanzar las transacciones. */
  elapsedMs: number
  /** Cuándo toca el siguiente paso de cada transacción en vuelo (en `elapsedMs`). */
  due: Record<string, number>
  forcedFailures: ForcedChainFailure[]
  /** `CHAIN_MINT_ENABLED` (ADR-011): con `false`, las emisiones esperan en `PENDING`. */
  mintEnabled: boolean
  platform: ChainPlatformState
  transactions: ChainTransaction[]
  identities: StoredIdentity[]
  requests: StoredRequest[]
  collections: StoredCollection[]
  mints: StoredMint[]
  tokens: StoredToken[]
  closures: StoredClosure[]
  anchors: StoredAnchor[]
  alerts: ChainAlert[]
  events: ChainEvent[]
  runs: ReconciliationRun[]
  /** `false` = cadena sin configurar en el entorno (`CHAIN_ENABLED`): provision, pause y unpause → 409 `CHN_DISABLED`. */
  enabled: boolean
  /**
   * Vida del almacenamiento (§8.3): hasta cuándo viven el código (`code`; `null` = aún sin leer,
   * `codeTtlDays: null`) y las entradas de cada contrato (por dirección).
   */
  ttl: { code: string | null; contracts: Record<string, string> }
  /** Indexador de eventos (§8.1): último ledger procesado y retraso respecto de la red. */
  indexer: { lastLedger: number; lagSeconds: number }
  /** Comprobaciones de la red que la siguiente confirmación de ese tipo no supera (`mockChain.mismatchNext`). */
  forcedMismatches: ChainTxKind[]
  drift: ChainDrift
  /** Avisos pendientes de convertirse en correos (ver `ChainNotice`). */
  notices: ChainNotice[]
}

/** Retraso normal del indexador (s): consulta cada 60 s (§11). */
export const INDEXER_BASE_LAG_SECONDS = 12
/** Umbral de la alerta `TTL_EXPIRING` (días). */
export const TTL_MIN_DAYS = 14
/** Días que añade una extensión de vida (`EXTEND_TTL`). */
export const TTL_EXTENSION_DAYS = 30

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'

export function emptyChainState(): ChainState {
  return {
    network: 'TESTNET',
    ledger: 0,
    elapsedMs: 0,
    due: {},
    forcedFailures: [],
    mintEnabled: true,
    platform: {
      operationsAddress: '',
      anchorAddress: '',
      operationsBalanceXlm: '0.0000000',
      anchorBalanceXlm: '0.0000000',
      operationsMinBalanceXlm: '100.0000000',
      anchorMinBalanceXlm: '10.0000000',
      wasmHash: '',
      codeTtlDays: 0,
      checkedAt: '',
      networkPassphrase: TESTNET_PASSPHRASE,
    },
    transactions: [],
    identities: [],
    requests: [],
    collections: [],
    mints: [],
    tokens: [],
    closures: [],
    anchors: [],
    alerts: [],
    events: [],
    runs: [],
    enabled: true,
    ttl: { code: null, contracts: {} },
    indexer: { lastLedger: 0, lagSeconds: INDEXER_BASE_LAG_SECONDS },
    forcedMismatches: [],
    drift: { paused: {}, roles: {} },
    notices: [],
  }
}

/** Completa un estado guardado por una versión anterior (campos añadidos en 0.6.0-rc.2). */
export function upgradeChainState(chain: ChainState): ChainState {
  const base = emptyChainState()
  chain.enabled ??= true
  chain.ttl ??= base.ttl
  chain.indexer ??= { lastLedger: chain.ledger, lagSeconds: INDEXER_BASE_LAG_SECONDS }
  chain.forcedMismatches ??= []
  chain.drift ??= base.drift
  chain.notices ??= []
  return chain
}

const DAY_MS = 86_400_000
/** Días enteros que faltan hasta `until` (0 si ya pasó; `null` si no se conoce). */
export const daysUntil = (until: string | null | undefined, now: string): number | null => (until ? Math.max(0, Math.floor((Date.parse(until) - Date.parse(now)) / DAY_MS)) : null)

/** `codeTtlDays` de las cuentas de la plataforma: días de vida que le quedan al código (`null` = sin leer aún). */
export const codeTtlDaysOf = (chain: ChainState, now: string): number | null => daysUntil(chain.ttl.code, now)

/** Deja un aviso pendiente de correo. */
export function pushNotice(chain: ChainState, notice: ChainNotice): void {
  chain.notices.push(notice)
}

export const OPEN_REQUEST_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED'] as const
export const isOpenRequest = (r: Pick<StoredRequest, 'status'>): boolean => (OPEN_REQUEST_STATUSES as readonly string[]).includes(r.status)

export const collectionOfLot = (chain: ChainState, lotId: string): StoredCollection | null => chain.collections.find((c) => c.lotId === lotId) ?? null
export const openRequestOfLot = (chain: ChainState, lotId: string): StoredRequest | null => chain.requests.find((r) => r.lotId === lotId && isOpenRequest(r)) ?? null
export const mintsOf = (chain: ChainState, collectionId: string): StoredMint[] => chain.mints.filter((m) => m.collectionId === collectionId).sort((a, b) => a.sequence - b.sequence)
export const tokensOf = (chain: ChainState, collectionId: string): StoredToken[] => chain.tokens.filter((t) => t.collectionId === collectionId)
export const txById = (chain: ChainState, id: string | null): ChainTransaction | null => (id ? (chain.transactions.find((t) => t.id === id) ?? null) : null)
export const identityOf = (chain: ChainState, wineryId: string): StoredIdentity | null => chain.identities.find((i) => i.wineryId === wineryId) ?? null
export const anchorOfLot = (chain: ChainState, lotId: string): StoredAnchor | null => chain.anchors.find((a) => a.lotId === lotId) ?? null

/** NFT emitidos y confirmados de un lote (incluye los quemados). */
export const mintedOfLot = (chain: ChainState | undefined, lotId: string): number => (chain ? chain.tokens.filter((t) => t.lotId === lotId).length : 0)

/** ¿El expediente del lote tiene su anclaje confirmado y verificado? (el lote pasa a `ANCHORED`). */
export const isLotAnchored = (chain: ChainState | undefined, lotId: string): boolean => Boolean(chain?.anchors.some((a) => a.lotId === lotId && a.verifiedAt !== null))

/**
 * Marca de tokenización del lote (`LotSummary.tokenization`). Con colección manda la colección
 * (`CLOSED`, `PAUSED`; si no, la última emisión: `MINT_FAILED`, `MINTING`; si no, `READY` o
 * `PUBLISHED`); sin colección, la solicitud abierta (`REQUESTED` o `CHANGES_REQUESTED`).
 */
export function lotTokenizationMark(chain: ChainState | undefined, lotId: string): LotTokenizationMark {
  if (!chain) return { state: 'NONE', quota: 0, minted: 0, collectionId: null }
  const collection = collectionOfLot(chain, lotId)
  if (collection) {
    const last = mintsOf(chain, collection.id).at(-1)
    const state =
      collection.status === 'CLOSED' || collection.status === 'PAUSED'
        ? collection.status
        : last?.status === 'FAILED'
          ? 'MINT_FAILED'
          : last && last.status !== 'CONFIRMED'
            ? 'MINTING'
            : collection.status
    return { state, quota: collection.quota, minted: mintedOfLot(chain, lotId), collectionId: collection.id }
  }
  const open = openRequestOfLot(chain, lotId)
  if (open) return { state: open.status === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'REQUESTED', quota: 0, minted: 0, collectionId: null }
  return { state: 'NONE', quota: 0, minted: 0, collectionId: null }
}
