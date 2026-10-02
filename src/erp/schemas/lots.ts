import { z } from 'zod'
import { ApiErrorDetailSchema } from '../../shared/envelope'

// Lote del servidor (contrato de la Ola 2 §2 y §11.1; `LotDto`, `LotSummaryDto`, `LotEventDto` del
// OpenAPI). El lote agrupa la cadena pesajes → tanques → crianzas | destilaciones → embotellado →
// laboratorio. Sustituyó a la vista derivada `LotView` de 0.1–0.4, retirada en el cierre H2 (§16.3).
//
// Nombres: `LotStageCode`, `LotLockInfo` y `LOT_STAGE_CODES` (los de `LotView` eran `LotStage`,
// `LotLock` y `LOT_STAGES`, que ya no existen).

/** Etapas del lote. Las calcula el servidor; ninguna ruta las fija salvo el descarte (§2.2). */
export const LOT_STAGE_CODES = [
  'ORIGIN',
  'HARVEST',
  'FERMENTING',
  'AGING',
  'DISTILLING',
  'RESTING',
  'BOTTLED',
  'CERTIFIED',
  'ANCHORED',
  'REJECTED',
  'DISCARDED',
] as const
export const LotStageCodeSchema = z.enum(LOT_STAGE_CODES)
export type LotStageCode = z.infer<typeof LotStageCodeSchema>

/** Etapas terminales en esta ola: toda escritura → 409 `TRC_LOT_TERMINAL`. */
export const TERMINAL_LOT_STAGES: readonly LotStageCode[] = ['REJECTED', 'DISCARDED', 'CERTIFIED', 'ANCHORED']

/** El lote del MVP solo es vino o singani (S-1). */
export const LOT_PRODUCT_TYPES = ['WINE', 'SINGANI'] as const
export const LotProductTypeSchema = z.enum(LOT_PRODUCT_TYPES)
export type LotProductType = z.infer<typeof LotProductTypeSchema>

/** Fecha de calendario `YYYY-MM-DD` (America/La_Paz). */
export const CalendarDateSchema = z.iso.date()

/** Instante ISO 8601 (los mocks responden sin milisegundos; el backend, con ellos). */
const Instant = z.iso.datetime({ offset: true })

/** Detalle de error ampliado (`ErrorDetailDto`): también describe incidencias y avisos. */
export const ErrorDetailSchema = ApiErrorDetailSchema
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>

/** Quién hizo algo en la trazabilidad: la membresía de la bodega (`TraceActorDto`). */
export const TraceActorSchema = z.object({
  membershipId: z.string(),
  userId: z.string(),
  fullName: z.string(),
  /** Rol en la bodega (`OWNER`, `ENOLOGIST`…). */
  role: z.string(),
})
export type TraceActor = z.infer<typeof TraceActorSchema>

export const LotLockRuleSchema = z.object({
  /** Clave del parámetro de la instantánea, p. ej. `trazabilidad.singani.reposoMinimoDias`. */
  settingKey: z.string(),
  minimum: z.number(),
  applied: z.number(),
  unit: z.enum(['meses', 'días']),
  legalException: z.boolean(),
})

/** Candado de una fuente del lote (`LotLockDto`): crianza del vino o reposo del singani. */
export const LotLockInfoSchema = z.object({
  kind: z.enum(['AGING', 'REST']),
  /** `wineAgingBatchId` o `productionBatchId`. */
  sourceId: z.string(),
  unlockDate: CalendarDateSchema,
  released: z.boolean(),
  daysRemaining: z.number().int().min(0),
  rule: LotLockRuleSchema,
})
export type LotLockInfo = z.infer<typeof LotLockInfoSchema>

export const DO_STATUSES = ['ELIGIBLE', 'ELIGIBLE_BY_EXCEPTION', 'NOT_ELIGIBLE', 'NOT_APPLICABLE'] as const
export const DoStatusSchema = z.enum(DO_STATUSES)
export type DoStatus = z.infer<typeof DoStatusSchema>

const DoValueSchema = z.union([z.number(), z.string(), z.array(z.string())])

export const DoCheckSchema = z.object({
  rule: z.enum(['ALTITUDE', 'VARIETY']),
  settingKey: z.string(),
  required: DoValueSchema,
  legalMinimum: DoValueSchema,
  actual: DoValueSchema,
  pass: z.boolean(),
  terroirId: z.string(),
})
export type DoCheck = z.infer<typeof DoCheckSchema>

/** Aptitud D.O. Singani calculada por el servidor (`DoEvaluationDto`, EA-03). */
export const DoEvaluationSchema = z.object({
  status: DoStatusSchema,
  checks: z.array(DoCheckSchema),
  /** `LOT_SNAPSHOT`: instantánea del lote; `EFFECTIVE_SETTINGS`: valores vigentes de la bodega (parcelas). */
  rulesSource: z.enum(['LOT_SNAPSHOT', 'EFFECTIVE_SETTINGS']),
  evaluatedAt: Instant,
})
export type DoEvaluation = z.infer<typeof DoEvaluationSchema>

/** Incidencia de cumplimiento del lote (`ComplianceIssueDto`): una abierta bloquea embotellar y cerrar. */
export const ComplianceIssueSchema = z.object({
  id: z.string(),
  code: z.string(),
  message: z.string(),
  source: z.enum(['MIGRATION', 'CORRECTION', 'RULES_REEVALUATION']),
  details: z.array(ErrorDetailSchema),
  detectedAt: Instant,
  resolvedAt: Instant.nullable(),
})
export type ComplianceIssue = z.infer<typeof ComplianceIssueSchema>

export const LabLimitSchema = z.object({
  max: z.number().optional(),
  min: z.number().optional(),
  unidad: z.string(),
})
export type LabLimit = z.infer<typeof LabLimitSchema>

/** Instantánea de reglas del lote (`LotRulesDto`, CFG-06): no se edita nunca. */
export const LotRulesSchema = z.object({
  takenAt: Instant,
  /** `MIGRATION`: lote anterior a la Ola 2 (reglas fijadas al migrar). */
  origin: z.enum(['LOT_CREATION', 'MIGRATION']),
  singani: z.object({ minAltitudeMasl: z.number(), requiredVarieties: z.array(z.string()), minRestDays: z.number() }),
  wine: z.object({ minAgingMonths: z.number() }),
  phytosanitary: z.object({ requireApproved: z.boolean() }),
  bottling: z.object({ maxLossPercent: z.number() }),
  lab: z.object({ limits: z.record(z.string(), LabLimitSchema) }),
  /** Claves con un valor bajo el mínimo legal autorizado (A-31). */
  legalExceptions: z.array(z.string()),
  sources: z.record(z.string(), z.enum(['GLOBAL', 'WINERY'])),
  /** Copia literal de la instantánea. */
  values: z.record(z.string(), z.unknown()),
})
export type LotRules = z.infer<typeof LotRulesSchema>

export const LAB_STATUSES = ['NOT_RECORDED', 'CONFORMING', 'NON_CONFORMING', 'INCOMPLETE'] as const
export const LotLabStatusSchema = z.enum(LAB_STATUSES)
export type LotLabStatus = z.infer<typeof LotLabStatusSchema>

/** Fila de la lista de lotes (`LotSummaryDto`). */
export const LotSummarySchema = z.object({
  id: z.string(),
  wineryId: z.string(),
  /** Referencia interna desde la creación: `{lotPrefix}-L{año}-{NNN}`. */
  reference: z.string(),
  /** Código de lote de la etiqueta (al embotellar): `{lotPrefix}-{año}-{WINE|SINGANI}-{NNN}`. */
  lotCode: z.string().nullable(),
  name: z.string(),
  productType: LotProductTypeSchema.nullable(),
  stage: LotStageCodeSchema,
  stageChangedAt: Instant,
  /** `FERMENTING` con tanques completados sin destino decidido. */
  awaitingBifurcation: z.boolean(),
  harvestYear: z.number().int(),
  /** Declarada por la bodega (base de la cuota de la Ola 3). */
  estimatedBottles: z.number().int().nullable(),
  /** Calculada por el servidor (§11.3). */
  projectedBottles: z.number().int().nullable(),
  /** Botellas embotelladas con código activo. */
  bottles: z.number().int().nullable(),
  nextLock: LotLockInfoSchema.nullable(),
  phyto: z.object({
    pending: z.number().int().min(0),
    quarantine: z.number().int().min(0),
    approved: z.number().int().min(0),
    rejected: z.number().int().min(0),
  }),
  labStatus: LotLabStatusSchema,
  dossierStatus: z.enum(['OPEN', 'CLOSED']),
  complianceIssuesOpen: z.number().int().min(0),
  createdAt: Instant,
  updatedAt: Instant,
})
export type LotSummary = z.infer<typeof LotSummarySchema>

/** Detalle del lote (`LotDto`). */
export const LotSchema = LotSummarySchema.extend({
  plannedTerroirIds: z.array(z.string()),
  plannedFormatCl: z.number().nullable(),
  targetAbvPercent: z.number().nullable(),
  targetReadyDate: CalendarDateSchema.nullable(),
  estimatedReadyDate: CalendarDateSchema.nullable(),
  /** `LOCK` = candado calculado; `DECLARED` = `targetReadyDate`. */
  estimatedReadyBasis: z.enum(['LOCK', 'DECLARED']).nullable(),
  estimatedBottlesHistory: z.array(
    z.object({ value: z.number(), at: Instant, by: TraceActorSchema.nullable(), reason: z.string().nullable() }),
  ),
  locks: z.array(LotLockInfoSchema),
  rules: LotRulesSchema,
  /** `NOT_APPLICABLE` en vino o sin parcelas que evaluar. */
  denomination: DoEvaluationSchema,
  complianceIssues: z.array(ComplianceIssueSchema),
  links: z.object({
    harvestBatchIds: z.array(z.string()),
    tankIds: z.array(z.string()),
    wineAgingBatchIds: z.array(z.string()),
    productionBatchIds: z.array(z.string()),
    bottlingBatchId: z.string().nullable(),
    labAnalysisIds: z.array(z.string()),
  }),
  discarded: z.object({ at: Instant, by: TraceActorSchema.nullable(), reason: z.string() }).nullable(),
  notes: z.string().nullable(),
  /** `null` en los lotes creados por el sistema (migración). */
  createdBy: TraceActorSchema.nullable(),
})
export type Lot = z.infer<typeof LotSchema>

/** `CreateLotDto`: en origen (`POST /v1/lots`), desde la vendimia o desde el tanque (`newLot`). */
export const CreateLotSchema = z.object({
  name: z.string().trim().min(3).max(120),
  harvestYear: z.number().int().min(2000),
  /** Cualquier otro valor → 422 `TRC_PRODUCT_NOT_SUPPORTED` (lo decide el handler). */
  productType: z.string().optional(),
  estimatedBottles: z.number().int().min(1).max(100_000).optional(),
  plannedFormatCl: z.number().min(5).max(300).optional(),
  targetAbvPercent: z.number().min(1).max(80).optional(),
  plannedTerroirIds: z.array(z.string()).optional(),
  targetReadyDate: CalendarDateSchema.optional(),
  notes: z.string().max(2000).optional(),
})
export type CreateLotDto = Omit<z.infer<typeof CreateLotSchema>, 'productType'> & { productType?: LotProductType }

/** `UpdateLotDto`: `reason` es obligatorio si cambia `estimatedBottles` (queda en su historial). */
export const UpdateLotSchema = z.object({
  name: z.string().trim().min(3).max(120).optional(),
  estimatedBottles: z.number().int().min(1).max(100_000).optional(),
  plannedFormatCl: z.number().min(5).max(300).optional(),
  targetAbvPercent: z.number().min(1).max(80).optional(),
  targetReadyDate: CalendarDateSchema.optional(),
  notes: z.string().max(2000).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
})
export type UpdateLotDto = z.infer<typeof UpdateLotSchema>

/** Motivo de un descarte (lote, crianza o destilación). */
export const DiscardLotSchema = z.object({ reason: z.string().trim().min(3).max(500) })
export type DiscardLotDto = z.infer<typeof DiscardLotSchema>

// ---------------------------------------------------------------------------
// Línea de tiempo (§11.1)
// ---------------------------------------------------------------------------

export const LOT_EVENT_TYPES = [
  'LOT_CREATED',
  'ESTIMATE_CHANGED',
  'HARVEST_WEIGHED',
  'MATURITY_ANALYZED',
  'PHYTO_DECIDED',
  'TANK_FILLED',
  'FERMENTATION_STARTED',
  'FERMENTATION_READINGS',
  'TREATMENT_APPLIED',
  'FERMENTATION_COMPLETED',
  'PRODUCT_DECIDED',
  'AGING_STARTED',
  'DISTILLATION_STARTED',
  'DISTILLATION_CLOSED',
  'LOCK_RELEASED',
  'BOTTLED',
  'BOTTLE_CODES_GENERATED',
  'BOTTLE_CODE_VOIDED',
  'LAB_REGISTERED',
  'CORRECTION',
  'FILE_ATTACHED',
  'DOSSIER_CLOSED',
  'LOT_REJECTED',
  'LOT_DISCARDED',
] as const
export const LotEventTypeSchema = z.enum(LOT_EVENT_TYPES)
export type LotEventType = z.infer<typeof LotEventTypeSchema>

/** Eventos que muestra el pasaporte público (§12); el resto son `INTERNAL`. */
export const PUBLIC_LOT_EVENT_TYPES: readonly LotEventType[] = [
  'HARVEST_WEIGHED',
  'PHYTO_DECIDED',
  'TANK_FILLED',
  'FERMENTATION_STARTED',
  'FERMENTATION_COMPLETED',
  'PRODUCT_DECIDED',
  'AGING_STARTED',
  'DISTILLATION_STARTED',
  'DISTILLATION_CLOSED',
  'LOCK_RELEASED',
  'BOTTLED',
  'LAB_REGISTERED',
  'DOSSIER_CLOSED',
  'LOT_DISCARDED',
]

/** Evento de la línea de tiempo del lote (`LotEventDto`). */
export const LotEventSchema = z.object({
  id: z.string(),
  seq: z.number().int().min(1),
  type: LotEventTypeSchema,
  /** Fecha del hecho (declarada). */
  occurredAt: Instant,
  recordedAt: Instant,
  /** Registrado más de 7 días después del hecho (S-9). */
  lateEntry: z.boolean(),
  /** Etapa del lote tras el evento. */
  stage: LotStageCodeSchema,
  /** `null` = sistema (tarea diaria, migración). */
  actor: TraceActorSchema.nullable(),
  /** Texto listo para mostrar ("Pesaje de 18.400 kg desde Parcela 2 · Cañón Viejo"). */
  summary: z.string(),
  /** Cifras del evento con su unidad. */
  data: z.record(z.string(), z.unknown()),
  resource: z.object({ type: z.string(), id: z.string() }),
  visibility: z.enum(['PUBLIC', 'INTERNAL']),
  corrected: z.boolean(),
})
export type LotEvent = z.infer<typeof LotEventSchema>

/** Fila de `lot-events.json`: el evento con su lote. */
export const StoredLotEventSchema = LotEventSchema.extend({ lotId: z.string() })
export type StoredLotEvent = z.infer<typeof StoredLotEventSchema>

/** `GET /v1/lots/{id}/timeline` (`LotTimelineDto`). */
export const LotTimelineSchema = z.object({
  events: z.array(LotEventSchema),
  locks: z.array(LotLockInfoSchema),
  estimatedReadyDate: CalendarDateSchema.nullable(),
  estimatedReadyBasis: z.enum(['LOCK', 'DECLARED']).nullable(),
})
export type LotTimeline = z.infer<typeof LotTimelineSchema>
