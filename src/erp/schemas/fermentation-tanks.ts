import { z } from 'zod'
import { CorrectionMarksShape, DateInputSchema, IsoDateTimeSchema } from './common'
import { DestinationTypeSchema, TankStatusSchema, TreatmentTypeSchema } from './enums'
import { CreateLotSchema, TraceActorSchema } from './lots'

// /v1/fermentation-tanks · tanque, lecturas (logs) y tratamientos enológicos. Desde la Ola 2
// (contrato §4): entradas por pesaje (`inputs`), lote, volumen final y transiciones por acciones.

/** Kilos de un pesaje que entraron al tanque (`TankInputResponseDto`). */
export const TankInputSchema = z.object({ harvestBatchId: z.string(), kg: z.number() })
export type TankInput = z.infer<typeof TankInputSchema>

/** Destinos de la bifurcación en el MVP: vino o singani (§4.3). */
export const BIFURCATION_DESTINATIONS = ['WINE_AGING', 'SINGANI_DIST'] as const
export const BifurcationDestinationSchema = z.enum(BIFURCATION_DESTINATIONS)
export type BifurcationDestination = z.infer<typeof BifurcationDestinationSchema>

/** Un cambio de estado del tanque (`TankTransitionResponseDto`), empezando por el llenado. */
export const TankTransitionSchema = z.object({
  status: TankStatusSchema,
  at: IsoDateTimeSchema,
  /** Quién lo registró (`null` = no registrado). */
  by: TraceActorSchema.nullable(),
})
export type TankTransition = z.infer<typeof TankTransitionSchema>

export const FermentationTankResponseSchema = z.object({
  ...CorrectionMarksShape,
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
  /** Lote (Ola 2). */
  lotId: z.string().nullable(),
  /** Volumen al completar la fermentación (Ola 2). */
  finalVolumeLiters: z.number().nullable(),
  /** Pesajes que entraron al tanque, con sus kilos (lista y detalle). */
  inputs: z.array(TankInputSchema).optional(),
  /**
   * Litros que quedan por transferir: el volumen final (o el de llenado) menos lo que ya pasó a la
   * crianza o a las destilaciones; 0 con el tanque `TRANSFERRED` o `CLEANED` (lista y detalle).
   */
  availableLiters: z.number().nullable().optional(),
  /** Merma de trasiego: lo que quedó sin transferir al pasar a `TRANSFERRED`; `null` mientras no se ha transferido. */
  transferLossLiters: z.number().nullable().optional(),
  /** Historial de estados, empezando por el llenado (lista y detalle). */
  transitions: z.array(TankTransitionSchema).optional(),
})
export type FermentationTankResponse = z.infer<typeof FermentationTankResponseSchema>

export const CreateFermentationTankSchema = z
  .object({
    /** Lote del tanque (o `newLot`; si falta, el de las entradas). */
    lotId: z.string().min(1).optional(),
    /** Crea el lote desde el tanque y lo asigna a las entradas sin lote. */
    newLot: CreateLotSchema.optional(),
    /** Pesajes que entran al tanque (≥ 1), todos del mismo lote; `kg` por defecto = lo disponible. */
    inputs: z.array(z.object({ harvestBatchId: z.string().min(1), kg: z.number().positive().optional() })).min(1).optional(),
    /** @deprecated Legado hasta H2: equivale a `inputs: [{ harvestBatchId }]` (todo lo disponible). */
    harvestBatchId: z.string().min(1).optional(),
    /** Código físico del tanque; no se reutiliza hasta limpiarlo (S-7). */
    tankCode: z.string().min(1),
    capacityLiters: z.number().positive().optional(),
    material: z.string().optional(),
    /** Mosto cargado (≤ capacidad). Obligatorio desde H2. */
    volumeFilledLiters: z.number().min(0).optional(),
    /** Legado: predeclara la bifurcación; debe coincidir con el tipo del lote (y lo fija si no lo tiene). */
    destinationType: BifurcationDestinationSchema.optional(),
    /** `true`: el tanque nace en `FERMENTING`. */
    startFermentation: z.boolean().optional(),
    /** @deprecated Legado: estado inicial. `COMPLETED`, `TRANSFERRED` y `CLEANED` → 422. */
    status: z.enum(['FILLING', 'FERMENTING']).optional(),
    startDate: DateInputSchema,
  })
  .superRefine((b, ctx) => {
    if (!b.inputs && !b.harvestBatchId) {
      ctx.addIssue({ code: 'custom', message: 'Indica los pesajes que entran al tanque (inputs)', path: ['inputs'] })
    }
    if (b.lotId && b.newLot) ctx.addIssue({ code: 'custom', message: 'Indica lotId o newLot, no ambos', path: ['newLot'] })
  })
export type CreateFermentationTankDto = z.infer<typeof CreateFermentationTankSchema>

/** `POST /v1/fermentation-tanks/{id}/start`: `FILLING → FERMENTING`. */
export const StartFermentationTankSchema = z.object({ startedAt: DateInputSchema.optional() })
export type StartFermentationTankDto = z.infer<typeof StartFermentationTankSchema>

/** `POST /v1/fermentation-tanks/{id}/complete`: `FERMENTING → COMPLETED` con la bifurcación (§4.3). */
export const CompleteFermentationTankSchema = z.object({
  endDate: DateInputSchema,
  /** ≤ `volumeFilledLiters` del tanque. */
  finalVolumeLiters: z.number().min(0),
  destination: BifurcationDestinationSchema,
})
export type CompleteFermentationTankDto = z.infer<typeof CompleteFermentationTankSchema>

/** `POST /v1/fermentation-tanks/{id}/clean`: `TRANSFERRED → CLEANED`; libera el `tankCode`. */
export const CleanFermentationTankSchema = z.object({ cleanedAt: DateInputSchema.optional() })
export type CleanFermentationTankDto = z.infer<typeof CleanFermentationTankSchema>

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
  /** Persona que la registró (las lecturas dadas de alta por la API; las anteriores solo tienen el miembro). */
  recordedByUserId: z.string().optional(),
})
export type FermentationLogRecord = z.infer<typeof FermentationLogRecordSchema>

/**
 * Lectura de la API (`FermentationLogResponseDto`): respuesta de `POST …/:id/logs` y `logs` del
 * detalle de la cuba. El autor es la **persona** (`recordedByUserId`).
 */
export const FermentationLogSchema = z.object({
  ...CorrectionMarksShape,
  /** Anulada por una corrección `VOID` (§9). */
  voidedAt: IsoDateTimeSchema.nullable().optional(),
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
  /** Miembro que lo autorizó (los tratamientos dados de alta por la API). */
  authorizedByMemberId: z.string().optional(),
})
export type EnologicalTreatmentRecord = z.infer<typeof EnologicalTreatmentRecordSchema>

/**
 * Tratamiento de la API (`EnologicalTreatmentResponseDto`): respuesta de `POST …/:id/treatments`
 * y `treatments` del detalle de la cuba, con el miembro que lo autorizó.
 */
export const EnologicalTreatmentSchema = z.object({
  ...CorrectionMarksShape,
  /** Anulado por una corrección `VOID` (§9). */
  voidedAt: IsoDateTimeSchema.nullable().optional(),
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
