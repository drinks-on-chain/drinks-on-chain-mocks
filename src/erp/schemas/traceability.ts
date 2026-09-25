import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { ProductTypeSchema } from './enums'

// /v1/traceability · pasaporte público por código de lote y grafo DAG interno

export const PublicPassportSchema = z.object({
  lotCode: z.string(),
  winery: z.object({
    commercialName: z.string(),
    department: z.string(),
    altitudeMasl: z.number(),
  }),
  product: z.object({
    productType: ProductTypeSchema,
    alcoholAbv: z.number(),
    bottlesPackaged: z.number(),
    packagingFormatCl: z.number(),
    bottlingDate: IsoDateTimeSchema,
  }),
  terroir: z.object({
    parcelName: z.string(),
    altitudeMasl: z.number(),
    varietyName: z.string(),
    doEligible: z.boolean(),
    doType: z.string().nullish(),
  }),
  laboratoryCertification: z
    .object({
      certifiedLaboratoryName: z.string(),
      accreditedLabCertificationCode: z.string(),
      actualAlcoholAbv: z.number(),
      totalAcidityTartaricGl: z.number(),
      volatileAcidityAceticGl: z.number(),
      conformsToSenasagStandards: z.boolean(),
      reportPdfUrl: z.string(),
    })
    .nullable(),
  blockchainIntegrity: z.object({
    sha256Hash: z.string().nullish(),
    network: z.string(),
    status: z.enum(['VERIFIED_ON_CHAIN', 'PENDING_ANCHOR']),
  }),
})
export type PublicPassport = z.infer<typeof PublicPassportSchema>

/** `traceability-public.json`: pasaportes indexados por código de lote. */
export const PublicPassportMapSchema = z.record(z.string(), PublicPassportSchema)

export const DAG_NODE_TYPES = [
  'TERROIR',
  'HARVEST_BATCH',
  'FERMENTATION_TANK',
  'WINE_AGING',
  'PRODUCTION_BATCH',
  'BOTTLING_BATCH',
  'LAB_ANALYSIS',
] as const
export const DagNodeTypeSchema = z.enum(DAG_NODE_TYPES)
export type DagNodeType = z.infer<typeof DagNodeTypeSchema>

/**
 * Grafo de `GET /v1/traceability/dag/:bottlingBatchId`. El backend no documenta la forma
 * (OpenAPI sin esquema): esta es la propuesta de los mocks, pendiente de confirmar.
 */
export const TraceabilityDagSchema = z.looseObject({
  bottlingBatchId: z.string(),
  lotCode: z.string(),
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      type: DagNodeTypeSchema,
      label: z.string(),
      date: IsoDateTimeSchema.nullable(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
})
export type TraceabilityDag = z.infer<typeof TraceabilityDagSchema>
export type TraceabilityDagNode = TraceabilityDag['nodes'][number]
