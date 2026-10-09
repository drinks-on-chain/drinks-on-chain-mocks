import { z } from 'zod'
import { IsoDateTimeSchema } from '../erp/schemas/common'

// Dominio `chain` (contrato de la Ola 3, `plan/contratos/o3-tokenizacion.md` §2, §3, §7 y §8): red,
// transacciones, identidad de la bodega, anclaje del expediente, cuentas de la plataforma, eventos
// del indexador, conciliaciones y alertas, registro público y verificación. Generado a partir de los
// DTO del OpenAPI del backend (rama de la apertura de la Ola 3): mismos nombres de campo, mismos
// anulables. `XxxDto` del OpenAPI = `XxxSchema` / tipo `Xxx`.

export const ChainActionSchema = z.object({
  /** Motivo (queda en la bitácora) */
  reason: z.string().min(3).max(500),
})
export type ChainAction = z.infer<typeof ChainActionSchema>

export const CHAIN_ALERT_LEVELS = ['INFO', 'WARNING', 'CRITICAL'] as const
export const ChainAlertLevelSchema = z.enum(CHAIN_ALERT_LEVELS)
export type ChainAlertLevel = z.infer<typeof ChainAlertLevelSchema>

/**
 * Códigos de alerta conocidos (`ChainAlert.code` es texto: el backend puede añadir más). Los del
 * OpenAPI más `MINT_RANGE_MISMATCH` (una emisión confirmada cuyo rango no cuadra con lo pedido).
 */
export const CHAIN_ALERT_CODES = [
  'TOTAL_MINTED_MISMATCH',
  'BALANCE_MISMATCH',
  'OWNER_MISMATCH',
  'BURN_MISMATCH',
  'PAUSE_MISMATCH',
  'ROLE_MISMATCH',
  'QUOTA_EXCEEDED',
  'BOTTLES_SHORTFALL',
  'ANCHOR_MISMATCH',
  'MINT_RANGE_MISMATCH',
  'TX_STUCK',
  'LOW_BALANCE',
  'TTL_EXPIRING',
  'UNEXPECTED_EVENT',
  'INDEXER_GAP',
  'NETWORK_RESET',
  'CHN_INTENT_REJECTED',
  'TX_FAILED',
] as const
export type ChainAlertCode = (typeof CHAIN_ALERT_CODES)[number]

/**
 * Tipos de sujeto que llevan hoy las alertas. El OpenAPI declara `ChainAlertSubjectDto.type` como
 * **texto libre** (ejemplo `COLLECTION`), no como `ChainSubjectType`: esta lista es orientativa
 * (para etiquetas y enlaces) y el esquema acepta cualquier texto. `id` es el id del recurso salvo
 * en `PLATFORM_ACCOUNT` (`OPERATIONS` | `ANCHOR`), `PLATFORM` (`WASM`, `INDEXER`) y `CONTRACT` (su dirección `C…`).
 */
export const CHAIN_ALERT_SUBJECT_TYPES = ['TRANSACTION', 'COLLECTION', 'MINT', 'LOT', 'CONTRACT', 'PLATFORM_ACCOUNT', 'PLATFORM', 'CHAIN_EVENT'] as const
export type ChainAlertSubjectType = (typeof CHAIN_ALERT_SUBJECT_TYPES)[number]

export const ChainAlertSubjectSchema = z.object({
  /** Texto libre en el OpenAPI; valores conocidos en `CHAIN_ALERT_SUBJECT_TYPES`. */
  type: z.string(),
  id: z.string(),
})
export type ChainAlertSubject = z.infer<typeof ChainAlertSubjectSchema>

export const ChainAlertResolutionSchema = z.object({
  by: z.string(),
  note: z.string(),
  /** Cerrada sola al desaparecer su condición (p. ej. `TX_STUCK`) */
  auto: z.boolean(),
})
export type ChainAlertResolution = z.infer<typeof ChainAlertResolutionSchema>

export const ChainAlertSchema = z.object({
  id: z.string(),
  /** `TOTAL_MINTED_MISMATCH`, `BALANCE_MISMATCH`, `OWNER_MISMATCH`, `BURN_MISMATCH`, `PAUSE_MISMATCH`, `ROLE_MISMATCH`, `QUOTA_EXCEEDED`, `BOTTLES_SHORTFALL`, `ANCHOR_MISMATCH`, `TX_STUCK`, `LOW_BALANCE`, `TTL_EXPIRING`, `UNEXPECTED_EVENT`, `INDEXER_GAP`, `NETWORK_RESET`, `CHN_INTENT_REJECTED`, `TX_FAILED` */
  code: z.string(),
  level: ChainAlertLevelSchema,
  subject: ChainAlertSubjectSchema,
  wineryId: z.string().nullable(),
  /** Lo que dice la base */
  expected: z.json(),
  /** Lo que dice la red */
  actual: z.json(),
  message: z.string(),
  runId: z.string().nullable(),
  detectedAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  resolution: ChainAlertResolutionSchema.nullable(),
})
export type ChainAlert = z.infer<typeof ChainAlertSchema>

export const CHAIN_NETWORKS = ['TESTNET', 'PUBLIC', 'LOCAL'] as const
export const ChainNetworkSchema = z.enum(CHAIN_NETWORKS)
export type ChainNetwork = z.infer<typeof ChainNetworkSchema>

export const ChainEventSchema = z.object({
  id: z.string(),
  rpcEventId: z.string(),
  network: ChainNetworkSchema,
  contractAddress: z.string(),
  wineryId: z.string().nullable(),
  ledger: z.number().int(),
  ledgerClosedAt: IsoDateTimeSchema,
  txHash: z.string(),
  /** Primer topic: `consecutive_mint`, `lot_minted`, `transfer`, `burn`, `paused`, `unpaused`, `role_granted`… */
  type: z.string(),
  /** Topics decodificados */
  topics: z.array(z.unknown()),
  data: z.record(z.string(), z.unknown()),
  /** Transacción propia que lo originó */
  matchedTransactionId: z.string().nullable(),
  /** `false` → alerta `CRITICAL` `UNEXPECTED_EVENT` */
  originatedBySystem: z.boolean(),
  processedAt: IsoDateTimeSchema,
})
export type ChainEvent = z.infer<typeof ChainEventSchema>

export const CHAIN_TX_KINDS = ['CREATE_WINERY_ACCOUNT', 'DEPLOY_WINERY_CONTRACT', 'SET_TOKEN_URI_BASE', 'MINT_BATCH', 'ANCHOR_DOSSIER', 'PAUSE_CONTRACT', 'UNPAUSE_CONTRACT', 'BURN_UNSOLD', 'EXTEND_TTL', 'RESTORE_ENTRIES', 'FUND_ACCOUNT', 'OPERATOR_TRANSFER', 'REDEEM_BURN'] as const
export const ChainTxKindSchema = z.enum(CHAIN_TX_KINDS)
export type ChainTxKind = z.infer<typeof ChainTxKindSchema>

export const CHAIN_TX_STATUSES = ['PENDING', 'BUILDING', 'SUBMITTED', 'CONFIRMED', 'RETRYING', 'FAILED'] as const
export const ChainTxStatusSchema = z.enum(CHAIN_TX_STATUSES)
export type ChainTxStatus = z.infer<typeof ChainTxStatusSchema>

export const ChainTxErrorSchema = z.object({
  /** Código interno (§2.3; desde 0.6.0-rc.2 también `CHN_WINERY_NOT_ACTIVE`: la emisión espera en `PENDING`, como con `CHN_MINT_DISABLED`, mientras la bodega no esté activa): `CHN_RPC_UNAVAILABLE`, `CHN_TX_TIMEOUT`, `CHN_BAD_SEQUENCE`, `CHN_INSUFFICIENT_FEE`, `CHN_TRY_AGAIN_LATER`, `CHN_ARCHIVED_ENTRY`, `CHN_CONTRACT_ERROR`, `CHN_AUTH_FAILED`, `CHN_INSUFFICIENT_BALANCE`, `CHN_INTENT_REJECTED`, `CHN_MINT_DISABLED`, `CHN_NETWORK_RESET` */
  code: z.string(),
  message: z.string(),
  /** El worker la reintenta solo */
  retryable: z.boolean(),
})
export type ChainTxError = z.infer<typeof ChainTxErrorSchema>

export const ChainTxRefSchema = z.object({
  id: z.string(),
  kind: ChainTxKindSchema,
  status: ChainTxStatusSchema,
  network: ChainNetworkSchema,
  /** Hex de 64; se conoce al firmar */
  txHash: z.string().nullable(),
  /** Lo construye el backend (`STELLAR_EXPLORER_BASE_URL`) */
  explorerUrl: z.string().nullable(),
  ledger: z.number().int().nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
  attempts: z.number().int().min(0),
  lastError: ChainTxErrorSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type ChainTxRef = z.infer<typeof ChainTxRefSchema>

export const ChainIdentityAccountSchema = z.object({
  address: z.string(),
  explorerUrl: z.string().nullable(),
  homeDomain: z.string().nullable(),
  createdTx: ChainTxRefSchema,
})
export type ChainIdentityAccount = z.infer<typeof ChainIdentityAccountSchema>

export const ChainIdentityContractSchema = z.object({
  address: z.string(),
  explorerUrl: z.string().nullable(),
  wasmHash: z.string(),
  name: z.string().max(40),
  /** El `lotPrefix` de la bodega */
  symbol: z.string(),
  /** `token_uri(id)` = `baseUri` + id */
  baseUri: z.string(),
  operatorAddress: z.string(),
  /** Pausado en la red (§3.5) */
  paused: z.boolean(),
  deployedTx: ChainTxRefSchema,
  deployedAt: IsoDateTimeSchema.nullable(),
})
export type ChainIdentityContract = z.infer<typeof ChainIdentityContractSchema>

export const ChainIdentityErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
})
export type ChainIdentityError = z.infer<typeof ChainIdentityErrorSchema>

/** `ACTIVE` exige cuenta y contrato confirmados y leídos de vuelta */
export const CHAIN_IDENTITY_STATUSES = ['NOT_PROVISIONED', 'PROVISIONING', 'ACTIVE', 'FAILED', 'PAUSED'] as const
export const ChainIdentityStatusSchema = z.enum(CHAIN_IDENTITY_STATUSES)
export type ChainIdentityStatus = z.infer<typeof ChainIdentityStatusSchema>

export const CHAIN_SIGNER_ROLES = ['OPERATIONS', 'ANCHOR', 'WINERY'] as const
export const ChainSignerRoleSchema = z.enum(CHAIN_SIGNER_ROLES)
export type ChainSignerRole = z.infer<typeof ChainSignerRoleSchema>

export const ChainSignerSchema = z.object({
  role: ChainSignerRoleSchema,
  address: z.string(),
  wineryId: z.string().nullable(),
})
export type ChainSigner = z.infer<typeof ChainSignerSchema>

export const CHAIN_SUBJECT_TYPES = ['WINERY', 'CONTRACT', 'MINT', 'LOT', 'TOKEN', 'PLATFORM'] as const
export const ChainSubjectTypeSchema = z.enum(CHAIN_SUBJECT_TYPES)
export type ChainSubjectType = z.infer<typeof ChainSubjectTypeSchema>

export const ChainSubjectSchema = z.object({
  type: ChainSubjectTypeSchema,
  id: z.string(),
})
export type ChainSubject = z.infer<typeof ChainSubjectSchema>

export const ChainTxResultSchema = z.object({
  /** Valor devuelto (p. ej. el último id emitido por `mint_batch`) */
  returnValue: z.json(),
  /** Tipos de los eventos del contrato que emitió */
  contractEvents: z.array(z.string()),
})
export type ChainTxResult = z.infer<typeof ChainTxResultSchema>

export const ChainTxHistoryEntrySchema = z.object({
  attempt: z.number().int().min(1),
  status: ChainTxStatusSchema,
  at: IsoDateTimeSchema,
  txHash: z.string().nullable(),
  /** Número de secuencia de la cuenta de origen */
  sequence: z.string().nullable(),
  errorCode: z.string().nullable(),
  /** Código de resultado de la red o del contrato */
  detail: z.string().nullable(),
})
export type ChainTxHistoryEntry = z.infer<typeof ChainTxHistoryEntrySchema>

export const ChainTxRequestedBySchema = z.object({
  userId: z.string().nullable(),
  fullName: z.string().nullable(),
  source: z.enum(['API', 'WORKER']),
})
export type ChainTxRequestedBy = z.infer<typeof ChainTxRequestedBySchema>

export const ChainTxAbandonedSchema = z.object({
  at: IsoDateTimeSchema,
  by: z.string(),
  reason: z.string(),
})
export type ChainTxAbandoned = z.infer<typeof ChainTxAbandonedSchema>

export const ChainTransactionSchema = z.object({
  id: z.string(),
  kind: ChainTxKindSchema,
  status: ChainTxStatusSchema,
  network: ChainNetworkSchema,
  /** Hex de 64; se conoce al firmar */
  txHash: z.string().nullable(),
  /** Lo construye el backend (`STELLAR_EXPLORER_BASE_URL`) */
  explorerUrl: z.string().nullable(),
  ledger: z.number().int().nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
  attempts: z.number().int().min(0),
  lastError: ChainTxErrorSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** Único: reprocesar el evento no crea otra transacción */
  intentKey: z.string(),
  subject: ChainSubjectSchema,
  wineryId: z.string().nullable(),
  /** Parámetros validados de la intención; sin secretos ni XDR */
  intent: z.record(z.string(), z.unknown()),
  /** Quien paga (`null` hasta que el worker la construye) */
  sourceAccount: z.string().nullable(),
  signers: z.array(ChainSignerSchema),
  feeChargedStroops: z.string().nullable(),
  rentFeeStroops: z.string().nullable(),
  /** Tope de comisión con el que se construyó */
  maxFeeStroops: z.string().nullable(),
  result: ChainTxResultSchema.nullable(),
  history: z.array(ChainTxHistoryEntrySchema),
  nextAttemptAt: IsoDateTimeSchema.nullable(),
  requestedBy: ChainTxRequestedBySchema,
  abandoned: ChainTxAbandonedSchema.nullable(),
  correlationId: z.string().nullable(),
})
export type ChainTransaction = z.infer<typeof ChainTransactionSchema>

export const DashboardChainOpenAlertsSchema = z.object({
  critical: z.number().int().min(0),
  warning: z.number().int().min(0),
})
export type DashboardChainOpenAlerts = z.infer<typeof DashboardChainOpenAlertsSchema>

export const RECONCILIATION_STATUSES = ['RUNNING', 'OK', 'DIFFERENCES', 'ERROR'] as const
export const ReconciliationStatusSchema = z.enum(RECONCILIATION_STATUSES)
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>

export const DashboardLastReconciliationSchema = z.object({
  at: IsoDateTimeSchema,
  status: ReconciliationStatusSchema,
})
export type DashboardLastReconciliation = z.infer<typeof DashboardLastReconciliationSchema>

export const DashboardChainSchema = z.object({
  network: ChainNetworkSchema,
  /** Saldo de la cuenta de operaciones en XLM (`"0.0000000"` mientras no se haya leído de la red) */
  operationsBalanceXlm: z.string(),
  anchorBalanceXlm: z.string(),
  /** Transacciones `FAILED` sin abandonar */
  failedTransactions: z.number().int().min(0),
  /** Transacciones `SUBMITTED` o `RETRYING` desde hace más de 15 min */
  stuckTransactions: z.number().int().min(0),
  openAlerts: DashboardChainOpenAlertsSchema,
  lastReconciliation: DashboardLastReconciliationSchema.nullable(),
  /** Retraso del indexador de eventos, en segundos (0 sin cursor) */
  indexerLagSeconds: z.number().int().min(0),
})
export type DashboardChain = z.infer<typeof DashboardChainSchema>

export const DOSSIER_ANCHOR_STATUSES = ['PENDING', 'SUBMITTED', 'ANCHORED', 'FAILED'] as const
export const DossierAnchorStatusSchema = z.enum(DOSSIER_ANCHOR_STATUSES)
export type DossierAnchorStatus = z.infer<typeof DossierAnchorStatusSchema>

export const DossierAnchorSchema = z.object({
  status: DossierAnchorStatusSchema,
  network: ChainNetworkSchema,
  /** Cuenta de anclaje */
  account: z.string(),
  /** SHA-256 del expediente (los 32 bytes del memo), en hex */
  memoHashHex: z.string(),
  /** Los mismos 32 bytes en base64 (como los muestra un explorador) */
  memoHashBase64: z.string(),
  txHash: z.string().nullable(),
  ledger: z.number().int().nullable(),
  anchoredAt: IsoDateTimeSchema.nullable(),
  explorerUrl: z.string().nullable(),
  /** Cuándo el servidor leyó la transacción y comprobó memo y cuenta de origen */
  verifiedAt: IsoDateTimeSchema.nullable(),
  transaction: ChainTxRefSchema,
})
export type DossierAnchor = z.infer<typeof DossierAnchorSchema>

export const DOSSIER_VERIFICATION_CHECK_KEIES = ['DOSSIER_CLOSED', 'ANCHOR_CONFIRMED', 'MEMO_MATCHES_HASH', 'ANCHOR_ACCOUNT_OFFICIAL'] as const
export const DossierVerificationCheckKeySchema = z.enum(DOSSIER_VERIFICATION_CHECK_KEIES)
export type DossierVerificationCheckKey = z.infer<typeof DossierVerificationCheckKeySchema>

export const PLATFORM_ACCOUNT_BALANCE_STATUSES = ['OK', 'LOW', 'MISSING'] as const
export const PlatformAccountBalanceStatusSchema = z.enum(PLATFORM_ACCOUNT_BALANCE_STATUSES)
export type PlatformAccountBalanceStatus = z.infer<typeof PlatformAccountBalanceStatusSchema>

export const PlatformAccountStatusSchema = z.object({
  /** `null` con `status: MISSING` (cuenta sin configurar) */
  address: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  /** XLM con 7 decimales (`"0.0000000"` si falta la cuenta) */
  balanceXlm: z.string(),
  minBalanceXlm: z.string(),
  status: PlatformAccountBalanceStatusSchema,
  /** Última lectura del saldo en la red */
  checkedAt: IsoDateTimeSchema.nullable(),
})
export type PlatformAccountStatus = z.infer<typeof PlatformAccountStatusSchema>

export const PlatformChainAccountsSchema = z.object({
  network: ChainNetworkSchema,
  operations: PlatformAccountStatusSchema,
  anchor: PlatformAccountStatusSchema,
  /** Código del contrato NFT (`WINERY_NFT_WASM_HASH`) */
  wasmHash: z.string().nullable(),
  /** Días de vida que le quedan al código en la red (§8.3) */
  codeTtlDays: z.number().int().nullable(),
})
export type PlatformChainAccounts = z.infer<typeof PlatformChainAccountsSchema>

export const PublicChainRegistryPlatformSchema = z.object({
  operationsAccount: z.string().nullable(),
  anchorAccount: z.string().nullable(),
})
export type PublicChainRegistryPlatform = z.infer<typeof PublicChainRegistryPlatformSchema>

export const PublicChainRegistryWinerySchema = z.object({
  slug: z.string(),
  tradeName: z.string(),
  symbol: z.string(),
  account: z.string(),
  contract: z.string(),
  accountExplorerUrl: z.string().nullable(),
  contractExplorerUrl: z.string().nullable(),
  paused: z.boolean(),
  /** Contrato desplegado */
  since: IsoDateTimeSchema,
})
export type PublicChainRegistryWinery = z.infer<typeof PublicChainRegistryWinerySchema>

export const PublicChainRegistrySchema = z.object({
  network: ChainNetworkSchema,
  networkPassphrase: z.string(),
  wasmHash: z.string().nullable(),
  platform: PublicChainRegistryPlatformSchema,
  wineries: z.array(PublicChainRegistryWinerySchema),
  generatedAt: IsoDateTimeSchema,
})
export type PublicChainRegistry = z.infer<typeof PublicChainRegistrySchema>

export const PUBLIC_DOSSIER_ANCHOR_STATUSES = ['PENDING', 'ANCHORED'] as const
export const PublicDossierAnchorStatusSchema = z.enum(PUBLIC_DOSSIER_ANCHOR_STATUSES)
export type PublicDossierAnchorStatus = z.infer<typeof PublicDossierAnchorStatusSchema>

export const PublicDossierAnchorSchema = z.object({
  status: PublicDossierAnchorStatusSchema,
  network: ChainNetworkSchema,
  account: z.string(),
  memoHashHex: z.string(),
  memoHashBase64: z.string(),
  txHash: z.string().nullable(),
  ledger: z.number().int().nullable(),
  anchoredAt: IsoDateTimeSchema.nullable(),
  explorerUrl: z.string().nullable(),
})
export type PublicDossierAnchor = z.infer<typeof PublicDossierAnchorSchema>

export const PublicVerificationDossierSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']),
  hash: z.string().nullable(),
  algorithm: z.literal('sha256/jcs-rfc8785'),
  closedAt: IsoDateTimeSchema.nullable(),
  /** Bytes canónicos para recalcular la huella (O2 §12.1) */
  canonicalUrl: z.string().nullable(),
})
export type PublicVerificationDossier = z.infer<typeof PublicVerificationDossierSchema>

export const PublicVerificationCheckSchema = z.object({
  key: DossierVerificationCheckKeySchema,
  /** `null` = aún no aplica */
  pass: z.boolean().nullable(),
  message: z.string(),
})
export type PublicVerificationCheck = z.infer<typeof PublicVerificationCheckSchema>

export const PublicDossierVerificationSchema = z.object({
  lotCode: z.string(),
  dossier: PublicVerificationDossierSchema,
  anchor: PublicDossierAnchorSchema.nullable(),
  /** La de `stellar.toml` y del registro (`null` si el entorno no tiene cuenta de anclaje) */
  officialAnchorAccount: z.string().nullable(),
  checks: z.array(PublicVerificationCheckSchema),
  /** Comprobación del servidor al confirmar el anclaje */
  verifiedOnChainAt: IsoDateTimeSchema.nullable(),
  checkedAt: IsoDateTimeSchema,
})
export type PublicDossierVerification = z.infer<typeof PublicDossierVerificationSchema>

export const RECONCILIATION_DEPTHS = ['LIGHT', 'FULL'] as const
export const ReconciliationDepthSchema = z.enum(RECONCILIATION_DEPTHS)
export type ReconciliationDepth = z.infer<typeof ReconciliationDepthSchema>

export const RECONCILIATION_SCOPES = ['ALL', 'CONTRACT', 'COLLECTION'] as const
export const ReconciliationScopeSchema = z.enum(RECONCILIATION_SCOPES)
export type ReconciliationScope = z.infer<typeof ReconciliationScopeSchema>

export const RECONCILIATION_TRIGGERS = ['SCHEDULED', 'MANUAL', 'INDEXER_GAP'] as const
export const ReconciliationTriggerSchema = z.enum(RECONCILIATION_TRIGGERS)
export type ReconciliationTrigger = z.infer<typeof ReconciliationTriggerSchema>

export const ReconciliationRunDetailSchema = z.object({
  id: z.string(),
  scope: ReconciliationScopeSchema,
  subjectId: z.string().nullable(),
  trigger: ReconciliationTriggerSchema,
  depth: ReconciliationDepthSchema,
  status: ReconciliationStatusSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  checks: z.number().int().min(0),
  issuesOpened: z.number().int().min(0),
  issuesAutoResolved: z.number().int().min(0),
  alerts: z.array(ChainAlertSchema),
})
export type ReconciliationRunDetail = z.infer<typeof ReconciliationRunDetailSchema>

export const ReconciliationRunSchema = z.object({
  id: z.string(),
  scope: ReconciliationScopeSchema,
  subjectId: z.string().nullable(),
  trigger: ReconciliationTriggerSchema,
  depth: ReconciliationDepthSchema,
  status: ReconciliationStatusSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  checks: z.number().int().min(0),
  issuesOpened: z.number().int().min(0),
  issuesAutoResolved: z.number().int().min(0),
})
export type ReconciliationRun = z.infer<typeof ReconciliationRunSchema>

export const ResolveChainAlertSchema = z.object({
  /** Qué se comprobó y cómo se resolvió (queda en la bitácora) */
  note: z.string().min(3).max(500),
})
export type ResolveChainAlert = z.infer<typeof ResolveChainAlertSchema>

export const StartReconciliationSchema = z.object({
  scope: ReconciliationScopeSchema,
  /** Id del contrato o de la colección (obligatorio salvo con `scope: ALL`) */
  subjectId: z.string().optional(),
  depth: ReconciliationDepthSchema.optional(),
})
export type StartReconciliation = z.infer<typeof StartReconciliationSchema>

export const UserRefSchema = z.object({
  userId: z.string(),
  fullName: z.string(),
})
export type UserRef = z.infer<typeof UserRefSchema>

export const WineryChainIdentitySchema = z.object({
  wineryId: z.string(),
  network: ChainNetworkSchema,
  /** `ACTIVE` exige cuenta y contrato confirmados y leídos de vuelta */
  status: ChainIdentityStatusSchema,
  account: ChainIdentityAccountSchema.nullable(),
  contract: ChainIdentityContractSchema.nullable(),
  pendingTransactions: z.array(ChainTxRefSchema),
  lastError: ChainIdentityErrorSchema.nullable(),
})
export type WineryChainIdentity = z.infer<typeof WineryChainIdentitySchema>

export const WineryRefSchema = z.object({
  slug: z.string(),
  tradeName: z.string(),
})
export type WineryRef = z.infer<typeof WineryRefSchema>
