import { z } from 'zod'
import { CorrectionMarksShape, DateInputSchema, IsoDateTimeSchema } from './common'
import { PhytosanitaryStatusSchema } from './enums'
import { CreateLotSchema, DoEvaluationSchema, TraceActorSchema } from './lots'

// /v1/harvest-batches · HarvestBatchResponseDto, CreateHarvestBatchDto, UpdatePhytoStatusDto y,
// desde la Ola 2 (contrato §3), el análisis de madurez y el dictamen fitosanitario aparte.

/** La parcela tal como era al pesar (`TerroirSnapshotDto`). */
export const TerroirSnapshotSchema = z.object({
  parcelName: z.string(),
  altitudeMasl: z.number(),
  varietyName: z.string(),
  rawMaterialType: z.string(),
  takenAt: IsoDateTimeSchema,
})
export type TerroirSnapshot = z.infer<typeof TerroirSnapshotSchema>

/** Análisis de madurez (`MaturityAnalysisResponseDto`, §3.3): solo inserción; el último es el vigente. */
export const MaturityAnalysisSchema = z.object({
  ...CorrectionMarksShape,
  id: z.string(),
  harvestBatchId: z.string(),
  brixDegrees: z.number(),
  ph: z.number(),
  acidityGl: z.number(),
  measuredAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
  recordedBy: TraceActorSchema.nullable(),
  notes: z.string().nullable(),
  source: z.enum(['ERP', 'MIGRATION']),
})
export type MaturityAnalysis = z.infer<typeof MaturityAnalysisSchema>

/** Rangos del análisis: Brix 0–40, pH 2–5, acidez 0–30 g/L. */
const maturityValues = {
  brixDegrees: z.number().min(0).max(40),
  ph: z.number().min(2).max(5),
  acidityGl: z.number().min(0).max(30),
}

/** `POST /v1/harvest-batches/{id}/maturity-analyses` (`CreateMaturityAnalysisDto`). */
export const CreateMaturityAnalysisSchema = z.object({
  ...maturityValues,
  measuredAt: DateInputSchema,
  notes: z.string().max(2000).optional(),
})
export type CreateMaturityAnalysisDto = z.infer<typeof CreateMaturityAnalysisSchema>

/** `maturity` del alta del pesaje (`MaturityInputDto`). */
export const MaturityInputSchema = z.object({ ...maturityValues, measuredAt: DateInputSchema.optional() })
export type MaturityInput = z.infer<typeof MaturityInputSchema>

/** Dictámenes posibles (`PENDING_INSPECTION` es el estado inicial, no un dictamen). */
export const PHYTO_DECISIONS = ['APPROVED', 'REJECTED', 'QUARANTINE'] as const
export const PhytoDecisionValueSchema = z.enum(PHYTO_DECISIONS)
export type PhytoDecisionValue = z.infer<typeof PhytoDecisionValueSchema>

/** Informe adjunto por su `key` de `POST /v1/uploads` (`InspectionReportDto`, `LabReportDto`). */
export const FileReferenceSchema = z.object({
  key: z.string(),
  sha256: z.string().nullable(),
  /** URL firmada de corta vida. */
  url: z.string().nullable(),
})
export type FileReference = z.infer<typeof FileReferenceSchema>

/** Dictamen fitosanitario (`PhytoDecisionResponseDto`, §3.4): solo inserción. */
export const PhytoDecisionSchema = z.object({
  ...CorrectionMarksShape,
  id: z.string(),
  harvestBatchId: z.string(),
  decision: PhytoDecisionValueSchema,
  decidedAt: IsoDateTimeSchema,
  recordedAt: IsoDateTimeSchema,
  /** `null` = no registrado (datos migrados sin autor). */
  decidedBy: TraceActorSchema.nullable(),
  inspectionReport: FileReferenceSchema.nullable(),
  notes: z.string().nullable(),
  source: z.enum(['ERP', 'MIGRATION']),
})
export type PhytoDecision = z.infer<typeof PhytoDecisionSchema>

/** `POST /v1/harvest-batches/{id}/phyto-decisions`: `REJECTED` y `QUARANTINE` exigen `notes`. */
export const CreatePhytoDecisionSchema = z.object({
  decision: PhytoDecisionValueSchema,
  inspectionReportKey: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
  decidedAt: DateInputSchema.optional(),
})
export type CreatePhytoDecisionDto = z.infer<typeof CreatePhytoDecisionSchema>

export const HarvestBatchResponseSchema = z.object({
  ...CorrectionMarksShape,
  id: z.string(),
  wineryId: z.string(),
  terroirId: z.string(),
  harvestBatchCode: z.string(),
  intakeDate: IsoDateTimeSchema,
  harvestYear: z.number().int(),
  grossWeightKg: z.number(),
  tareWeightKg: z.number(),
  netWeightKg: z.number(),
  /** Del último análisis de madurez; `null` sin análisis (cambio incompatible de la Ola 2). */
  brixDegrees: z.number().nullable(),
  initialPh: z.number().nullable(),
  initialAcidityGl: z.number().nullable(),
  temperatureAtIntakeC: z.number().nullish(),
  /** El del último dictamen (`PENDING_INSPECTION` si no hay ninguno). */
  phytosanitaryStatus: PhytosanitaryStatusSchema,
  phytoInspectionPdfUrl: z.string().nullish(),
  certifiedByMemberId: z.string().nullish(),
  notes: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
  /** Lote (Ola 2); `null` = uva recibida sin lote. */
  lotId: z.string().nullable(),
  terroirSnapshot: TerroirSnapshotSchema.nullable(),
  // Solo en las rutas de vendimia (no en los pesajes anidados en otros recursos):
  maturityAnalyses: z.array(MaturityAnalysisSchema).optional(),
  phytoDecisions: z.array(PhytoDecisionSchema).optional(),
  /** Kilos netos que aún no entraron a un tanque. */
  availableKg: z.number().optional(),
  /** D.O. con la instantánea del lote (solo lotes singani). */
  doEvaluation: DoEvaluationSchema.nullish(),
  /** Registrado más de 7 días después de `intakeDate` (S-9). */
  lateEntry: z.boolean().optional(),
})
export type HarvestBatchResponse = z.infer<typeof HarvestBatchResponseSchema>

/**
 * @deprecated Desde la Ola 2 el análisis es opcional en el alta (`maturity`) y se registra aparte.
 * Los tres campos planos se admiten hasta H2: si llegan los tres, se convierten en `maturity`.
 */
export const HARVEST_LAB_FIELDS = ['brixDegrees', 'initialPh', 'initialAcidityGl'] as const

export const CreateHarvestBatchSchema = z
  .object({
    /** Lote al que entra la uva (o `newLot`, o ninguno: uva recibida sin lote, §2.4). */
    lotId: z.string().min(1).optional(),
    /** Crea el lote desde la vendimia (solo OWNER y ENOLOGIST). */
    newLot: CreateLotSchema.optional(),
    terroirId: z.string().min(1),
    intakeDate: DateInputSchema,
    /** Por defecto, el del lote o el de `intakeDate`. */
    harvestYear: z.number().int().min(1900).max(2100).optional(),
    grossWeightKg: z.number().positive(),
    tareWeightKg: z.number().min(0),
    temperatureAtIntakeC: z.number().optional(),
    maturity: MaturityInputSchema.optional(),
    /** @deprecated Hasta H2: con `initialPh` e `initialAcidityGl` se convierte en `maturity`. */
    brixDegrees: z.number().min(0).max(40).optional(),
    /** @deprecated Hasta H2. */
    initialPh: z.number().min(0).max(14).optional(),
    /** @deprecated Hasta H2. */
    initialAcidityGl: z.number().min(0).max(30).optional(),
    /** @deprecated Solo se admite `PENDING_INSPECTION`; otro valor → 422 `TRC_PHYTO_IN_CREATE` (EA-04). */
    phytosanitaryStatus: PhytosanitaryStatusSchema.optional(),
    notes: z.string().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.lotId && b.newLot) ctx.addIssue({ code: 'custom', message: 'Indica lotId o newLot, no ambos', path: ['newLot'] })
  })
export type CreateHarvestBatchDto = z.infer<typeof CreateHarvestBatchSchema>

/** `PATCH …/phyto-status` (legado, alias de `POST …/phyto-decisions` hasta H2). */
export const UpdatePhytoStatusSchema = z.object({
  phytosanitaryStatus: PhytosanitaryStatusSchema,
  phytoInspectionPdfUrl: z.string().nullish(),
  /** Motivo del dictamen (obligatorio en `REJECTED` y `QUARANTINE`); ya no pisa las notas del pesaje. */
  notes: z.string().nullish(),
})
export type UpdatePhytoStatusDto = z.infer<typeof UpdatePhytoStatusSchema>
