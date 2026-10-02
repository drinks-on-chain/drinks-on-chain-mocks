import { z } from 'zod'
import { CorrectionMarksShape, DateInputSchema, IsoDateTimeSchema, JsonObjectSchema } from './common'
import { FileReferenceSchema } from './harvest-batches'
import { ErrorDetailSchema, LabLimitSchema, TraceActorSchema } from './lots'

// /v1/lab-analyses y /v1/lots/{id}/lab-analyses · laboratorio con conformidad calculada y unidades
// (contrato de la Ola 2 §8; EA-08): BatchLabAnalysisResponseDto, CreateBatchLabAnalysisDto (legado),
// CreateLotLabAnalysisDto, LabConformityDto.

export const LAB_CONFORMITY_STATUSES = ['CONFORMING', 'NON_CONFORMING', 'INCOMPLETE'] as const
export const LabConformityStatusSchema = z.enum(LAB_CONFORMITY_STATUSES)
export type LabConformityStatus = z.infer<typeof LabConformityStatusSchema>

export const LabConformityCheckSchema = z.object({
  /** Clave del límite: `metanol`, `cobre`, `acidezVolatil`, `grado`… */
  parameter: z.string(),
  value: z.number().nullable(),
  unit: z.string(),
  limit: LabLimitSchema.nullable(),
  result: z.enum(['PASS', 'FAIL', 'MISSING', 'UNIT_UNKNOWN']),
})
export type LabConformityCheck = z.infer<typeof LabConformityCheckSchema>

/**
 * Conformidad calculada contra `rules.lab.limits` de la instantánea del lote (`LabConformityDto`).
 * Falta un parámetro exigido → `INCOMPLETE` (nunca conforme por omisión).
 */
export const LabConformitySchema = z.object({
  status: LabConformityStatusSchema,
  checks: z.array(LabConformityCheckSchema),
  /** Avisos, p. ej. grado medido distinto del etiquetado en más de 0,5 % vol (S-15). */
  warnings: z.array(ErrorDetailSchema),
  rulesTakenAt: IsoDateTimeSchema,
})
export type LabConformity = z.infer<typeof LabConformitySchema>

/** Unidad de cada campo del análisis (§8.2), explícita en la respuesta (`LabUnitsDto`). */
export const LAB_UNITS = {
  actualAlcoholAbv: '% v/v a 20 °C',
  totalAlcoholAbv: '% v/v a 20 °C',
  totalAcidityTartaricGl: 'g/L como ácido tartárico',
  volatileAcidityAceticGl: 'g/L como ácido acético',
  freeSulfurDioxideMgL: 'mg/L',
  totalSulfurDioxideMgL: 'mg/L',
  reducingSugarsGl: 'g/L',
  totalDryExtractGl: 'g/L',
  sugarFreeDryExtractGl: 'g/L',
  overpressureBar: 'bar',
  methanolContentMgL: 'mg/L de producto',
  methanolMg100mlAa: 'mg/100 mL de alcohol anhidro',
  copperContentMgL: 'mg/L',
} as const

export const LabUnitsSchema = z.object({
  actualAlcoholAbv: z.string(),
  totalAlcoholAbv: z.string(),
  totalAcidityTartaricGl: z.string(),
  volatileAcidityAceticGl: z.string(),
  freeSulfurDioxideMgL: z.string(),
  totalSulfurDioxideMgL: z.string(),
  reducingSugarsGl: z.string(),
  totalDryExtractGl: z.string(),
  sugarFreeDryExtractGl: z.string(),
  overpressureBar: z.string(),
  methanolContentMgL: z.string(),
  methanolMg100mlAa: z.string(),
  copperContentMgL: z.string(),
})
export type LabUnits = z.infer<typeof LabUnitsSchema>

export const BatchLabAnalysisResponseSchema = z.object({
  ...CorrectionMarksShape,
  /** Anulado por una corrección `VOID` (§9): deja de contar y nunca es el vigente. */
  voidedAt: IsoDateTimeSchema.nullable().optional(),
  id: z.string(),
  bottlingBatchId: z.string(),
  certifiedLaboratoryName: z.string(),
  accreditedLabCertificationCode: z.string(),
  analysisRequestDate: IsoDateTimeSchema.nullish(),
  testPerformedAt: IsoDateTimeSchema,
  actualAlcoholAbv: z.number(),
  totalAlcoholAbv: z.number().nullish(),
  totalAcidityTartaricGl: z.number(),
  volatileAcidityAceticGl: z.number(),
  freeSulfurDioxideMgL: z.number().nullish(),
  totalSulfurDioxideMgL: z.number().nullish(),
  reducingSugarsGl: z.number().nullish(),
  totalDryExtractGl: z.number().nullish(),
  sugarFreeDryExtractGl: z.number().nullish(),
  overpressureBar: z.number().nullish(),
  /** mg/L **de producto**. */
  methanolContentMgL: z.number().nullish(),
  copperContentMgL: z.number().nullish(),
  additionalParams: JsonObjectSchema.nullish(),
  laboratoryReportPdfUrl: z.string(),
  /** Calculado: `conformityStatus === 'CONFORMING'`. En la entrada se ignora. */
  conformsToSenasagStandards: z.boolean(),
  /** Declarados por el laboratorio (sin verificar; fuera del pasaporte). */
  conformsToEuStandards: z.boolean(),
  conformsToUsaStandards: z.boolean(),
  reviewedByMemberId: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
  /** Lote (Ola 2). */
  lotId: z.string().nullable(),
  /** Metanol en mg/100 mL de alcohol anhidro (si solo llega mg/L: `10 × mgL / grado`). */
  methanolMg100mlAa: z.number().nullable(),
  conformityStatus: LabConformityStatusSchema.nullable(),
  /** Sustituido por un reanálisis. */
  supersededAt: IsoDateTimeSchema.nullable(),
  // Solo en las rutas de laboratorio:
  conformity: LabConformitySchema.nullish(),
  units: LabUnitsSchema.optional(),
  /** Es el análisis vigente del embotellado. */
  current: z.boolean().optional(),
  recordedBy: TraceActorSchema.nullish(),
  report: FileReferenceSchema.nullish(),
})
export type BatchLabAnalysisResponse = z.infer<typeof BatchLabAnalysisResponseSchema>

const labValues = {
  certifiedLaboratoryName: z.string().min(1),
  accreditedLabCertificationCode: z.string().min(1),
  analysisRequestDate: DateInputSchema.optional(),
  testPerformedAt: DateInputSchema,
  actualAlcoholAbv: z.number().min(0).max(100),
  totalAlcoholAbv: z.number().min(0).max(100).optional(),
  totalAcidityTartaricGl: z.number().min(0),
  volatileAcidityAceticGl: z.number().min(0),
  freeSulfurDioxideMgL: z.number().min(0).optional(),
  totalSulfurDioxideMgL: z.number().min(0).optional(),
  reducingSugarsGl: z.number().min(0).optional(),
  totalDryExtractGl: z.number().min(0).optional(),
  sugarFreeDryExtractGl: z.number().min(0).optional(),
  overpressureBar: z.number().min(0).optional(),
  /** Metanol en mg/L de producto; sin `methanolMg100mlAa`, el servidor lo convierte. */
  methanolContentMgL: z.number().min(0).optional(),
  /** Metanol en mg/100 mL de alcohol anhidro; si llegan ambos y difieren > 1 % → 422. */
  methanolMg100mlAa: z.number().min(0).optional(),
  copperContentMgL: z.number().min(0).optional(),
  additionalParams: JsonObjectSchema.optional(),
  conformsToEuStandards: z.boolean().optional(),
  conformsToUsaStandards: z.boolean().optional(),
}

/** `POST /v1/lab-analyses` (legado, alias hasta H2): un análisis nuevo sustituye al anterior. */
export const CreateBatchLabAnalysisSchema = z.object({
  bottlingBatchId: z.string().min(1),
  ...labValues,
  laboratoryReportPdfUrl: z.string().min(1),
  /** @deprecated Se ignora: la conformidad la calcula el servidor (EA-08). Sale de la entrada en H2. */
  conformsToSenasagStandards: z.boolean().optional(),
})
export type CreateBatchLabAnalysisDto = z.infer<typeof CreateBatchLabAnalysisSchema>

/** `POST /v1/lots/{id}/lab-analyses` (`CreateLotLabAnalysisDto`). */
export const CreateLotLabAnalysisSchema = z
  .object({
    ...labValues,
    /** `key` del informe firmado (`POST /v1/uploads`). */
    laboratoryReportKey: z.string().min(1).optional(),
    /** @deprecated Alias de `laboratoryReportKey` hasta H2. */
    laboratoryReportPdfUrl: z.string().min(1).optional(),
  })
  .superRefine((b, ctx) => {
    if (!b.laboratoryReportKey && !b.laboratoryReportPdfUrl) {
      ctx.addIssue({ code: 'custom', message: 'Adjunta el informe del laboratorio (laboratoryReportKey)', path: ['laboratoryReportKey'] })
    }
  })
export type CreateLotLabAnalysisDto = z.infer<typeof CreateLotLabAnalysisSchema>
