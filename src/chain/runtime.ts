import { effectiveSetting, profileOf } from '../backoffice/handlers/support'
import type { AuthContext } from '../erp/handlers/auth-context'
import { getErpDb } from '../erp/handlers/db'
import { traceCtx } from '../erp/handlers/trace-context'
import { advanceChain, CHAIN_STEP_MS, enqueueTx, hasChainWork, processChain, resumeHeldMints, setMintEnabled, settleChain, type ChainCtx, type ChainEnv } from './engine'
import { flushChainNotices } from './notices'
import type { ChainAlert, ChainTxKind, ChainTxRef, ReconciliationRun, StartReconciliation, UserRef } from './schemas'
import { clearChainDrift, driftChain, extendTtl, provisionIdentity, runReconciliation, simulateIndexerGap, type ChainDriftInput } from './service'
import { identityOf, pushNotice, type ForcedChainFailure } from './state'
import { isTxInFlight, toTxRef } from './views'

// Puente entre los handlers y los servicios de la Ola 3: contexto de cada operación (reloj de los
// mocks, bodegas y configuración de la base en memoria) y el control de la red simulada.

/** `PUBLIC_API_BASE_URL` de los mocks: base de `token_uri` y de las imágenes públicas de las colecciones. */
export const DEFAULT_PUBLIC_API_BASE_URL = 'http://localhost:4000'
let publicApiBaseUrl = DEFAULT_PUBLIC_API_BASE_URL

/** Cambia la base de las URL públicas de la API que devuelven los mocks (por defecto, la del backend local). */
export function setMockPublicApiBaseUrl(url: string | null | undefined): void {
  publicApiBaseUrl = url?.trim().replace(/\/+$/, '') || DEFAULT_PUBLIC_API_BASE_URL
}
export const getMockPublicApiBaseUrl = (): string => publicApiBaseUrl

function chainEnv(): ChainEnv {
  return {
    winery(wineryId) {
      const w = getErpDb().wineries.find((x) => x.id === wineryId)
      if (!w) return { id: wineryId, slug: wineryId, tradeName: 'Bodega', lotPrefix: 'DOC', status: 'INVITED' }
      const profile = profileOf(w)
      return { id: wineryId, slug: profile.slug, tradeName: w.commercialName, lotPrefix: traceCtx(null).lotPrefix(wineryId), status: w.certificationStatus }
    },
    setting: (key, wineryId) => effectiveSetting(key, wineryId).value,
    publicApiBaseUrl,
    homeDomain: publicApiBaseUrl.replace(/^https?:\/\//, ''),
  }
}

/** Contexto de una operación de cadena o tokenización, con el reloj de los mocks en este instante. */
export function chainCtx(auth: AuthContext | null = null): ChainCtx {
  return { ...traceCtx(auth), env: chainEnv() }
}

/** Persona de plataforma que actúa (`UserRefDto`). */
export const userRefOf = (auth: AuthContext): UserRef => ({ userId: auth.user.id, fullName: auth.user.fullName })

// ---------------------------------------------------------------------------
// Reloj de la red simulada
// ---------------------------------------------------------------------------

export type ChainNetworkMode = 'auto' | 'manual'

/**
 * `auto` (por defecto en el navegador): las transacciones avanzan con el tiempo real, un paso
 * (`CHAIN_STEP_MS`) como mucho entre dos peticiones, así que una emisión se confirma tras unas
 * pocas consultas de la pantalla. `manual` (por defecto en Node): solo avanzan con
 * `mockChain.advance()`, `mockChain.settle()` o `advanceMockClock()`.
 */
let mode: ChainNetworkMode = typeof window === 'undefined' ? 'manual' : 'auto'
let lastSync: number | null = null

/** Lo llama cada petición antes de atenderse: pone la red al día. */
export function syncChainNetwork(): void {
  const db = getErpDb()
  // Una emisión en espera (bodega suspendida, emisión desactivada) continúa cuando su causa desaparece.
  if (db.chain.transactions.some((t) => t.status === 'PENDING' && t.kind === 'MINT_BATCH')) resumeHeldMints(db, chainCtx())
  if (!hasChainWork(db.chain)) {
    lastSync = null
    return
  }
  if (mode === 'auto') {
    const now = Date.now()
    const delta = lastSync === null ? 0 : Math.min(now - lastSync, CHAIN_STEP_MS)
    lastSync = now
    advanceChain(db, chainCtx(), delta)
  } else processChain(db, chainCtx())
}

/**
 * Control de la red simulada (también en `window.__docMocks.chain`). Una transacción recorre
 * `PENDING → BUILDING → SUBMITTED → CONFIRMED`: tres pasos de `stepMs`.
 */
export const mockChain = {
  /** Milisegundos del reloj de la red que dura cada paso de una transacción. */
  stepMs: CHAIN_STEP_MS,
  /** Adelanta el reloj de la red (por defecto, un paso) y devuelve cuántos pasos se dieron. */
  advance(ms: number = CHAIN_STEP_MS): number {
    const steps = advanceChain(getErpDb(), chainCtx(), ms)
    flushChainNotices()
    return steps
  },
  /** Adelanta la red hasta que no quede ninguna transacción en vuelo. */
  settle(): number {
    const steps = settleChain(getErpDb(), chainCtx())
    flushChainNotices()
    return steps
  },
  /**
   * La siguiente transacción que se envíe (o la siguiente de `kind`) falla con `code`
   * (`CHN_AUTH_FAILED` por defecto: definitivo, queda `FAILED` y se reintenta desde el back office).
   * Con un código transitorio (`CHN_RPC_UNAVAILABLE`…) pasa por `RETRYING` y se confirma sola.
   */
  failNext(failure: ForcedChainFailure = {}): void {
    getErpDb().chain.forcedFailures.push(failure)
  },
  /** Transacciones que siguen en vuelo. */
  pending(): ChainTxRef[] {
    return getErpDb().chain.transactions.filter(isTxInFlight).map(toTxRef)
  },
  getMode: (): ChainNetworkMode => mode,
  setMode(next: ChainNetworkMode): void {
    mode = next
    lastSync = null
  },
  /** `CHAIN_MINT_ENABLED` (ADR-011): con `false`, las emisiones aprobadas esperan en `PENDING` con `CHN_MINT_DISABLED`. */
  setMintEnabled(enabled: boolean): void {
    setMintEnabled(getErpDb(), chainCtx(), enabled)
  },
  /**
   * Cadena configurada o no en el entorno. Con `false`: `chain/provision`, `chain/pause` y
   * `chain/unpause` → 409 `CHN_DISABLED`, el registro público sale sin cuentas ni bodegas y una
   * bodega que se active no recibe identidad.
   */
  setEnabled(enabled: boolean): void {
    getErpDb().chain.enabled = enabled
  },
  isEnabled: (): boolean => getErpDb().chain.enabled,
  /**
   * La siguiente confirmación de ese tipo no supera la comprobación del servidor: una emisión queda
   * `FAILED` con la alerta `CRITICAL` `MINT_RANGE_MISMATCH` (no se registran sus NFT) y un anclaje
   * queda `FAILED` con `ANCHOR_MISMATCH` (el lote sigue `CERTIFIED`; en público, `PENDING`).
   */
  mismatchNext(kind: Extract<ChainTxKind, 'MINT_BATCH' | 'ANCHOR_DOSSIER'>): void {
    getErpDb().chain.forcedMismatches.push(kind)
  },
  /** Tarea de TTL: registra `EXTEND_TTL` para el código (`'CODE'`, por defecto) o para el contrato de una bodega. */
  extendTtl(target: 'CODE' | { wineryId: string } = 'CODE', days?: number): ChainTxRef {
    return toTxRef(extendTtl(getErpDb(), chainCtx(), target, days))
  },
  /**
   * Días de vida que le quedan al código (`PlatformChainAccounts.codeTtlDays`): baja sola con el
   * reloj de los mocks. `null` = el backend aún no lo ha leído. Menos de 14 → la conciliación
   * completa abre `TTL_EXPIRING`.
   */
  setCodeTtlDays(days: number | null): void {
    const db = getErpDb()
    db.chain.ttl.code = days === null ? null : new Date(db.clock + days * 86_400_000 + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  },
  /** Igual, para las entradas del contrato de una bodega. */
  setContractTtlDays(wineryId: string, days: number): void {
    const db = getErpDb()
    const contract = identityOf(db.chain, wineryId)?.contract
    if (contract) db.chain.ttl.contracts[contract.address] = new Date(db.clock + days * 86_400_000 + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  },
  /** El indexador se queda atrás: alerta `INDEXER_GAP` y `indexerLagSeconds` alto hasta la siguiente conciliación. */
  indexerGap(ledgers?: number): ChainAlert {
    const alert = simulateIndexerGap(getErpDb(), chainCtx(), ledgers)
    flushChainNotices()
    return alert
  },
  /** La red «dice» otra cosa que la base (dueño de un NFT, pausa o rol de un contrato): la conciliación `FULL` lo detecta. */
  drift(input: ChainDriftInput): void {
    driftChain(getErpDb(), chainCtx(), input)
  },
  /** La red vuelve a coincidir con la base: la siguiente conciliación cierra sola esas alertas. */
  clearDrift(): void {
    clearChainDrift(getErpDb(), chainCtx())
  },
  /** Ejecuta una conciliación como la tarea programada (por defecto, completa y de todo). */
  reconcile(body: StartReconciliation = { scope: 'ALL', depth: 'FULL' }): ReconciliationRun {
    const run = runReconciliation(getErpDb(), chainCtx(), body, 'SCHEDULED')
    flushChainNotices()
    return run
  },
}
export type MockChain = typeof mockChain

// ---------------------------------------------------------------------------
// Hechos de la Ola 1 que mueven la cadena (§3.1, §3.5)
// ---------------------------------------------------------------------------

/** `winery.activated`: la bodega recibe su cuenta y su contrato. */
export function onWineryActivated(wineryId: string): void {
  const db = getErpDb()
  // Con la cadena sin configurar no se aprovisiona nada (queda `NOT_PROVISIONED`).
  if (!db.chain.enabled) return
  const status = identityOf(db.chain, wineryId)?.status
  if (status && status !== 'FAILED') return
  provisionIdentity(db, chainCtx(), wineryId, null)
}

/** `winery.status_changed`: suspender o revocar pausa las colecciones publicadas; revocar rechaza las solicitudes abiertas. */
export function onWineryStatusChanged(wineryId: string, status: string): void {
  if (status !== 'SUSPENDED' && status !== 'REVOKED') return
  const db = getErpDb()
  const ctx = chainCtx()
  const reason = status === 'SUSPENDED' ? 'Bodega suspendida' : 'Bodega revocada'
  for (const c of db.chain.collections) {
    if (c.wineryId !== wineryId || c.status !== 'PUBLISHED') continue
    c.status = 'PAUSED'
    c.updatedAt = ctx.now
    c.statusHistory.push({ status: 'PAUSED', at: ctx.now, by: 'Sistema', reason })
    pushNotice(db.chain, { at: ctx.now, type: 'COLLECTION_PAUSED', wineryId, collectionId: c.id, message: reason })
  }
  if (status !== 'REVOKED') return
  // Revocar pausa además el contrato en la red (lo firma el operador; solo la bodega lo reanuda).
  const identity = identityOf(db.chain, wineryId)
  if (identity?.contract && !identity.contract.paused) {
    enqueueTx(db, ctx, { kind: 'PAUSE_CONTRACT', intentKey: `pause:${identity.contract.address}:revoked:${ctx.now}`, subject: { type: 'CONTRACT', id: identity.contract.address }, wineryId, intent: { wineryId, contract: identity.contract.address, reason } })
  }
  for (const r of db.chain.requests) {
    if (r.wineryId !== wineryId || !['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED'].includes(r.status)) continue
    r.status = 'REJECTED'
    r.decision = { outcome: 'REJECTED', at: ctx.now, reason, by: { userId: null, fullName: null, system: true } }
    r.updatedAt = ctx.now
    r.history.push({ status: 'REJECTED', at: ctx.now, by: 'Sistema', note: reason })
  }
}
