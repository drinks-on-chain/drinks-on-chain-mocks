import { stroopsToXlm, type ChainCtx } from '../chain/engine'
import type { DashboardChain, PublicChainRegistry, PublicDossierVerification } from '../chain/schemas'
import {
  collectionOfLot,
  identityOf,
  isOpenRequest,
  mintsOf,
  openRequestOfLot,
  tokensOf,
  txById,
  type ChainState,
  type StoredClosure,
  type StoredCollection,
  type StoredMint,
  type StoredRequest,
  type StoredToken,
} from '../chain/state'
import { dossierAnchorView, explorerAccountUrl, explorerContractUrl, identityView, isTxInFlight, publicAnchorView, toTxRef, txRefOf } from '../chain/views'
import type { Lot, TraceDashboardTokenization } from '../erp/schemas'
import { DOSSIER_HASH_ALGORITHM } from '../erp/schemas/lot-views'
import { bottleCodesSummary, bottleLotOf, lotBottling, lotDenomination, lotDossier, lotLocks, toLotView, type TraceState } from '../erp/trace/state'
import type {
  Collection,
  CollectionMetrics,
  CollectionSummary,
  DashboardTokenization,
  LotClosure,
  LotClosureSummary,
  LotTokenizationStatus,
  Mint,
  PlatformTokenizationRequest,
  PriceSuggestionAvailable,
  PriceSuggestionUnavailable,
  PublicNftMetadata,
  SaleState,
  Token,
  TokenCounts,
  TokenStatus,
  TokenizationRequest,
  TokenizationRequestSummary,
  WineryChainAccountView,
  WineryLotClosure,
} from './schemas'
import { closureOf, tokenizationBlockers, tokenizationLimits } from './service'

// Vistas del dominio `tokenization`: los DTO del OpenAPI a partir del estado guardado.

const lotOf = (state: TraceState, lotId: string): Lot => {
  const lot = state.lots.find((l) => l.id === lotId)
  if (!lot) throw new Error(`Tokenización: el lote ${lotId} no existe`)
  return lot
}

const wineryRef = (ctx: ChainCtx, wineryId: string) => {
  const w = ctx.env.winery(wineryId)
  return { slug: w.slug, tradeName: w.tradeName }
}

const bottlesOf = (state: TraceState, lot: Lot): number | null => (lotBottling(state, lot.id) ? bottleCodesSummary(bottleLotOf(state, lot.id)).active : null)

// ----- Solicitudes -----

export function requestSummary(state: TraceState, ctx: ChainCtx, r: StoredRequest): TokenizationRequestSummary {
  const lot = lotOf(state, r.lotId)
  return {
    id: r.id,
    wineryId: r.wineryId,
    winery: wineryRef(ctx, r.wineryId),
    lotId: r.lotId,
    lot: { reference: lot.reference, lotCode: lot.lotCode, name: lot.name, productType: lot.productType, stage: lot.stage, harvestYear: lot.harvestYear, estimatedBottles: lot.estimatedBottles, bottles: bottlesOf(state, lot) },
    kind: r.kind,
    status: r.status,
    quantity: r.quantity,
    resultingQuota: r.resultingQuota,
    requiresApproval: r.requiresApproval,
    assignee: r.assignee,
    submittedAt: r.submittedAt,
    submittedBy: r.submittedBy,
    updatedAt: r.updatedAt,
    collectionId: r.collectionId,
  }
}

/** Solicitud tal como la ve la bodega (sin notas internas ni sugerencia de precio). */
export function requestView(state: TraceState, ctx: ChainCtx, r: StoredRequest): TokenizationRequest {
  return {
    ...requestSummary(state, ctx, r),
    commercialDraft: r.commercialDraft,
    price: r.price,
    wineryNotes: r.wineryNotes,
    changeRequests: r.changeRequests,
    decision: r.decision,
    withdrawn: r.withdrawn,
    limitsAtSubmission: r.limitsAtSubmission,
    history: r.history,
  }
}

/** Sugerencia de precio según `precio.politica` (hoy «Sin definir», A-32). */
export function priceSuggestion(ctx: ChainCtx, wineryId: string): PriceSuggestionAvailable | PriceSuggestionUnavailable {
  const policy = ctx.env.setting('precio.politica', wineryId) as { amountMinor?: unknown; version?: unknown; source?: unknown } | null | undefined
  if (policy && typeof policy === 'object' && Number.isInteger(policy.amountMinor) && (policy.amountMinor as number) >= 1) {
    return { available: true, amountMinor: policy.amountMinor as number, currency: 'BOB', source: policy.source === 'WINERY' ? 'WINERY' : 'GLOBAL', policyVersion: String(policy.version ?? '1') }
  }
  return { available: false, reason: 'POLICY_UNDEFINED' }
}

/** Solicitud tal como la ve operaciones: con notas internas, sugerencia de precio y la revisión del lote (§5.4). */
export function platformRequestView(state: TraceState, ctx: ChainCtx, r: StoredRequest): PlatformTokenizationRequest {
  const lot = lotOf(state, r.lotId)
  const view = toLotView(state, lot, ctx)
  const events = state.lotEvents.filter((e) => e.lotId === lot.id).sort((a, b) => a.seq - b.seq)
  const last = events.at(-1) ?? null
  const suggestion = priceSuggestion(ctx, r.wineryId)
  return {
    ...requestView(state, ctx, r),
    internalNotes: r.internalNotes,
    priceSuggestion: suggestion,
    review: {
      lot: view,
      traceability: {
        publicEventsCount: events.filter((e) => e.visibility === 'PUBLIC').length,
        lastEvent: last ? (({ lotId: _lotId, ...event }) => event)(last) : null,
        locks: lotLocks(state, lot, ctx.today),
        estimatedReadyDate: view.estimatedReadyDate,
        complianceIssuesOpen: view.complianceIssuesOpen,
        denomination: lotDenomination(state, lot, ctx.now),
        dossierStatus: view.dossierStatus,
      },
      limits: tokenizationLimits(state, lot, isOpenRequest(r) ? r.id : null),
      chainIdentity: identityView(state.chain, r.wineryId),
      priceSuggestion: suggestion,
      otherCollectionsOfWinery: state.chain.collections.filter((c) => c.wineryId === r.wineryId && c.lotId !== r.lotId).map((c) => collectionSummary(state, ctx, c)),
    },
  }
}

// ----- NFT -----

export function tokenCounts(tokens: readonly Pick<StoredToken, 'status'>[]): TokenCounts {
  const count = (status: TokenStatus) => tokens.filter((t) => t.status === status).length
  return {
    minted: tokens.length,
    available: count('MINTED'),
    reserved: count('RESERVED'),
    sold: count('SOLD'),
    redeemable: count('REDEEMABLE'),
    passActive: count('PASS_ACTIVE'),
    redeemed: count('REDEEMED'),
    burned: count('BURNED'),
    expired: count('EXPIRED'),
  }
}

export function tokenView(chain: ChainState, t: StoredToken): Token {
  const contract = identityOf(chain, t.wineryId)?.contract
  const { mintTxId, burnTxId, ...rest } = t
  return {
    ...rest,
    contractAddress: contract?.address ?? '',
    mintTx: txRefOf(chain, mintTxId)!,
    burnTx: txRefOf(chain, burnTxId),
    // `token_uri(id)` = URI base + id (DS-13).
    metadataUrl: `${contract?.baseUri ?? ''}${t.tokenId}`,
  }
}

// ----- Colecciones -----

export function mintView(chain: ChainState, m: StoredMint): Mint {
  const { txIds, ...rest } = m
  return { ...rest, transactions: txIds.map((id) => txRefOf(chain, id)!).filter(Boolean) }
}

function saleStateOf(collection: StoredCollection, counts: TokenCounts): SaleState | null {
  if (collection.status !== 'PUBLISHED') return null
  if (counts.available === 0) return 'SOLD_OUT'
  return collection.redeemableSince ? 'ON_SALE' : 'PRESALE'
}

export function collectionSummary(state: TraceState, ctx: ChainCtx, c: StoredCollection): CollectionSummary {
  const chain = state.chain
  const lot = lotOf(state, c.lotId)
  const mints = mintsOf(chain, c.id)
  const last = mints.at(-1)
  const counts = tokenCounts(tokensOf(chain, c.id))
  const contract = identityOf(chain, c.wineryId)?.contract
  return {
    id: c.id,
    slug: c.slug,
    wineryId: c.wineryId,
    winery: wineryRef(ctx, c.wineryId),
    lotId: c.lotId,
    lot: { reference: lot.reference, lotCode: lot.lotCode, name: lot.name, productType: lot.productType ?? 'WINE', harvestYear: lot.harvestYear, stage: lot.stage, estimatedReadyDate: toLotView(state, lot, ctx).estimatedReadyDate },
    status: c.status,
    mintStatus: last?.status ?? 'PENDING',
    saleState: saleStateOf(c, counts),
    quota: c.quota,
    pendingMintQuantity: mints.filter((m) => m.status !== 'CONFIRMED').reduce((n, m) => n + m.quantity, 0),
    counts,
    price: c.price,
    name: c.commercial.name,
    coverImageUrl: c.commercial.images.find((i) => i.isCover)?.url ?? null,
    estimatedRedeemDate: c.commercial.estimatedRedeemDate,
    contract: { address: contract?.address ?? '', explorerUrl: contract ? explorerContractUrl(contract.address) : null },
    redeemable: c.redeemableSince !== null,
    redeemableSince: c.redeemableSince,
    publishedAt: c.publishedAt,
    closedAt: c.closedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

export function collectionMetrics(state: TraceState, c: StoredCollection): CollectionMetrics {
  const chain = state.chain
  const lot = lotOf(state, c.lotId)
  const mints = mintsOf(chain, c.id)
  const tokens = tokensOf(chain, c.id)
  const txIds = new Set([...mints.flatMap((m) => m.txIds), ...tokens.map((t) => t.burnTxId).filter((id): id is string => id !== null)])
  const txs = chain.transactions.filter((t) => txIds.has(t.id))
  const fees = txs.reduce((sum, t) => sum + BigInt(t.feeChargedStroops ?? '0'), 0n)
  const confirmed = mints.map((m) => m.confirmedAt).filter((d): d is string => d !== null).sort()
  const sold = tokens.map((t) => t.soldAt).filter((d): d is string => d !== null).sort()
  return {
    counts: tokenCounts(tokens),
    quota: c.quota,
    authorizedVsEstimatePercent: lot.estimatedBottles ? Math.round((c.quota / lot.estimatedBottles) * 1000) / 10 : null,
    firstMintedAt: confirmed[0] ?? null,
    publishedAt: c.publishedAt,
    firstSaleAt: sold[0] ?? null,
    chainCosts: { feesChargedXlm: stroopsToXlm(fees.toString()), transactions: txs.length },
    byMint: mints.map((m) => ({ sequence: m.sequence, quantity: m.quantity, confirmedAt: m.confirmedAt })),
  }
}

/** El cierre sin sus ítems ni el dato interno de la bodega. */
const closureBase = ({ wineryId: _wineryId, items: _items, ...rest }: StoredClosure): LotClosureSummary => rest

export function closureView(chain: ChainState, closure: StoredClosure): LotClosure {
  return { ...closureBase(closure), items: closure.items.map(({ burnTxId, ...item }) => ({ ...item, burnTx: txRefOf(chain, burnTxId) })) }
}

export const closureSummary = (closure: StoredClosure): LotClosureSummary => closureBase(closure)

/** Cierre visto desde el ERP: sin datos de pedidos (`orderId`, `paidAt`, `note`). */
export function wineryClosureView(chain: ChainState, closure: StoredClosure): WineryLotClosure {
  return { ...closureBase(closure), items: closure.items.map((i) => ({ tokenId: i.tokenId, bottleNumber: i.bottleNumber, status: i.status, outcome: i.outcome, burnTx: txRefOf(chain, i.burnTxId), resolvedAt: i.resolvedAt })) }
}

export function collectionView(state: TraceState, ctx: ChainCtx, c: StoredCollection): Collection {
  const chain = state.chain
  const closure = closureOf(state, ctx, c)
  return {
    ...collectionSummary(state, ctx, c),
    commercial: c.commercial,
    pricePolicySnapshot: (c.pricePolicySnapshot ?? null) as Collection['pricePolicySnapshot'],
    priceHistory: c.priceHistory,
    mints: mintsOf(chain, c.id).map((m) => mintView(chain, m)),
    quotaHistory: c.quotaHistory,
    statusHistory: c.statusHistory,
    anchor: dossierAnchorView(chain, c.lotId),
    closure: closure ? closureView(chain, closure) : null,
    metrics: collectionMetrics(state, c),
  }
}

/** Transacciones de una colección (emisiones y quemas), de la más reciente a la más antigua. */
export function collectionTransactions(chain: ChainState, c: StoredCollection) {
  const ids = new Set([...mintsOf(chain, c.id).flatMap((m) => m.txIds), ...tokensOf(chain, c.id).map((t) => t.burnTxId), ...(chain.closures.find((x) => x.collectionId === c.id)?.items.map((i) => i.burnTxId) ?? [])])
  return chain.transactions
    .filter((t) => ids.has(t.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toTxRef)
}

// ----- Lote y cuenta de la bodega -----

export function lotTokenizationStatus(state: TraceState, ctx: ChainCtx, lot: Lot): LotTokenizationStatus {
  const chain = state.chain
  const blockers = tokenizationBlockers(state, lot)
  const limits = tokenizationLimits(state, lot)
  const open = openRequestOfLot(chain, lot.id)
  const collection = collectionOfLot(chain, lot.id)
  if (blockers.length === 0 && limits.maxQuantity === 0) {
    blockers.push({
      field: 'quantity',
      code: limits.basis === 'BOTTLES' ? 'TOK_QUOTA_EXCEEDS_BOTTLES' : 'TOK_QUOTA_EXCEEDS_ESTIMATE',
      message: 'Ya está autorizada toda la cuota posible del lote',
      expected: limits.basis === 'BOTTLES' ? limits.bottles : limits.estimatedBottles,
      actual: limits.authorizedQuota + limits.pendingQuantity,
      meta: { maxQuantity: 0 },
    })
  }
  return {
    lotId: lot.id,
    tokenizable: blockers.length === 0,
    blockers,
    limits,
    approvalRequired: ctx.env.setting('tokenizacion.requiereAprobacion', lot.wineryId) !== false,
    chainIdentity: { status: identityOf(chain, lot.wineryId)?.status ?? 'NOT_PROVISIONED' },
    openRequest: open ? requestSummary(state, ctx, open) : null,
    collection: collection ? collectionSummary(state, ctx, collection) : null,
    requests: chain.requests
      .filter((r) => r.lotId === lot.id)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .map((r) => requestSummary(state, ctx, r)),
  }
}

/** `GET /v1/organizations/current/chain-account` y `GET /v1/platform/wineries/{id}/chain-account` (§3.4). */
export function chainAccountView(state: TraceState, ctx: ChainCtx, wineryId: string): WineryChainAccountView {
  const chain = state.chain
  const collections = chain.collections.filter((c) => c.wineryId === wineryId)
  const txs = chain.transactions.filter((t) => t.wineryId === wineryId)
  const fees = txs.reduce((sum, t) => sum + BigInt(t.feeChargedStroops ?? '0'), 0n)
  return {
    identity: identityView(chain, wineryId),
    totals: tokenCounts(chain.tokens.filter((t) => t.wineryId === wineryId)),
    byLot: collections.map((c) => {
      const lot = lotOf(state, c.lotId)
      return {
        lotId: lot.id,
        reference: lot.reference,
        lotCode: lot.lotCode,
        name: lot.name,
        stage: lot.stage,
        collectionId: c.id,
        collectionStatus: c.status,
        quota: c.quota,
        counts: tokenCounts(tokensOf(chain, c.id)),
        anchor: dossierAnchorView(chain, lot.id),
      }
    }),
    recentTransactions: [...txs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map(toTxRef),
    chainCosts: { feesChargedXlm: stroopsToXlm(fees.toString()), since: txs.map((t) => t.createdAt).sort()[0] ?? null },
  }
}

// ----- Tableros -----

export function traceDashboardTokenization(chain: ChainState | undefined, wineryId: string | null): TraceDashboardTokenization {
  if (!chain) return { openRequests: 0, changesRequested: 0, collectionsPublished: 0 }
  const mine = <T extends { wineryId: string }>(items: readonly T[]) => (wineryId ? items.filter((i) => i.wineryId === wineryId) : [...items])
  const requests = mine(chain.requests)
  return {
    openRequests: requests.filter(isOpenRequest).length,
    changesRequested: requests.filter((r) => r.status === 'CHANGES_REQUESTED').length,
    collectionsPublished: mine(chain.collections).filter((c) => c.status === 'PUBLISHED').length,
  }
}

export function dashboardTokenization(chain: ChainState, now: string): DashboardTokenization {
  const open = chain.requests.filter(isOpenRequest)
  const oldest = open.map((r) => r.submittedAt).sort()[0]
  const lastMint = (c: StoredCollection) => mintsOf(chain, c.id).at(-1)
  return {
    submitted: open.filter((r) => r.status === 'SUBMITTED').length,
    inReview: open.filter((r) => r.status === 'IN_REVIEW').length,
    changesRequested: open.filter((r) => r.status === 'CHANGES_REQUESTED').length,
    oldestOpenHours: oldest ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(oldest)) / 3_600_000)) : 0,
    collectionsMinting: chain.collections.filter((c) => c.status === 'MINTING' || (lastMint(c) && lastMint(c)!.status !== 'CONFIRMED' && lastMint(c)!.status !== 'FAILED')).length,
    mintFailures: chain.collections.filter((c) => lastMint(c)?.status === 'FAILED').length,
    collectionsPublished: chain.collections.filter((c) => c.status === 'PUBLISHED').length,
    shortfallsOpen: chain.closures.filter((c) => c.status === 'SHORTFALL_OPEN').length,
  }
}

/** Minutos sin confirmarse a partir de los cuales una transacción cuenta como atascada (`TX_STUCK`). */
export const TX_STUCK_MINUTES = 15

export function dashboardChain(chain: ChainState, now: string): DashboardChain {
  const open = chain.alerts.filter((a) => a.resolvedAt === null)
  const last = [...chain.runs].filter((r) => r.finishedAt).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0]
  return {
    network: chain.network,
    operationsBalanceXlm: chain.platform.operationsBalanceXlm,
    anchorBalanceXlm: chain.platform.anchorBalanceXlm,
    failedTransactions: chain.transactions.filter((t) => t.status === 'FAILED' && !t.abandoned).length,
    stuckTransactions: chain.transactions.filter((t) => isTxInFlight(t) && t.status !== 'PENDING' && Date.parse(now) - Date.parse(t.updatedAt) > TX_STUCK_MINUTES * 60_000).length,
    openAlerts: { critical: open.filter((a) => a.level === 'CRITICAL').length, warning: open.filter((a) => a.level === 'WARNING').length },
    lastReconciliation: last ? { at: last.finishedAt!, status: last.status } : null,
    indexerLagSeconds: 12,
  }
}

// ----- Público -----

const TOKEN_STATUS_LABELS: Record<TokenStatus, string> = {
  MINTED: 'Emitido',
  RESERVED: 'Reservado',
  SOLD: 'Vendido',
  REDEEMABLE: 'Canjeable',
  PASS_ACTIVE: 'Con pase de canje',
  REDEEMED: 'Canjeado',
  BURNED: 'Quemado',
  EXPIRED: 'Vencido',
}

/** `GET /v1/public/nft/{winerySlug}/{tokenId}` (§6.5): metadatos del NFT, sin datos del consumidor. `null` = no existe. */
export function publicNftMetadata(state: TraceState, ctx: ChainCtx & { passportBaseUrl: string }, wineryId: string, tokenId: number): PublicNftMetadata | null {
  const chain = state.chain
  const token = chain.tokens.find((t) => t.wineryId === wineryId && t.tokenId === tokenId)
  const collection = token && chain.collections.find((c) => c.id === token.collectionId)
  const contract = identityOf(chain, wineryId)?.contract
  if (!token || !collection || !contract) return null
  const lot = lotOf(state, token.lotId)
  const winery = wineryRef(ctx, wineryId)
  const published = collection.publishedAt !== null
  const passportUrl = lot.lotCode ? `${ctx.passportBaseUrl}/b/${lot.lotCode}` : null
  const beverage = lot.productType === 'SINGANI' ? 'Singani' : 'Vino'
  return {
    // P-13: «Botella n de N» usa la cuota vigente.
    name: `${collection.commercial.name} · Botella ${token.bottleNumber} de ${collection.quota}`,
    description: published ? collection.commercial.description : `Botella ${token.bottleNumber} del lote ${lot.reference} de ${winery.tradeName}.`,
    image: published ? (collection.commercial.images.find((i) => i.isCover)?.url ?? null) : null,
    external_url: passportUrl ?? `${ctx.passportBaseUrl}/colecciones/${collection.slug}`,
    attributes: [
      { trait_type: 'Bodega', value: winery.tradeName },
      { trait_type: 'Lote', value: lot.reference },
      { trait_type: 'Bebida', value: beverage },
      { trait_type: 'Añada', value: lot.harvestYear },
      { trait_type: 'Botella n.º', value: token.bottleNumber },
      { trait_type: 'Colección', value: collection.commercial.name },
      { trait_type: 'Estado', value: TOKEN_STATUS_LABELS[token.status] },
    ],
    properties: { winery, lotReference: lot.reference, lotCode: lot.lotCode, bottleNumber: token.bottleNumber, collectionSize: collection.quota, tokenId: token.tokenId, contract: contract.address, status: token.status, passportUrl },
  }
}

/** `GET /v1/public/chain/registry` (§3.2): cuentas y contratos oficiales. */
export function publicChainRegistry(state: TraceState, ctx: ChainCtx): PublicChainRegistry {
  const chain = state.chain
  return {
    network: chain.network,
    networkPassphrase: chain.platform.networkPassphrase,
    wasmHash: chain.platform.wasmHash,
    platform: { operationsAccount: chain.platform.operationsAddress, anchorAccount: chain.platform.anchorAddress },
    wineries: chain.identities
      .filter((i) => (i.status === 'ACTIVE' || i.status === 'PAUSED') && i.accountAddress && i.contract && i.since)
      .map((i) => {
        const w = ctx.env.winery(i.wineryId)
        return {
          slug: w.slug,
          tradeName: w.tradeName,
          symbol: i.contract!.symbol,
          account: i.accountAddress!,
          contract: i.contract!.address,
          accountExplorerUrl: explorerAccountUrl(i.accountAddress!),
          contractExplorerUrl: explorerContractUrl(i.contract!.address),
          paused: i.contract!.paused,
          since: i.since!,
        }
      }),
    generatedAt: ctx.now,
  }
}

/** `GET /v1/public/lots/{lotCode}/verification` (§7.3): las cuatro comprobaciones del anclaje. */
export function publicDossierVerification(state: TraceState, ctx: ChainCtx, lot: Lot, canonicalUrl: string): PublicDossierVerification {
  const chain = state.chain
  const dossier = lotDossier(state, lot.id)
  const closed = dossier?.status === 'CLOSED'
  const anchor = publicAnchorView(chain, lot.id)
  const stored = chain.anchors.find((a) => a.lotId === lot.id)
  const tx = stored ? txById(chain, stored.txId) : null
  const anchored = anchor?.status === 'ANCHORED'
  const memoMatches = anchored ? anchor.memoHashHex === dossier?.hash : null
  const official = anchored ? anchor.account === chain.platform.anchorAddress && tx?.sourceAccount === chain.platform.anchorAddress : null
  return {
    lotCode: lot.lotCode ?? lot.reference,
    dossier: { status: closed ? 'CLOSED' : 'OPEN', hash: closed ? (dossier.hash ?? null) : null, algorithm: DOSSIER_HASH_ALGORITHM, closedAt: closed ? dossier.closedAt : null, canonicalUrl: closed ? canonicalUrl : null },
    anchor,
    officialAnchorAccount: chain.platform.anchorAddress,
    checks: [
      { key: 'DOSSIER_CLOSED', pass: closed, message: closed ? 'El expediente del lote está cerrado y tiene su huella' : 'El expediente del lote aún no está cerrado' },
      {
        key: 'ANCHOR_CONFIRMED',
        pass: closed ? anchored : null,
        message: !closed ? 'Aún no aplica: el expediente no está cerrado' : anchored ? 'La transacción de anclaje está confirmada en la red' : 'Anclaje en la red: pendiente',
      },
      { key: 'MEMO_MATCHES_HASH', pass: memoMatches, message: memoMatches === null ? 'Aún no aplica: no hay anclaje confirmado' : memoMatches ? 'El memo de la transacción coincide con la huella del expediente' : 'El memo de la transacción no coincide con la huella del expediente' },
      { key: 'ANCHOR_ACCOUNT_OFFICIAL', pass: official, message: official === null ? 'Aún no aplica: no hay anclaje confirmado' : official ? 'La transacción la firmó la cuenta de anclaje oficial de Drinks on Chain' : 'La transacción no la firmó la cuenta de anclaje oficial' },
    ],
    verifiedOnChainAt: anchored ? (stored?.verifiedAt ?? null) : null,
    checkedAt: ctx.now,
  }
}
