import { z } from 'zod'
import { DateInputSchema, IsoDateTimeSchema } from './common'
import { DestinationTypeSchema, TankStatusSchema, TreatmentTypeSchema } from './enums'

// /v1/fermentation-tanks · tanque, lecturas (logs) y tratamientos enológicos

export const FermentationTankResponseSchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  harvestBatchId: z.string(),
  tankCode: z.string(),
  capacityLiters: z.number().nullish(),
  material: z.string().nullish(),
  volumeFilledLiters: z.number().nullish(),
  destinationType: DestinationTypeSchema.nullish(),
  status: TankStatusSchema,
  startDate: IsoDateTimeSchema,
  endDate: IsoDateTimeSchema.nullish(),
  createdAt: IsoDateTimeSchema,
})
export type FermentationTankResponse = z.infer<typeof FermentationTankResponseSchema>

export const CreateFermentationTankSchema = z.object({
  harvestBatchId: z.string().min(1),
  tankCode: z.string().min(1),
  capacityLiters: z.number().positive().optional(),
  material: z.string().optional(),
  volumeFilledLiters: z.number().min(0).optional(),
  destinationType: DestinationTypeSchema.optional(),
  status: TankStatusSchema.optional(),
  startDate: DateInputSchema,
})
export type CreateFermentationTankDto = z.infer<typeof CreateFermentationTankSchema>

export const CreateFermentationLogSchema = z.object({
  temperatureCelsius: z.number(),
  specificGravity: z.number().optional(),
  phValue: z.number().min(0).max(14).optional(),
  co2Observations: z.string().optional(),
  recordedAt: DateInputSchema,
  notes: z.string().optional(),
})
export type CreateFermentationLogDto = z.infer<typeof CreateFermentationLogSchema>

/**
 * Lectura guardada tal como está en `fermentation-logs.json` (fila de la semilla, compartida con
 * la semilla del backend): el autor es el **miembro** (`recordedByMemberId`).
 */
export const FermentationLogRecordSchema = z.object({
  id: z.string(),
  fermentationTankId: z.string(),
  temperatureCelsius: z.number(),
  specificGravity: z.number().nullish(),
  phValue: z.number().nullish(),
  co2Observations: z.string().nullish(),
  recordedAt: IsoDateTimeSchema,
  notes: z.string().nullish(),
  recordedByMemberId: z.string().nullish(),
})
export type FermentationLogRecord = z.infer<typeof FermentationLogRecordSchema>

/**
 * Lectura de la API (`FermentationLogResponseDto`): respuesta de `POST …/:id/logs` y `logs` del
 * detalle de la cuba. El autor es la **persona** (`recordedByUserId`).
 */
export const FermentationLogSchema = z.object({
  id: z.string(),
  fermentationTankId: z.string(),
  temperatureCelsius: z.number(),
  specificGravity: z.number().nullable(),
  phValue: z.number().nullable(),
  co2Observations: z.string().nullable(),
  recordedAt: IsoDateTimeSchema,
  recordedByUserId: z.string(),
  notes: z.string().nullable(),
})
export type FermentationLog = z.infer<typeof FermentationLogSchema>

export const CreateEnologicalTreatmentSchema = z.object({
  treatmentType: TreatmentTypeSchema,
  additiveName: z.string().min(1),
  additiveSupplier: z.string().optional(),
  dosageAppliedGPerHl: z.number().min(0),
  totalAppliedG: z.number().min(0).optional(),
  regulatoryAuthCode: z.string().min(1),
  appliedAt: DateInputSchema,
  notes: z.string().optional(),
})
export type CreateEnologicalTreatmentDto = z.infer<typeof CreateEnologicalTreatmentSchema>

/**
 * Tratamiento tal como está en `enological-treatments.json` (fila de la semilla): sin autor
 * (la semilla del backend lo asigna al enólogo activo o, si no hay, al dueño).
 */
export const EnologicalTreatmentRecordSchema = z.object({
  id: z.string(),
  fermentationTankId: z.string(),
  treatmentType: TreatmentTypeSchema,
  additiveName: z.string(),
  additiveSupplier: z.string().nullish(),
  dosageAppliedGPerHl: z.number(),
  totalAppliedG: z.number().nullish(),
  regulatoryAuthCode: z.string(),
  appliedAt: IsoDateTimeSchema,
  notes: z.string().nullish(),
})
export type EnologicalTreatmentRecord = z.infer<typeof EnologicalTreatmentRecordSchema>

/**
 * Tratamiento de la API (`EnologicalTreatmentResponseDto`): respuesta de `POST …/:id/treatments`
 * y `treatments` del detalle de la cuba, con el miembro que lo autorizó.
 */
export const EnologicalTreatmentSchema = z.object({
  id: z.string(),
  fermentationTankId: z.string(),
  treatmentType: TreatmentTypeSchema,
  additiveName: z.string(),
  additiveSupplier: z.string().nullable(),
  dosageAppliedGPerHl: z.number(),
  totalAppliedG: z.number().nullable(),
  regulatoryAuthCode: z.string(),
  appliedAt: IsoDateTimeSchema,
  authorizedByMemberId: z.string(),
  notes: z.string().nullable(),
})
export type EnologicalTreatment = z.infer<typeof EnologicalTreatmentSchema>
