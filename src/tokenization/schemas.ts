import { z } from 'zod'
import { ChainIdentityStatusSchema, ChainTxRefSchema, DossierAnchorSchema, UserRefSchema, WineryChainIdentitySchema, WineryRefSchema } from '../chain/schemas'
import { IsoDateTimeSchema } from '../erp/schemas/common'
import { DoEvaluationSchema, ErrorDetailSchema, LotEventSchema, LotLockInfoSchema, LotProductTypeSchema, LotSchema, LotStageCodeSchema, TraceActorSchema } from '../erp/schemas/lots'

// Dominio `tokenization` (contrato de la Ola 3, `plan/contratos/o3-tokenizacion.md` §5, §6 y §8.4):
// solicitudes, datos comerciales y precio, colecciones, emisiones, NFT por botella, cierre con
// faltante, métricas, metadatos públicos del NFT y la cuenta de la bodega. Generado a partir de los
// DTO del OpenAPI del backend (rama de la apertura de la Ola 3). `XxxDto` = `XxxSchema` / tipo `Xxx`.

export const AddTokenizationNoteSchema = z.object({
  text: z.string().min(1).max(2000),
})
export type AddTokenizationNote = z.infer<typeof AddTokenizationNoteSchema>

export const CollectionImageInputSchema = z.object({
  /** `key` de `POST /v1/uploads` (una imagen) */
  key: z.string(),
  /** Texto alternativo */
  alt: z.string().max(300),
  /** Portada (una sola) */
  isCover: z.boolean().optional(),
})
export type CollectionImageInput = z.infer<typeof CollectionImageInputSchema>

export const CollectionCommercialInputSchema = z.object({
  name: z.string().min(3).max(120).optional(),
  description: z.string().min(20).max(4000).optional(),
  tastingNotes: z.string().max(2000).nullable().optional(),
  pairing: z.string().max(1000).nullable().optional(),
  imageKeys: z.array(CollectionImageInputSchema).max(8).optional(),
  /** Por defecto, la `estimatedReadyDate` del lote */
  estimatedRedeemDate: z.iso.date().nullable().optional(),
})
export type CollectionCommercialInput = z.infer<typeof CollectionCommercialInputSchema>

export const PRICE_CURRENCIES = ['BOB'] as const
export const PriceCurrencySchema = z.enum(PRICE_CURRENCIES)
export type PriceCurrency = z.infer<typeof PriceCurrencySchema>

export const CollectionPriceInputSchema = z.object({
  /** Centavos de boliviano (180,00 Bs = 18000) */
  amountMinor: z.number().int().min(1),
  currency: PriceCurrencySchema,
})
export type CollectionPriceInput = z.infer<typeof CollectionPriceInputSchema>

export const ApproveTokenizationRequestSchema = z.object({
  commercial: CollectionCommercialInputSchema.optional(),
  /** El precio no es obligatorio para aprobar (A-32) */
  price: CollectionPriceInputSchema.nullable().optional(),
  /** Publicar la colección en cuanto se confirme la emisión */
  publishOnMint: z.boolean().optional(),
  /** Motivo (obligatorio si actúa el back office sobre un tercero) */
  reason: z.string().min(3).max(500).nullable().optional(),
})
export type ApproveTokenizationRequest = z.infer<typeof ApproveTokenizationRequestSchema>

export const TOKENIZATION_COLLECTION_STATUSES = ['MINTING', 'READY', 'PUBLISHED', 'PAUSED', 'CLOSED'] as const
export const CollectionStatusSchema = z.enum(TOKENIZATION_COLLECTION_STATUSES)
export type CollectionStatus = z.infer<typeof CollectionStatusSchema>

export const TokenCountsSchema = z.object({
  /** Emitidos confirmados (incluye los quemados) */
  minted: z.number().int().min(0),
  /** `MINTED` no reservados */
  available: z.number().int().min(0),
  /** Apartados por un pedido (Ola 4) */
  reserved: z.number().int().min(0),
  /** Pagados y entregados (Ola 4) */
  sold: z.number().int().min(0),
  /** Canjeables: lote anclado, dentro de la ventana */
  redeemable: z.number().int().min(0),
  /** Con pase de canje vigente (Ola 5) */
  passActive: z.number().int().min(0),
  /** Canje confirmado (Ola 5) */
  redeemed: z.number().int().min(0),
  /** Quema confirmada (canje o cierre con faltante) */
  burned: z.number().int().min(0),
  /** Ventana de canje vencida (Ola 5) */
  expired: z.number().int().min(0),
})
export type TokenCounts = z.infer<typeof TokenCountsSchema>

export const ChainAccountLotSchema = z.object({
  lotId: z.string(),
  reference: z.string(),
  lotCode: z.string().nullable(),
  name: z.string(),
  stage: LotStageCodeSchema,
  collectionId: z.string(),
  collectionStatus: CollectionStatusSchema,
  quota: z.number().int().min(1),
  counts: TokenCountsSchema,
  anchor: DossierAnchorSchema.nullable(),
})
export type ChainAccountLot = z.infer<typeof ChainAccountLotSchema>

export const CLOSURE_ITEM_OUTCOMES = ['BURN_UNSOLD', 'MANUAL_REFUND', 'MANUAL_SUBSTITUTE', 'PENDING'] as const
export const ClosureItemOutcomeSchema = z.enum(CLOSURE_ITEM_OUTCOMES)
export type ClosureItemOutcome = z.infer<typeof ClosureItemOutcomeSchema>

export const CollectionChainCostsSchema = z.object({
  feesChargedXlm: z.string(),
  transactions: z.number().int().min(0),
})
export type CollectionChainCosts = z.infer<typeof CollectionChainCostsSchema>

export const CollectionCommercialDraftSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  tastingNotes: z.string().nullable(),
  pairing: z.string().nullable(),
  imageKeys: z.array(CollectionImageInputSchema),
  estimatedRedeemDate: z.iso.date().nullable(),
})
export type CollectionCommercialDraft = z.infer<typeof CollectionCommercialDraftSchema>

export const CollectionImageSchema = z.object({
  id: z.string(),
  key: z.string(),
  /** SHA-256 del archivo, en hex */
  sha256: z.string(),
  /** Colección publicada: `GET /v1/public/collections/images/{id}` de esta API (pública y cacheable). Antes de publicar: URL firmada de corta vida */
  url: z.string(),
  alt: z.string(),
  isCover: z.boolean(),
})
export type CollectionImage = z.infer<typeof CollectionImageSchema>

export const CollectionCommercialSchema = z.object({
  name: z.string(),
  description: z.string(),
  tastingNotes: z.string().nullable(),
  pairing: z.string().nullable(),
  estimatedRedeemDate: z.iso.date().nullable(),
  images: z.array(CollectionImageSchema),
})
export type CollectionCommercial = z.infer<typeof CollectionCommercialSchema>

export const CollectionContractRefSchema = z.object({
  address: z.string(),
  explorerUrl: z.string().nullable(),
})
export type CollectionContractRef = z.infer<typeof CollectionContractRefSchema>

export const CollectionLotRefSchema = z.object({
  reference: z.string(),
  lotCode: z.string().nullable(),
  name: z.string(),
  productType: LotProductTypeSchema,
  harvestYear: z.number().int(),
  stage: LotStageCodeSchema,
  estimatedReadyDate: z.iso.date().nullable(),
})
export type CollectionLotRef = z.infer<typeof CollectionLotRefSchema>

/** De la última emisión */
export const MINT_STATUSES = ['PENDING', 'IN_PROGRESS', 'CONFIRMED', 'FAILED'] as const
export const MintStatusSchema = z.enum(MINT_STATUSES)
export type MintStatus = z.infer<typeof MintStatusSchema>

/** Derivado; `null` si no está `PUBLISHED`. `PRESALE` hasta el anclaje; `ON_SALE` después */
export const SALE_STATES = ['PRESALE', 'ON_SALE', 'SOLD_OUT'] as const
export const SaleStateSchema = z.enum(SALE_STATES)
export type SaleState = z.infer<typeof SaleStateSchema>

export const PRICE_SOURCES = ['POLICY_SUGGESTED', 'MANUAL'] as const
export const PriceSourceSchema = z.enum(PRICE_SOURCES)
export type PriceSource = z.infer<typeof PriceSourceSchema>

export const CollectionPriceSchema = z.object({
  amountMinor: z.number().int().min(1),
  currency: PriceCurrencySchema,
  source: PriceSourceSchema,
  setAt: IsoDateTimeSchema,
  setBy: UserRefSchema,
})
export type CollectionPrice = z.infer<typeof CollectionPriceSchema>

export const MintRangeSchema = z.object({
  firstTokenId: z.number().int().min(0),
  lastTokenId: z.number().int().min(0),
  firstBottleNumber: z.number().int().min(1),
  lastBottleNumber: z.number().int().min(1),
})
export type MintRange = z.infer<typeof MintRangeSchema>

export const MintSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  requestId: z.string(),
  /** 1 = inicial; 2… = ampliaciones */
  sequence: z.number().int().min(1),
  quantity: z.number().int().min(1),
  status: MintStatusSchema,
  /** Lo enviado como `lot` a `mint_batch`: la referencia del lote */
  lotArg: z.string(),
  ranges: z.array(MintRangeSchema),
  /** Una por trozo de hasta 32 000 */
  transactions: z.array(ChainTxRefSchema),
  createdAt: IsoDateTimeSchema,
  confirmedAt: IsoDateTimeSchema.nullable(),
})
export type Mint = z.infer<typeof MintSchema>

/** Lo deduce el servidor: sin colección, `INITIAL`; con colección, `QUOTA_INCREASE` */
export const TOKENIZATION_REQUEST_KINDS = ['INITIAL', 'QUOTA_INCREASE'] as const
export const TokenizationRequestKindSchema = z.enum(TOKENIZATION_REQUEST_KINDS)
export type TokenizationRequestKind = z.infer<typeof TokenizationRequestKindSchema>

export const QuotaHistoryEntrySchema = z.object({
  requestId: z.string(),
  kind: TokenizationRequestKindSchema,
  quantity: z.number().int().min(1),
  resultingQuota: z.number().int().min(1),
  approvedAt: IsoDateTimeSchema,
  approvedBy: z.string(),
})
export type QuotaHistoryEntry = z.infer<typeof QuotaHistoryEntrySchema>

export const CollectionStatusHistoryEntrySchema = z.object({
  status: CollectionStatusSchema,
  at: IsoDateTimeSchema,
  by: z.string(),
  reason: z.string().nullable(),
})
export type CollectionStatusHistoryEntry = z.infer<typeof CollectionStatusHistoryEntrySchema>

export const LOT_CLOSURE_STATUSES = ['NO_SHORTFALL', 'SHORTFALL_OPEN', 'DECIDED', 'RESOLVED'] as const
export const LotClosureStatusSchema = z.enum(LOT_CLOSURE_STATUSES)
export type LotClosureStatus = z.infer<typeof LotClosureStatusSchema>

/** Qué hacer con los no vendidos que sí tienen botella */
export const UNSOLD_POLICIES = ['KEEP_ON_SALE', 'BURN'] as const
export const UnsoldPolicySchema = z.enum(UNSOLD_POLICIES)
export type UnsoldPolicy = z.infer<typeof UnsoldPolicySchema>

export const LotClosureDecisionSchema = z.object({
  by: UserRefSchema,
  at: IsoDateTimeSchema,
  reason: z.string(),
})
export type LotClosureDecision = z.infer<typeof LotClosureDecisionSchema>

export const TOKEN_STATUSES = ['MINTED', 'RESERVED', 'SOLD', 'REDEEMABLE', 'PASS_ACTIVE', 'REDEEMED', 'BURNED', 'EXPIRED'] as const
export const TokenStatusSchema = z.enum(TOKEN_STATUSES)
export type TokenStatus = z.infer<typeof TokenStatusSchema>

export const LotClosureItemSchema = z.object({
  tokenId: z.number().int().min(0),
  bottleNumber: z.number().int().min(1),
  status: TokenStatusSchema,
  outcome: ClosureItemOutcomeSchema,
  burnTx: ChainTxRefSchema.nullable(),
  resolvedAt: IsoDateTimeSchema.nullable(),
  /** Ola 4 */
  orderId: z.string().nullable(),
  /** Ola 4 */
  paidAt: IsoDateTimeSchema.nullable(),
  note: z.string().nullable(),
})
export type LotClosureItem = z.infer<typeof LotClosureItemSchema>

export const LotClosureSchema = z.object({
  id: z.string(),
  lotId: z.string(),
  collectionId: z.string(),
  status: LotClosureStatusSchema,
  computedAt: IsoDateTimeSchema,
  /** Códigos `ACTIVE` (0 si el lote se descartó) */
  bottles: z.number().int().min(0),
  minted: z.number().int().min(0),
  sold: z.number().int().min(0),
  reserved: z.number().int().min(0),
  /** `MINTED` no reservados */
  unsold: z.number().int().min(0),
  /** max(0, emitidos − quemados − botellas) */
  shortfall: z.number().int().min(0),
  /** min(faltante, no vendidos) */
  unsoldToBurn: z.number().int().min(0),
  soldWithoutBottle: z.number().int().min(0),
  /** Qué hacer con los no vendidos que sí tienen botella */
  unsoldPolicy: UnsoldPolicySchema.nullable(),
  decision: LotClosureDecisionSchema.nullable(),
  /** Solo los NFT afectados */
  items: z.array(LotClosureItemSchema),
})
export type LotClosure = z.infer<typeof LotClosureSchema>

export const CollectionMintMetricSchema = z.object({
  sequence: z.number().int().min(1),
  quantity: z.number().int().min(1),
  confirmedAt: IsoDateTimeSchema.nullable(),
})
export type CollectionMintMetric = z.infer<typeof CollectionMintMetricSchema>

export const CollectionMetricsSchema = z.object({
  counts: TokenCountsSchema,
  quota: z.number().int().min(1),
  /** Cuota sobre la estimación del lote, en % */
  authorizedVsEstimatePercent: z.number().nullable(),
  firstMintedAt: IsoDateTimeSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  /** Ola 4 */
  firstSaleAt: IsoDateTimeSchema.nullable(),
  chainCosts: CollectionChainCostsSchema,
  byMint: z.array(CollectionMintMetricSchema),
})
export type CollectionMetrics = z.infer<typeof CollectionMetricsSchema>

export const CollectionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  wineryId: z.string(),
  winery: WineryRefSchema,
  lotId: z.string(),
  lot: CollectionLotRefSchema,
  status: CollectionStatusSchema,
  /** De la última emisión */
  mintStatus: MintStatusSchema,
  /** Derivado; `null` si no está `PUBLISHED`. `PRESALE` hasta el anclaje; `ON_SALE` después */
  saleState: SaleStateSchema.nullable(),
  quota: z.number().int().min(1),
  /** De una ampliación aprobada con la emisión en curso */
  pendingMintQuantity: z.number().int().min(0),
  counts: TokenCountsSchema,
  price: CollectionPriceSchema.nullable(),
  name: z.string(),
  /** Portada: `GET /v1/public/collections/images/{id}` de esta API si está publicada */
  coverImageUrl: z.string().nullable(),
  estimatedRedeemDate: z.iso.date().nullable(),
  contract: CollectionContractRefSchema,
  /** Desde el anclaje del expediente (§7.2) */
  redeemable: z.boolean(),
  redeemableSince: IsoDateTimeSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  commercial: CollectionCommercialSchema,
  /** Copia de `precio.politica` al aprobar */
  pricePolicySnapshot: z.json(),
  priceHistory: z.array(CollectionPriceSchema),
  mints: z.array(MintSchema),
  quotaHistory: z.array(QuotaHistoryEntrySchema),
  statusHistory: z.array(CollectionStatusHistoryEntrySchema),
  anchor: DossierAnchorSchema.nullable(),
  closure: LotClosureSchema.nullable(),
  metrics: CollectionMetricsSchema,
})
export type Collection = z.infer<typeof CollectionSchema>

export const CollectionOptionalReasonSchema = z.object({
  /** Motivo (obligatorio si actúa el back office sobre un tercero) */
  reason: z.string().min(3).max(500).nullable().optional(),
})
export type CollectionOptionalReason = z.infer<typeof CollectionOptionalReasonSchema>

export const CollectionReasonSchema = z.object({
  /** Motivo (queda en la bitácora) */
  reason: z.string().min(3).max(500),
})
export type CollectionReason = z.infer<typeof CollectionReasonSchema>

export const CollectionSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  wineryId: z.string(),
  winery: WineryRefSchema,
  lotId: z.string(),
  lot: CollectionLotRefSchema,
  status: CollectionStatusSchema,
  /** De la última emisión */
  mintStatus: MintStatusSchema,
  /** Derivado; `null` si no está `PUBLISHED`. `PRESALE` hasta el anclaje; `ON_SALE` después */
  saleState: SaleStateSchema.nullable(),
  quota: z.number().int().min(1),
  /** De una ampliación aprobada con la emisión en curso */
  pendingMintQuantity: z.number().int().min(0),
  counts: TokenCountsSchema,
  price: CollectionPriceSchema.nullable(),
  name: z.string(),
  /** Portada: `GET /v1/public/collections/images/{id}` de esta API si está publicada */
  coverImageUrl: z.string().nullable(),
  estimatedRedeemDate: z.iso.date().nullable(),
  contract: CollectionContractRefSchema,
  /** Desde el anclaje del expediente (§7.2) */
  redeemable: z.boolean(),
  redeemableSince: IsoDateTimeSchema.nullable(),
  publishedAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type CollectionSummary = z.infer<typeof CollectionSummarySchema>

export const CreateTokenizationRequestSchema = z.object({
  /** Botellas a autorizar (la cuota si no hay colección; las adicionales si la hay) */
  quantity: z.number().int().min(1),
  commercial: CollectionCommercialInputSchema.optional(),
  notes: z.string().max(2000).optional(),
  /** Confirmación explícita: se emitirán NFT a nombre de la bodega cuando se apruebe */
  confirm: z.literal(true),
})
export type CreateTokenizationRequest = z.infer<typeof CreateTokenizationRequestSchema>

export const DashboardTokenizationSchema = z.object({
  /** Solicitudes enviadas, sin tomar */
  submitted: z.number().int().min(0),
  /** Solicitudes en revisión */
  inReview: z.number().int().min(0),
  /** Solicitudes que esperan cambios de la bodega */
  changesRequested: z.number().int().min(0),
  /** Horas que lleva abierta la solicitud abierta más antigua (0 si no hay) */
  oldestOpenHours: z.number().int().min(0),
  /** Colecciones con la emisión inicial sin confirmar */
  collectionsMinting: z.number().int().min(0),
  /** Colecciones con la última emisión fallida */
  mintFailures: z.number().int().min(0),
  collectionsPublished: z.number().int().min(0),
  /** Cierres de lote con faltante sin decidir */
  shortfallsOpen: z.number().int().min(0),
})
export type DashboardTokenization = z.infer<typeof DashboardTokenizationSchema>

export const DecideLotClosureSchema = z.object({
  /** `BURN` (y todo cierre con faltante): solo `ADMIN`. `KEEP_ON_SALE` sin faltante: también `OPERATIONS` */
  unsoldPolicy: UnsoldPolicySchema,
  /** Motivo (queda en la bitácora) */
  reason: z.string().min(3).max(500),
})
export type DecideLotClosure = z.infer<typeof DecideLotClosureSchema>

export const LotChainIdentityStatusSchema = z.object({
  status: ChainIdentityStatusSchema,
})
export type LotChainIdentityStatus = z.infer<typeof LotChainIdentityStatusSchema>

export const LotClosureSummarySchema = z.object({
  id: z.string(),
  lotId: z.string(),
  collectionId: z.string(),
  status: LotClosureStatusSchema,
  computedAt: IsoDateTimeSchema,
  /** Códigos `ACTIVE` (0 si el lote se descartó) */
  bottles: z.number().int().min(0),
  minted: z.number().int().min(0),
  sold: z.number().int().min(0),
  reserved: z.number().int().min(0),
  /** `MINTED` no reservados */
  unsold: z.number().int().min(0),
  /** max(0, emitidos − quemados − botellas) */
  shortfall: z.number().int().min(0),
  /** min(faltante, no vendidos) */
  unsoldToBurn: z.number().int().min(0),
  soldWithoutBottle: z.number().int().min(0),
  /** Qué hacer con los no vendidos que sí tienen botella */
  unsoldPolicy: UnsoldPolicySchema.nullable(),
  decision: LotClosureDecisionSchema.nullable(),
})
export type LotClosureSummary = z.infer<typeof LotClosureSummarySchema>

/** `BOTTLES` desde el embotellado (R6) */
export const TOKENIZATION_LIMIT_BASISES = ['ESTIMATE', 'BOTTLES'] as const
export const TokenizationLimitBasisSchema = z.enum(TOKENIZATION_LIMIT_BASISES)
export type TokenizationLimitBasis = z.infer<typeof TokenizationLimitBasisSchema>

export const TokenizationLimitsSchema = z.object({
  /** `BOTTLES` desde el embotellado (R6) */
  basis: TokenizationLimitBasisSchema,
  estimatedBottles: z.number().int().nullable(),
  /** Códigos de botella `ACTIVE` */
  bottles: z.number().int().nullable(),
  /** Cuota aprobada vigente (0 sin colección) */
  authorizedQuota: z.number().int().min(0),
  /** Pedida en una solicitud abierta */
  pendingQuantity: z.number().int().min(0),
  /** Lo que aún se puede pedir = límite − autorizada − pendiente */
  maxQuantity: z.number().int().min(0),
})
export type TokenizationLimits = z.infer<typeof TokenizationLimitsSchema>

export const TokenizationRequestLotSchema = z.object({
  reference: z.string(),
  lotCode: z.string().nullable(),
  name: z.string(),
  productType: LotProductTypeSchema.nullable(),
  stage: LotStageCodeSchema,
  harvestYear: z.number().int(),
  estimatedBottles: z.number().int().nullable(),
  bottles: z.number().int().nullable(),
})
export type TokenizationRequestLot = z.infer<typeof TokenizationRequestLotSchema>

export const TOKENIZATION_REQUEST_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const
export const TokenizationRequestStatusSchema = z.enum(TOKENIZATION_REQUEST_STATUSES)
export type TokenizationRequestStatus = z.infer<typeof TokenizationRequestStatusSchema>

export const TokenizationRequestSummarySchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  winery: WineryRefSchema,
  lotId: z.string(),
  lot: TokenizationRequestLotSchema,
  /** Lo deduce el servidor: sin colección, `INITIAL`; con colección, `QUOTA_INCREASE` */
  kind: TokenizationRequestKindSchema,
  status: TokenizationRequestStatusSchema,
  /** `INITIAL`: cuota; `QUOTA_INCREASE`: botellas adicionales */
  quantity: z.number().int().min(1),
  /** Cuota total si se aprueba */
  resultingQuota: z.number().int().min(1),
  /** Valor de `tokenizacion.requiereAprobacion` al enviar (§5.6) */
  requiresApproval: z.boolean(),
  assignee: UserRefSchema.nullable(),
  submittedAt: IsoDateTimeSchema,
  submittedBy: TraceActorSchema,
  updatedAt: IsoDateTimeSchema,
  collectionId: z.string().nullable(),
})
export type TokenizationRequestSummary = z.infer<typeof TokenizationRequestSummarySchema>

export const LotTokenizationStatusSchema = z.object({
  lotId: z.string(),
  /** Puede enviar una solicitud ahora */
  tokenizable: z.boolean(),
  /** Con `code` `TOK_…` y `message` listo para mostrar */
  blockers: z.array(ErrorDetailSchema),
  limits: TokenizationLimitsSchema,
  /** Valor efectivo actual de `tokenizacion.requiereAprobacion` */
  approvalRequired: z.boolean(),
  chainIdentity: LotChainIdentityStatusSchema,
  openRequest: TokenizationRequestSummarySchema.nullable(),
  collection: CollectionSummarySchema.nullable(),
  /** Historial del lote */
  requests: z.array(TokenizationRequestSummarySchema),
})
export type LotTokenizationStatus = z.infer<typeof LotTokenizationStatusSchema>

export const TokenizationChangeRequestSchema = z.object({
  id: z.string(),
  at: IsoDateTimeSchema,
  by: UserRefSchema,
  message: z.string(),
  /** Campos a revisar */
  fields: z.array(z.string()),
  resolvedAt: IsoDateTimeSchema.nullable(),
})
export type TokenizationChangeRequest = z.infer<typeof TokenizationChangeRequestSchema>

export const TokenizationDecisionBySchema = z.object({
  userId: z.string().nullable(),
  fullName: z.string().nullable(),
  /** `true` si se autoaprobó (`requiresApproval = false`, S-11) */
  system: z.boolean(),
})
export type TokenizationDecisionBy = z.infer<typeof TokenizationDecisionBySchema>

export const TokenizationDecisionSchema = z.object({
  outcome: z.enum(['APPROVED', 'REJECTED']),
  at: IsoDateTimeSchema,
  reason: z.string().nullable(),
  by: TokenizationDecisionBySchema,
})
export type TokenizationDecision = z.infer<typeof TokenizationDecisionSchema>

export const TokenizationWithdrawnSchema = z.object({
  at: IsoDateTimeSchema,
  by: TraceActorSchema,
  reason: z.string(),
})
export type TokenizationWithdrawn = z.infer<typeof TokenizationWithdrawnSchema>

export const TokenizationHistoryEntrySchema = z.object({
  status: TokenizationRequestStatusSchema,
  at: IsoDateTimeSchema,
  by: z.string(),
  note: z.string().nullable(),
})
export type TokenizationHistoryEntry = z.infer<typeof TokenizationHistoryEntrySchema>

export const TokenizationInternalNoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  by: z.string(),
  at: IsoDateTimeSchema,
})
export type TokenizationInternalNote = z.infer<typeof TokenizationInternalNoteSchema>

export const PriceSuggestionUnavailableSchema = z.object({
  available: z.literal(false),
  reason: z.literal('POLICY_UNDEFINED'),
})
export type PriceSuggestionUnavailable = z.infer<typeof PriceSuggestionUnavailableSchema>

export const PriceSuggestionAvailableSchema = z.object({
  available: z.literal(true),
  amountMinor: z.number().int().min(1),
  currency: PriceCurrencySchema,
  source: z.enum(['GLOBAL', 'WINERY']),
  policyVersion: z.string(),
})
export type PriceSuggestionAvailable = z.infer<typeof PriceSuggestionAvailableSchema>

export const TokenizationReviewTraceabilitySchema = z.object({
  publicEventsCount: z.number().int().min(0),
  lastEvent: LotEventSchema.nullable(),
  locks: z.array(LotLockInfoSchema),
  estimatedReadyDate: z.iso.date().nullable(),
  complianceIssuesOpen: z.number().int().min(0),
  denomination: DoEvaluationSchema,
  dossierStatus: z.enum(['OPEN', 'CLOSED']),
})
export type TokenizationReviewTraceability = z.infer<typeof TokenizationReviewTraceabilitySchema>

export const TokenizationReviewSchema = z.object({
  /** Lectura de plataforma */
  lot: LotSchema,
  traceability: TokenizationReviewTraceabilitySchema,
  /** Recalculados ahora */
  limits: TokenizationLimitsSchema,
  chainIdentity: WineryChainIdentitySchema,
  priceSuggestion: z.union([PriceSuggestionUnavailableSchema, PriceSuggestionAvailableSchema]),
  otherCollectionsOfWinery: z.array(CollectionSummarySchema),
})
export type TokenizationReview = z.infer<typeof TokenizationReviewSchema>

export const PlatformTokenizationRequestSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  winery: WineryRefSchema,
  lotId: z.string(),
  lot: TokenizationRequestLotSchema,
  /** Lo deduce el servidor: sin colección, `INITIAL`; con colección, `QUOTA_INCREASE` */
  kind: TokenizationRequestKindSchema,
  status: TokenizationRequestStatusSchema,
  /** `INITIAL`: cuota; `QUOTA_INCREASE`: botellas adicionales */
  quantity: z.number().int().min(1),
  /** Cuota total si se aprueba */
  resultingQuota: z.number().int().min(1),
  /** Valor de `tokenizacion.requiereAprobacion` al enviar (§5.6) */
  requiresApproval: z.boolean(),
  assignee: UserRefSchema.nullable(),
  submittedAt: IsoDateTimeSchema,
  submittedBy: TraceActorSchema,
  updatedAt: IsoDateTimeSchema,
  collectionId: z.string().nullable(),
  /** Lo que envía la bodega y completa operaciones (§5.5) */
  commercialDraft: CollectionCommercialDraftSchema,
  /** La bodega lo ve en solo lectura tras aprobarse */
  price: CollectionPriceSchema.nullable(),
  wineryNotes: z.string().nullable(),
  changeRequests: z.array(TokenizationChangeRequestSchema),
  decision: TokenizationDecisionSchema.nullable(),
  withdrawn: TokenizationWithdrawnSchema.nullable(),
  limitsAtSubmission: TokenizationLimitsSchema,
  history: z.array(TokenizationHistoryEntrySchema),
  internalNotes: z.array(TokenizationInternalNoteSchema),
  priceSuggestion: z.union([PriceSuggestionUnavailableSchema, PriceSuggestionAvailableSchema]),
  review: TokenizationReviewSchema,
})
export type PlatformTokenizationRequest = z.infer<typeof PlatformTokenizationRequestSchema>

export const PublicNftAttributeSchema = z.object({
  /** Bodega, Lote (referencia), Bebida, Añada, Botella n.º, Colección, Estado */
  trait_type: z.string(),
  value: z.union([z.string(), z.number()]),
})
export type PublicNftAttribute = z.infer<typeof PublicNftAttributeSchema>

export const PublicNftPropertiesSchema = z.object({
  winery: WineryRefSchema,
  lotReference: z.string(),
  lotCode: z.string().nullable(),
  bottleNumber: z.number().int().min(1),
  /** La cuota vigente (cambia con las ampliaciones) */
  collectionSize: z.number().int().min(1),
  tokenId: z.number().int().min(0),
  contract: z.string(),
  /** Un token quemado sigue respondiendo con `BURNED` (veracidad) */
  status: TokenStatusSchema,
  /** `{PASSPORT_BASE_URL}/b/{lotCode}` si el lote ya tiene código */
  passportUrl: z.string().nullable(),
})
export type PublicNftProperties = z.infer<typeof PublicNftPropertiesSchema>

export const PublicNftMetadataSchema = z.object({
  name: z.string(),
  /** Descripción comercial o, sin colección publicada, un texto neutro con la bodega y el lote */
  description: z.string(),
  /** Portada de la colección (`GET /v1/public/collections/images/{id}`) */
  image: z.string().nullable(),
  /** El pasaporte del lote si existe; si no, la ficha de la colección en el Marketplace */
  external_url: z.string(),
  attributes: z.array(PublicNftAttributeSchema),
  properties: PublicNftPropertiesSchema,
})
export type PublicNftMetadata = z.infer<typeof PublicNftMetadataSchema>

export const RequestTokenizationChangesSchema = z.object({
  /** Llega por correo al dueño */
  message: z.string().min(3).max(2000),
  fields: z.array(z.string()).max(20).optional(),
})
export type RequestTokenizationChanges = z.infer<typeof RequestTokenizationChangesSchema>

export const ResolveLotClosureItemSchema = z.object({
  outcome: z.enum(['MANUAL_REFUND', 'MANUAL_SUBSTITUTE']),
  note: z.string().min(3).max(1000),
})
export type ResolveLotClosureItem = z.infer<typeof ResolveLotClosureItemSchema>

export const ResubmitTokenizationRequestSchema = z.object({
  message: z.string().max(2000).optional(),
})
export type ResubmitTokenizationRequest = z.infer<typeof ResubmitTokenizationRequestSchema>

export const ReviewTokenizationRequestSchema = z.object({
  commercial: CollectionCommercialInputSchema.optional(),
  price: CollectionPriceInputSchema.nullable().optional(),
  /** Motivo (obligatorio si actúa el back office sobre un tercero) */
  reason: z.string().min(3).max(500).nullable().optional(),
})
export type ReviewTokenizationRequest = z.infer<typeof ReviewTokenizationRequestSchema>

export const TOKEN_BURN_REASONS = ['REDEMPTION', 'SHORTFALL', 'WINDOW_EXPIRED'] as const
export const TokenBurnReasonSchema = z.enum(TOKEN_BURN_REASONS)
export type TokenBurnReason = z.infer<typeof TokenBurnReasonSchema>

export const TOKEN_OWNER_KINDS = ['WINERY', 'CONSUMER'] as const
export const TokenOwnerKindSchema = z.enum(TOKEN_OWNER_KINDS)
export type TokenOwnerKind = z.infer<typeof TokenOwnerKindSchema>

export const TokenOwnerSchema = z.object({
  kind: TokenOwnerKindSchema,
  address: z.string(),
})
export type TokenOwner = z.infer<typeof TokenOwnerSchema>

export const TokenOnchainSchema = z.object({
  owner: z.string().nullable(),
  burned: z.boolean(),
  checkedAt: IsoDateTimeSchema.nullable(),
})
export type TokenOnchain = z.infer<typeof TokenOnchainSchema>

export const TokenSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  wineryId: z.string(),
  lotId: z.string(),
  contractAddress: z.string(),
  /** Id en la red (u32) */
  tokenId: z.number().int().min(0),
  /** 1…cuota dentro de la colección (no es el serial físico) */
  bottleNumber: z.number().int().min(1),
  status: TokenStatusSchema,
  /** Proyección de la base; sin datos del consumidor */
  owner: TokenOwnerSchema,
  mintId: z.string(),
  mintTx: ChainTxRefSchema,
  soldAt: IsoDateTimeSchema.nullable(),
  redeemableAt: IsoDateTimeSchema.nullable(),
  redeemWindowEndsAt: IsoDateTimeSchema.nullable(),
  burnedAt: IsoDateTimeSchema.nullable(),
  burnTx: ChainTxRefSchema.nullable(),
  burnReason: TokenBurnReasonSchema.nullable(),
  /** Última lectura del indexador o de la conciliación */
  onchain: TokenOnchainSchema,
  /** `token_uri` */
  metadataUrl: z.string(),
})
export type Token = z.infer<typeof TokenSchema>

export const TokenizationApprovalSchema = z.object({
  request: PlatformTokenizationRequestSchema,
  collection: CollectionSchema,
  mint: MintSchema,
})
export type TokenizationApproval = z.infer<typeof TokenizationApprovalSchema>

export const TokenizationReasonSchema = z.object({
  /** Motivo (queda en la bitácora) */
  reason: z.string().min(3).max(500),
})
export type TokenizationReason = z.infer<typeof TokenizationReasonSchema>

export const TokenizationRequestSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  winery: WineryRefSchema,
  lotId: z.string(),
  lot: TokenizationRequestLotSchema,
  /** Lo deduce el servidor: sin colección, `INITIAL`; con colección, `QUOTA_INCREASE` */
  kind: TokenizationRequestKindSchema,
  status: TokenizationRequestStatusSchema,
  /** `INITIAL`: cuota; `QUOTA_INCREASE`: botellas adicionales */
  quantity: z.number().int().min(1),
  /** Cuota total si se aprueba */
  resultingQuota: z.number().int().min(1),
  /** Valor de `tokenizacion.requiereAprobacion` al enviar (§5.6) */
  requiresApproval: z.boolean(),
  assignee: UserRefSchema.nullable(),
  submittedAt: IsoDateTimeSchema,
  submittedBy: TraceActorSchema,
  updatedAt: IsoDateTimeSchema,
  collectionId: z.string().nullable(),
  /** Lo que envía la bodega y completa operaciones (§5.5) */
  commercialDraft: CollectionCommercialDraftSchema,
  /** La bodega lo ve en solo lectura tras aprobarse */
  price: CollectionPriceSchema.nullable(),
  wineryNotes: z.string().nullable(),
  changeRequests: z.array(TokenizationChangeRequestSchema),
  decision: TokenizationDecisionSchema.nullable(),
  withdrawn: TokenizationWithdrawnSchema.nullable(),
  limitsAtSubmission: TokenizationLimitsSchema,
  history: z.array(TokenizationHistoryEntrySchema),
})
export type TokenizationRequest = z.infer<typeof TokenizationRequestSchema>

export const UpdateCollectionSchema = z.object({
  commercial: CollectionCommercialInputSchema.optional(),
  price: CollectionPriceInputSchema.nullable().optional(),
  estimatedRedeemDate: z.iso.date().nullable().optional(),
  /** Motivo (queda en la bitácora) */
  reason: z.string().min(3).max(500),
})
export type UpdateCollection = z.infer<typeof UpdateCollectionSchema>

export const UpdateTokenizationRequestSchema = z.object({
  quantity: z.number().int().min(1).optional(),
  commercial: CollectionCommercialInputSchema.optional(),
  notes: z.string().max(2000).optional(),
})
export type UpdateTokenizationRequest = z.infer<typeof UpdateTokenizationRequestSchema>

export const WineryChainCostsSchema = z.object({
  /** XLM pagados por la plataforma por esta bodega (informativo) */
  feesChargedXlm: z.string(),
  /** Desde cuándo se suma (`null` sin transacciones) */
  since: IsoDateTimeSchema.nullable(),
})
export type WineryChainCosts = z.infer<typeof WineryChainCostsSchema>

export const WineryChainAccountViewSchema = z.object({
  identity: WineryChainIdentitySchema,
  /** Suma de sus colecciones */
  totals: TokenCountsSchema,
  byLot: z.array(ChainAccountLotSchema),
  /** Las 10 últimas de la bodega (emisiones, anclajes, pausas) */
  recentTransactions: z.array(ChainTxRefSchema).max(10),
  chainCosts: WineryChainCostsSchema,
})
export type WineryChainAccountView = z.infer<typeof WineryChainAccountViewSchema>

export const WineryLotClosureItemSchema = z.object({
  tokenId: z.number().int().min(0),
  bottleNumber: z.number().int().min(1),
  status: TokenStatusSchema,
  outcome: ClosureItemOutcomeSchema,
  burnTx: ChainTxRefSchema.nullable(),
  resolvedAt: IsoDateTimeSchema.nullable(),
})
export type WineryLotClosureItem = z.infer<typeof WineryLotClosureItemSchema>

export const WineryLotClosureSchema = z.object({
  id: z.string(),
  lotId: z.string(),
  collectionId: z.string(),
  status: LotClosureStatusSchema,
  computedAt: IsoDateTimeSchema,
  /** Códigos `ACTIVE` (0 si el lote se descartó) */
  bottles: z.number().int().min(0),
  minted: z.number().int().min(0),
  sold: z.number().int().min(0),
  reserved: z.number().int().min(0),
  /** `MINTED` no reservados */
  unsold: z.number().int().min(0),
  /** max(0, emitidos − quemados − botellas) */
  shortfall: z.number().int().min(0),
  /** min(faltante, no vendidos) */
  unsoldToBurn: z.number().int().min(0),
  soldWithoutBottle: z.number().int().min(0),
  /** Qué hacer con los no vendidos que sí tienen botella */
  unsoldPolicy: UnsoldPolicySchema.nullable(),
  decision: LotClosureDecisionSchema.nullable(),
  items: z.array(WineryLotClosureItemSchema),
})
export type WineryLotClosure = z.infer<typeof WineryLotClosureSchema>
