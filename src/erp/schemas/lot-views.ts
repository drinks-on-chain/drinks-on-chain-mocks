import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { BottlingBalanceSchema } from './bottling'
import { PhytosanitaryStatusSchema } from './enums'
import {
  LotLabStatusSchema,
  LotLockInfoSchema,
  LotProductTypeSchema,
  LotStageCodeSchema,
  LotSummarySchema,
  TraceActorSchema,
} from './lots'

// Vistas, correcciones, adjuntos y expediente del lote (contrato de la Ola 2 §9–§11):
// LotBalanceDto, LotGraphDto, TraceDashboardDto, ProductionReportDto, CorrectionDto,
// LotAttachmentDto, LotDossierDto y DossierPreviewDto.

// ----- Balance kilos → litros → botellas (§11.3) -----

export const LotBalanceSchema = z.object({
  harvest: z.object({ netKg: z.number(), approvedKg: z.number(), rejectedKg: z.number(), pendingKg: z.number() }),
  must: z.object({ filledLiters: z.number(), litersPerKg: z.number().nullable() }),
  fermentation: z.object({ finalLiters: z.number().nullable(), lossLiters: z.number().nullable(), lossPercent: z.number().nullable() }),
  /** Solo vino. */
  aging: z.object({ liters: z.number(), lossLiters: z.number() }).optional(),
  /** Solo singani. */
  distillation: z
    .object({
      inputLiters: z.number(),
      headsLiters: z.number(),
      heartLiters: z.number(),
      tailsLiters: z.number(),
      heartAbvPercent: z.number().nullable(),
      /** Corazón × grado. */
      pureAlcoholLiters: z.number().nullable(),
    })
    .optional(),
  bottling: BottlingBalanceSchema.nullable(),
  projection: z.object({
    bottles: z.number().int().nullable(),
    /** Etapa de la que sale la proyección (S-19). */
    basis: z.enum(['DECLARED', 'MUST', 'BASE_WINE', 'DISTILLATE', 'BOTTLED']),
  }),
})
export type LotBalance = z.infer<typeof LotBalanceSchema>

// ----- Grafo del lote (§11.3, SE-07) -----

export const LOT_GRAPH_NODE_TYPES = ['TERROIR', 'HARVEST_BATCH', 'TANK', 'WINE_AGING', 'DISTILLATION', 'BOTTLING', 'LAB_ANALYSIS'] as const

export const LotGraphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(LOT_GRAPH_NODE_TYPES),
  label: z.string(),
  occurredAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
  quantity: z.object({ value: z.number(), unit: z.enum(['kg', 'L', 'bottles']) }).nullable(),
  /** `value: null` = no registrado. */
  metrics: z.array(z.object({ key: z.string(), label: z.string(), value: z.union([z.number(), z.string()]).nullable(), unit: z.string().nullable() })),
  actor: TraceActorSchema.nullable(),
  /** Estado del registro. */
  status: z.string(),
  corrected: z.boolean(),
})
export type LotGraphNode = z.infer<typeof LotGraphNodeSchema>

export const LotGraphSchema = z.object({
  lotId: z.string(),
  lotCode: z.string().nullable(),
  productType: LotProductTypeSchema.nullable(),
  nodes: z.array(LotGraphNodeSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string(), quantity: z.object({ value: z.number(), unit: z.enum(['kg', 'L']) }).nullable() })),
})
export type LotGraph = z.infer<typeof LotGraphSchema>

// ----- Panel de la bodega (§11.2) -----

export const TraceDashboardSchema = z.object({
  lotsByStage: z.object({
    ORIGIN: z.number().int().min(0),
    HARVEST: z.number().int().min(0),
    FERMENTING: z.number().int().min(0),
    AGING: z.number().int().min(0),
    DISTILLING: z.number().int().min(0),
    RESTING: z.number().int().min(0),
    BOTTLED: z.number().int().min(0),
    CERTIFIED: z.number().int().min(0),
    ANCHORED: z.number().int().min(0),
    REJECTED: z.number().int().min(0),
    DISCARDED: z.number().int().min(0),
  }),
  /** Desbloqueo en ≤ 14 días. */
  locksDueSoon: z.array(z.object({ lotId: z.string(), reference: z.string(), name: z.string(), lock: LotLockInfoSchema })),
  /** > 32 °C en la última lectura o 48 h sin lecturas en un tanque `FERMENTING` (S-18). */
  fermentationAlerts: z.array(
    z.object({
      tankId: z.string(),
      tankCode: z.string(),
      lotId: z.string(),
      kind: z.enum(['HIGH_TEMPERATURE', 'NO_READING']),
      value: z.number().nullable(),
      lastReadingAt: IsoDateTimeSchema.nullable(),
    }),
  ),
  pendingPhyto: z.array(
    z.object({
      harvestBatchId: z.string(),
      harvestBatchCode: z.string(),
      lotId: z.string().nullable(),
      intakeDate: IsoDateTimeSchema,
      status: PhytosanitaryStatusSchema,
    }),
  ),
  bottledWithoutLab: z.array(LotSummarySchema),
  readyToClose: z.array(LotSummarySchema),
  complianceIssuesOpen: z.number().int().min(0),
  unassignedHarvestBatches: z.number().int().min(0),
})
export type TraceDashboard = z.infer<typeof TraceDashboardSchema>

// ----- Reporte de producción (§11.4) -----

export const ProductionReportRowSchema = z.object({
  lotId: z.string(),
  reference: z.string(),
  lotCode: z.string().nullable(),
  name: z.string(),
  productType: LotProductTypeSchema.nullable(),
  harvestYear: z.number().int(),
  stage: LotStageCodeSchema,
  netKg: z.number(),
  mustLiters: z.number().nullable(),
  /** Vino base (final de la fermentación). */
  baseWineLiters: z.number().nullable(),
  /** Solo singani. */
  heartLiters: z.number().nullable(),
  bottledLiters: z.number().nullable(),
  bottles: z.number().int().nullable(),
  formatCl: z.number().int().nullable(),
  lossPercentByStage: z.object({
    fermentation: z.number().nullable(),
    transfer: z.number().nullable(),
    distillation: z.number().nullable(),
    bottling: z.number().nullable(),
  }),
  litersPerKg: z.number().nullable(),
  bottlesPerTonne: z.number().nullable(),
  bottlingDate: z.string().nullable(),
  labStatus: LotLabStatusSchema,
})
export type ProductionReportRow = z.infer<typeof ProductionReportRowSchema>

export const ProductionReportTotalsSchema = z.object({
  lots: z.number().int().min(0),
  netKg: z.number(),
  mustLiters: z.number(),
  baseWineLiters: z.number(),
  heartLiters: z.number(),
  bottledLiters: z.number(),
  bottles: z.number().int().min(0),
  litersPerKg: z.number().nullable(),
  bottlesPerTonne: z.number().nullable(),
})
export type ProductionReportTotals = z.infer<typeof ProductionReportTotalsSchema>

export const ProductionReportSchema = z.object({
  rows: z.array(ProductionReportRowSchema),
  /** `UNDECIDED`: lotes sin tipo de producto decidido. */
  totals: z.object({ WINE: ProductionReportTotalsSchema, SINGANI: ProductionReportTotalsSchema, UNDECIDED: ProductionReportTotalsSchema }),
})
export type ProductionReport = z.infer<typeof ProductionReportSchema>

/** Cabecera del CSV de `GET /v1/traceability/reports/production?format=csv`. */
export const PRODUCTION_REPORT_CSV_COLUMNS = [
  'lotId',
  'reference',
  'lotCode',
  'name',
  'productType',
  'harvestYear',
  'stage',
  'netKg',
  'mustLiters',
  'baseWineLiters',
  'heartLiters',
  'bottledLiters',
  'bottles',
  'formatCl',
  'lossPercentFermentation',
  'lossPercentTransfer',
  'lossPercentDistillation',
  'lossPercentBottling',
  'litersPerKg',
  'bottlesPerTonne',
  'bottlingDate',
  'labStatus',
] as const

// ----- Correcciones compensatorias (§9) -----

export const CORRECTION_TARGET_TYPES = [
  'TERROIR',
  'HARVEST_BATCH',
  'MATURITY_ANALYSIS',
  'PHYTO_DECISION',
  'FERMENTATION_TANK',
  'FERMENTATION_LOG',
  'TREATMENT',
  'WINE_AGING',
  'PRODUCTION_BATCH',
  'BOTTLING',
  'LAB_ANALYSIS',
] as const
export const CorrectionTargetTypeSchema = z.enum(CORRECTION_TARGET_TYPES)
export type CorrectionTargetType = z.infer<typeof CorrectionTargetTypeSchema>

export const CorrectionTargetSchema = z.object({ type: CorrectionTargetTypeSchema, id: z.string() })

/** Campos corregibles de cada registro (lista cerrada, §9). Lo demás → 422 `TRC_CORRECTION_FIELD_NOT_CORRECTABLE`. */
export const CORRECTABLE_FIELDS: Record<CorrectionTargetType, readonly string[]> = {
  TERROIR: ['altitudeMasl', 'varietyName', 'rawMaterialType'],
  HARVEST_BATCH: ['grossWeightKg', 'tareWeightKg', 'intakeDate', 'temperatureAtIntakeC', 'notes'],
  MATURITY_ANALYSIS: ['brixDegrees', 'ph', 'acidityGl', 'measuredAt', 'notes'],
  PHYTO_DECISION: [],
  FERMENTATION_TANK: ['volumeFilledLiters', 'finalVolumeLiters', 'startDate', 'endDate'],
  FERMENTATION_LOG: ['temperatureCelsius', 'specificGravity', 'phValue', 'co2Observations', 'recordedAt', 'notes'],
  TREATMENT: ['dosageAppliedGPerHl', 'totalAppliedG', 'additiveName', 'additiveSupplier', 'appliedAt', 'notes'],
  WINE_AGING: ['plannedMonths', 'volumeLiters', 'startDate'],
  PRODUCTION_BATCH: ['inputVolumeLiters', 'headsLiters', 'heartLiters', 'tailsLiters', 'vinasseLiters', 'heartAbvPercent', 'processStartDate', 'processEndDate'],
  BOTTLING: ['finalAlcoholAbv', 'bottleType', 'leftover'],
  LAB_ANALYSIS: [
    'actualAlcoholAbv',
    'totalAlcoholAbv',
    'totalAcidityTartaricGl',
    'volatileAcidityAceticGl',
    'freeSulfurDioxideMgL',
    'totalSulfurDioxideMgL',
    'reducingSugarsGl',
    'totalDryExtractGl',
    'sugarFreeDryExtractGl',
    'overpressureBar',
    'methanolContentMgL',
    'methanolMg100mlAa',
    'copperContentMgL',
    'testPerformedAt',
  ],
}

/** Registros que admiten `VOID` (dejan de contar): lecturas, tratamientos, análisis y dictámenes. */
export const VOIDABLE_TARGET_TYPES: readonly CorrectionTargetType[] = ['MATURITY_ANALYSIS', 'PHYTO_DECISION', 'FERMENTATION_LOG', 'TREATMENT', 'LAB_ANALYSIS']

/** Corrección compensatoria (`CorrectionDto`): el original nunca se pierde. */
export const CorrectionSchema = z.object({
  id: z.string(),
  /** `null` solo en las correcciones de parcelas. */
  lotId: z.string().nullable(),
  target: CorrectionTargetSchema,
  /** `VOID`: el registro deja de contar. */
  kind: z.enum(['AMEND', 'VOID']),
  changes: z.array(z.object({ field: z.string(), before: z.unknown().nullable(), after: z.unknown().nullable() })),
  reason: z.string(),
  createdAt: IsoDateTimeSchema,
  createdBy: TraceActorSchema,
})
export type Correction = z.infer<typeof CorrectionSchema>

/** `POST /v1/lots/{id}/corrections` (`CreateLotCorrectionDto`). */
export const CreateLotCorrectionSchema = z
  .object({
    target: CorrectionTargetSchema,
    kind: z.enum(['AMEND', 'VOID']),
    /** Campo → valor nuevo; obligatorio en `AMEND`. */
    changes: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().trim().min(10).max(500),
  })
  .superRefine((b, ctx) => {
    if (b.kind === 'AMEND' && (!b.changes || Object.keys(b.changes).length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'Indica los campos que se corrigen y su valor nuevo', path: ['changes'] })
    }
  })
export type CreateLotCorrectionDto = z.infer<typeof CreateLotCorrectionSchema>

// ----- Archivos privados del lote (§11.5) -----

export const LOT_ATTACHMENT_KINDS = ['LAB_REPORT', 'PHYTO_REPORT', 'LABEL', 'DO_CERTIFICATE', 'PHOTO', 'OTHER'] as const
export const LotAttachmentKindSchema = z.enum(LOT_ATTACHMENT_KINDS)
export const AttachmentVisibilitySchema = z.enum(['PRIVATE', 'PUBLIC'])

export const LotAttachmentSchema = z.object({
  id: z.string(),
  kind: LotAttachmentKindSchema,
  title: z.string(),
  key: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string(),
  visibility: AttachmentVisibilitySchema,
  /** URL firmada de 15 min. */
  url: z.string(),
  urlExpiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  /** `null` = no registrado (informes de registros anteriores a la Ola 2). */
  createdBy: TraceActorSchema.nullable(),
})
export type LotAttachment = z.infer<typeof LotAttachmentSchema>

/** Adjunto guardado (`lot-attachments.json`): sin la URL firmada, que se calcula al responder. */
export const StoredLotAttachmentSchema = LotAttachmentSchema.omit({ url: true, urlExpiresAt: true }).extend({ lotId: z.string() })
export type StoredLotAttachment = z.infer<typeof StoredLotAttachmentSchema>

/** `POST /v1/lots/{id}/attachments`: referencia un archivo ya subido con `POST /v1/uploads`. */
export const CreateLotAttachmentSchema = z.object({
  key: z.string().min(1),
  kind: LotAttachmentKindSchema,
  title: z.string().trim().min(1).max(200),
  /** Por defecto `PRIVATE`; la etiqueta (`LABEL`) nace `PUBLIC` (S-20). */
  visibility: AttachmentVisibilitySchema.optional(),
})
export type CreateLotAttachmentDto = z.infer<typeof CreateLotAttachmentSchema>

export const ChangeLotAttachmentVisibilitySchema = z.object({ visibility: AttachmentVisibilitySchema })
export type ChangeLotAttachmentVisibilityDto = z.infer<typeof ChangeLotAttachmentVisibilitySchema>

// ----- Expediente y hash canónico (§10) -----

export const DOSSIER_SCHEMA_VERSION = 'doc-dossier/1'
export const DOSSIER_HASH_ALGORITHM = 'sha256/jcs-rfc8785'

/** Expediente del lote (`LotDossierDto`). `anchor` es `null` hasta la Ola 3. */
export const LotDossierSchema = z.object({
  lotId: z.string(),
  schema: z.literal(DOSSIER_SCHEMA_VERSION),
  status: z.enum(['OPEN', 'CLOSED']),
  /** SHA-256 (hex) de los bytes canónicos. */
  hash: z.string().nullable(),
  algorithm: z.literal(DOSSIER_HASH_ALGORITHM),
  closedAt: IsoDateTimeSchema.nullable(),
  closedBy: TraceActorSchema.nullable(),
  bottleCodes: z.object({ count: z.number().int().min(0), merkleRoot: z.string(), algorithm: z.literal('sha256-merkle/serial-code-salt') }).nullable(),
  anchor: z.null(),
})
export type LotDossier = z.infer<typeof LotDossierSchema>

export const DOSSIER_REQUIREMENT_KEYS = ['BOTTLED', 'LAB_CONFORMING', 'BOTTLE_CODES_READY', 'NO_OPEN_COMPLIANCE_ISSUES', 'NO_OPEN_SOURCES'] as const
export const DossierRequirementKeySchema = z.enum(DOSSIER_REQUIREMENT_KEYS)
export type DossierRequirementKey = z.infer<typeof DossierRequirementKeySchema>

/** `GET /v1/lots/{id}/dossier/preview` (`DossierPreviewDto`). */
export const DossierPreviewSchema = z.object({
  ready: z.boolean(),
  requirements: z.array(z.object({ key: DossierRequirementKeySchema, met: z.boolean(), message: z.string() })),
  /** SHA-256 (hex) del contenido canónico si se cerrara ahora. */
  hashPreview: z.string().nullable(),
})
export type DossierPreview = z.infer<typeof DossierPreviewSchema>

/** `POST /v1/lots/{id}/dossier/close`. */
export const CloseDossierSchema = z.object({ confirm: z.literal(true) })
export type CloseDossierDto = z.infer<typeof CloseDossierSchema>
