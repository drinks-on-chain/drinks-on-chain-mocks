import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { ProductTypeSchema } from './enums'

// /v1/traceability · grafo DAG del lote (`DagGraphResponseDto`), el mismo en la ruta interna
// (`GET /v1/traceability/dag/:bottlingBatchId`) y en el pasaporte público por código de lote
// (`GET /v1/traceability/public/:lotCode`). Forma y cálculo de `DagBuilderService` del backend:
// un nodo por etapa (parcela → vendimia → vinificación → crianza | destilación → embotellado),
// identificado por un hash SHA-256 (`0x…`) de `<ETAPA>-<id>`, con métricas escaladas ×100 para el
// contrato y el laboratorio en `details.labAnalysis` del embotellado.

export const DAG_STAGE_NAMES = ['Plot', 'Harvest', 'Vinification', 'Aging', 'Distillation', 'Bottling'] as const
export const DagStageNameSchema = z.enum(DAG_STAGE_NAMES)
export type DagStageName = z.infer<typeof DagStageNameSchema>

/** `DagOperatorDto`: rol genérico de quien actuó en la etapa y nombre comercial de la bodega. */
export const DagOperatorSchema = z.object({
  name: z.string(),
  role: z.string(),
  wineryName: z.string(),
})
export type DagOperator = z.infer<typeof DagOperatorSchema>

/** Laboratorio en `details.labAnalysis` del nodo de embotellado (`null` sin análisis). */
export const DagLabAnalysisSchema = z.object({
  certifiedLaboratoryName: z.string(),
  accreditedLabCertificationCode: z.string(),
  actualAlcoholAbv: z.number(),
  methanolContentMgL: z.number(),
  conformsToSenasagStandards: z.boolean(),
})
export type DagLabAnalysis = z.infer<typeof DagLabAnalysisSchema>

/** `DagNodeDto`. `details` depende de la etapa (números como números JSON). */
export const DagNodeSchema = z.object({
  batchId: z.string(),
  /** 0 parcela, 1 vendimia, 2 vinificación, 3 crianza, 4 destilación, 5 embotellado. */
  stage: z.number().int().min(0).max(5),
  stageName: DagStageNameSchema,
  /** `batchId` de los padres. */
  parents: z.array(z.string()),
  timestamp: IsoDateTimeSchema,
  /** Hectáreas, kg, litros o botellas según la etapa. */
  volumeOrUnits: z.number(),
  /** Métricas escaladas ×100 (enteros) para el contrato. */
  metrics: z.array(z.number()),
  metadataHash: z.string(),
  isCertified: z.boolean(),
  operator: DagOperatorSchema,
  details: z.record(z.string(), z.unknown()),
})
export type DagNode = z.infer<typeof DagNodeSchema>

/** `DagGraphResponseDto`: `rootBatchId` es el `batchId` del embotellado. */
export const DagGraphSchema = z.object({
  rootBatchId: z.string(),
  internationalLotCode: z.string(),
  productType: ProductTypeSchema,
  nodes: z.array(DagNodeSchema),
})
export type DagGraph = z.infer<typeof DagGraphSchema>

/** `traceability-public.json`: grafo de cada lote, por código de lote. */
export const DagGraphMapSchema = z.record(z.string(), DagGraphSchema)

/** @deprecated Desde 0.4: el pasaporte público es el grafo DAG del backend (`DagGraphSchema`). */
export const PublicPassportSchema = DagGraphSchema
/** @deprecated Desde 0.4: `DagGraph`. */
export type PublicPassport = DagGraph
/** @deprecated Desde 0.4: `DagGraphMapSchema`. */
export const PublicPassportMapSchema = DagGraphMapSchema
/** @deprecated Desde 0.4: el grafo interno es el del backend (`DagGraphSchema`). */
export const TraceabilityDagSchema = DagGraphSchema
/** @deprecated Desde 0.4: `DagGraph`. */
export type TraceabilityDag = DagGraph
