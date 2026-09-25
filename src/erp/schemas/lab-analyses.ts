import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema, JsonObjectSchema } from './common'

// /v1/lab-analyses · BatchLabAnalysisResponseDto, CreateBatchLabAnalysisDto

export const BatchLabAnalysisResponseSchema = z.object({
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
  methanolContentMgL: z.number().nullish(),
  copperContentMgL: z.number().nullish(),
  additionalParams: JsonObjectSchema.nullish(),
  laboratoryReportPdfUrl: z.string(),
  conformsToSenasagStandards: z.boolean(),
  conformsToEuStandards: z.boolean(),
  conformsToUsaStandards: z.boolean(),
  reviewedByMemberId: z.string().nullish(),
  createdAt: IsoDateTimeSchema,
})
export type BatchLabAnalysisResponse = z.infer<typeof BatchLabAnalysisResponseSchema>

export const CreateBatchLabAnalysisSchema = z.object({
  bottlingBatchId: z.string().min(1),
  certifiedLaboratoryName: z.string().min(1),
  accreditedLabCertificationCode: z.string().min(1),
  analysisRequestDate: DateInputSchema.nullish(),
  testPerformedAt: DateInputSchema,
  actualAlcoholAbv: z.number().min(0).max(100),
  totalAlcoholAbv: z.number().min(0).max(100).nullish(),
  totalAcidityTartaricGl: z.number().min(0),
  volatileAcidityAceticGl: z.number().min(0),
  freeSulfurDioxideMgL: z.number().min(0).nullish(),
  totalSulfurDioxideMgL: z.number().min(0).nullish(),
  reducingSugarsGl: z.number().min(0).nullish(),
  totalDryExtractGl: z.number().min(0).nullish(),
  sugarFreeDryExtractGl: z.number().min(0).nullish(),
  overpressureBar: z.number().min(0).nullish(),
  methanolContentMgL: z.number().min(0).nullish(),
  copperContentMgL: z.number().min(0).nullish(),
  additionalParams: JsonObjectSchema.nullish(),
  laboratoryReportPdfUrl: z.string().min(1),
  conformsToSenasagStandards: z.boolean().nullish(),
  conformsToEuStandards: z.boolean().nullish(),
  conformsToUsaStandards: z.boolean().nullish(),
})
export type CreateBatchLabAnalysisDto = z.infer<typeof CreateBatchLabAnalysisSchema>
