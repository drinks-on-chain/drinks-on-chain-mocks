import { z } from 'zod'
import { PublicDossierAnchorSchema } from '../chain/schemas'
import { WineryRoleSchema } from '../erp/schemas/organizations'
import { LabConformityCheckSchema } from '../erp/schemas/lab-analyses'
import { CalendarDateSchema, DoStatusSchema, LotEventTypeSchema, LotProductTypeSchema, LotStageCodeSchema } from '../erp/schemas/lots'

// Dominio público (contrato de la Ola 2 §12 y §17.1): pasaportes de lote y de botella que muestra
// el visor `/b/{código}` del Marketplace (`PublicLotPassportDto`, `PublicBottlePassportDto`) y el
// borrador del catálogo de colecciones. Sin sesión; solo datos registrados (EA-05): lo que falta
// llega como `NOT_RECORDED` o `null` y el visor escribe «No registrado».

const Instant = z.iso.datetime({ offset: true })

/** Forma de un código de lote: `{prefijo}-{año}-{WINE|SINGANI}-{NNN}` (p. ej. `CVJ-2026-SINGANI-004`). */
export const LOT_CODE_PATTERN = /^[A-Z]{2,6}-\d{4}-(WINE|SINGANI)-\d{3,}$/

/** Estado de una etapa en el pasaporte: `NOT_RECORDED` = la etapa aplica pero no hay datos. */
export const RECORD_STATUSES = ['RECORDED', 'NOT_RECORDED', 'NOT_APPLICABLE', 'PENDING'] as const
export const RecordStatusSchema = z.enum(RECORD_STATUSES)
export type RecordStatus = z.infer<typeof RecordStatusSchema>

/** Evento público de la línea de tiempo: solo el rol de quien actuó, nunca su nombre (S-21). */
export const PublicTimelineEventSchema = z.object({
  type: LotEventTypeSchema,
  occurredAt: Instant,
  recordedAt: Instant,
  lateEntry: z.boolean(),
  summary: z.string(),
  /** `null` = sistema. */
  actorRole: WineryRoleSchema.nullable(),
  corrected: z.boolean(),
})
export type PublicTimelineEvent = z.infer<typeof PublicTimelineEventSchema>

/** Pasaporte público de un lote (`PublicLotPassportDto`). Solo existen los de lotes embotellados. */
export const PublicLotPassportSchema = z.object({
  kind: z.literal('LOT'),
  lotCode: z.string(),
  name: z.string(),
  productType: LotProductTypeSchema,
  vintage: z.number().int(),
  stage: z.enum(['BOTTLED', 'CERTIFIED', 'ANCHORED', 'DISCARDED']),
  winery: z.object({
    slug: z.string(),
    tradeName: z.string(),
    region: z.string(),
    logoUrl: z.string().nullable(),
    website: z.string().nullable(),
    /** `false` si la bodega está suspendida o revocada; el pasaporte sigue visible (S-23). */
    active: z.boolean(),
  }),
  denomination: z.object({
    /** `false` en vino. */
    applies: z.boolean(),
    status: DoStatusSchema,
    rules: z.object({ minAltitudeMasl: z.number(), requiredVarieties: z.array(z.string()) }).nullable(),
    /** Cumple por un valor bajo el mínimo legal autorizado (A-31). */
    legalException: z.boolean(),
  }),
  origin: z.object({
    status: RecordStatusSchema,
    terroirs: z.array(z.object({ parcelName: z.string(), region: z.string(), altitudeMasl: z.number(), variety: z.string(), doStatus: DoStatusSchema })),
  }),
  harvest: z.object({
    status: RecordStatusSchema,
    firstIntakeDate: CalendarDateSchema.nullable(),
    lastIntakeDate: CalendarDateSchema.nullable(),
    phytosanitary: z.enum(['APPROVED', 'NOT_RECORDED']),
    maturity: z.object({ brixDegrees: z.number(), ph: z.number(), acidityGl: z.number() }).nullable(),
  }),
  fermentation: z.object({
    status: RecordStatusSchema,
    /** Instantes ISO 8601 (no fechas de calendario): cuándo se llenó el primer tanque y cuándo terminó el último. */
    startDate: Instant.nullable(),
    endDate: Instant.nullable(),
    readingsCount: z.number().int().min(0),
    /** Sin dosis (S-22). */
    treatments: z.array(z.object({ type: z.string(), additive: z.string(), regulatoryAuthCode: z.string(), appliedAt: Instant })),
  }),
  aging: z.object({
    status: RecordStatusSchema,
    containerType: z.string().nullable(),
    containerMaterial: z.string().nullable(),
    plannedMonths: z.number().int().nullable(),
    startDate: CalendarDateSchema.nullable(),
    unlockDate: CalendarDateSchema.nullable(),
  }),
  distillation: z.object({
    status: RecordStatusSchema,
    startDate: CalendarDateSchema.nullable(),
    endDate: CalendarDateSchema.nullable(),
    heartAbvPercent: z.number().nullable(),
    restMinDays: z.number().int().nullable(),
    restUntil: CalendarDateSchema.nullable(),
  }),
  bottling: z.object({
    status: RecordStatusSchema,
    date: CalendarDateSchema.nullable(),
    bottles: z.number().int().nullable(),
    formatCl: z.number().int().nullable(),
    finalAbv: z.number().nullable(),
  }),
  lab: z.object({
    status: z.enum(['CONFORMING', 'NON_CONFORMING', 'INCOMPLETE', 'NOT_RECORDED']),
    laboratoryName: z.string().nullable(),
    testedAt: CalendarDateSchema.nullable(),
    checks: z.array(LabConformityCheckSchema),
  }),
  /** Reglas con las que se hizo el lote (instantánea). `origin: 'MIGRATION'` = «reglas fijadas al migrar». */
  rules: z.object({
    takenAt: Instant,
    origin: z.enum(['LOT_CREATION', 'MIGRATION']),
    items: z.array(z.object({ key: z.string(), label: z.string(), value: z.unknown().nullable(), unit: z.string().nullable(), legalException: z.boolean() })),
  }),
  /** Solo eventos `PUBLIC`, sin pesos ni volúmenes intermedios (S-22). */
  timeline: z.array(PublicTimelineEventSchema),
  /** Se publica cuántas correcciones hubo y cuándo, no su detalle. */
  corrections: z.object({ count: z.number().int().min(0), lastAt: Instant.nullable() }),
  dossier: z.object({
    status: z.enum(['OPEN', 'CLOSED']),
    hash: z.string().nullable(),
    closedAt: Instant.nullable(),
    /**
     * `/v1/public/lots/{lotCode}/dossier` (bytes canónicos, para recalcular la huella). Puede ser
     * absoluta o una ruta relativa de la API (`/v1/public/…`) que la app resuelve contra su proxy.
     */
    canonicalUrl: z.string().nullable(),
    /** Anclaje en la red (Ola 3 §7.3): `null` hasta que exista la transacción; `FAILED` se publica como `PENDING`. */
    anchor: PublicDossierAnchorSchema.nullable(),
  }),
  /** `url`: `/v1/public/lots/{lotCode}/attachments/{id}` (redirige a una URL firmada); absoluta o relativa, como `canonicalUrl`. */
  publicAttachments: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string(), url: z.string() })),
  generatedAt: Instant,
})
export type PublicLotPassport = z.infer<typeof PublicLotPassportSchema>

/** Pasaporte público de una botella (`PublicBottlePassportDto`). */
export const PublicBottlePassportSchema = z.object({
  kind: z.literal('BOTTLE'),
  bottle: z.object({
    code: z.string(),
    /** `XXXX-XXXX`. */
    codeFormatted: z.string(),
    serial: z.number().int().min(1),
    lotTotal: z.number().int().min(1),
    /** `VOIDED`: el visor avisa «código anulado». */
    status: z.enum(['ACTIVE', 'VOIDED']),
    /**
     * Prueba frente a la raíz Merkle del expediente (`bottleCodes.merkleRoot` de sus bytes
     * canónicos): `null` hasta cerrarlo y para un código anulado antes del cierre. Se comprueba con
     * `verifyMerkleProof(merkleLeaf({ serial, code, salt }), path, raíz)`.
     */
    merkleProof: z.object({ salt: z.string(), path: z.array(z.object({ side: z.enum(['L', 'R']), hash: z.string() })) }).nullable(),
  }),
  lot: PublicLotPassportSchema,
  /** Siempre `null` en esta ola (canje: Ola 5, PUB-04). */
  redemption: z.null(),
})
export type PublicBottlePassport = z.infer<typeof PublicBottlePassportSchema>

/** `GET /v1/public/passports/{code}`: pasaporte de botella o de lote, discriminado por `kind`. */
export const PublicCodePassportSchema = z.discriminatedUnion('kind', [PublicBottlePassportSchema, PublicLotPassportSchema])
export type PublicCodePassport = z.infer<typeof PublicCodePassportSchema>

// ---------------------------------------------------------------------------
// Borrador del catálogo (contrato §17.1). NO está en el OpenAPI del backend: lo fija el OpenAPI
// borrador de la Etapa 4 (O3-PK-1) y puede cambiar. Solo para los mocks de la pantalla 2A.
// ---------------------------------------------------------------------------

/** Orden de `GET /v1/public/collections?sort=` (por defecto, `featured`: destacadas primero y después las más recientes). */
export const COLLECTION_SORTS = ['featured', 'newest', 'price-asc', 'price-desc', 'name'] as const
export type PublicCollectionSort = (typeof COLLECTION_SORTS)[number]

export const COLLECTION_STATUSES = ['PRESALE', 'ON_SALE', 'SOLD_OUT'] as const
export const PublicCollectionStatusSchema = z.enum(COLLECTION_STATUSES)
export type PublicCollectionStatus = z.infer<typeof PublicCollectionStatusSchema>

/** @experimental Borrador (§17.1): fila del catálogo sin cuenta. */
export const PublicCollectionSummarySchema = z.object({
  /** Id de la colección (el que recibe `POST /v1/orders` del borrador de la Etapa 4; mocks 0.6). */
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  productType: LotProductTypeSchema,
  vintage: z.number().int(),
  winery: z.object({ slug: z.string(), tradeName: z.string(), region: z.string() }),
  lotStage: LotStageCodeSchema,
  estimatedReadyDate: CalendarDateSchema.nullable(),
  /** Puede faltar (A-32). Importe en céntimos de boliviano. */
  price: z.object({ amountMinor: z.number().int(), currency: z.literal('BOB') }).nullable(),
  availability: z.object({ total: z.number().int().min(0), available: z.number().int().min(0) }),
  status: PublicCollectionStatusSchema,
  /** Igual que `status` (nombre del contrato de la Ola 3 §13.1; `status` se retirará con el OpenAPI de la Etapa 4). */
  saleState: PublicCollectionStatusSchema,
  /** Botellas que aún se pueden comprar (contrato de la Ola 3 §13.1). */
  counts: z.object({ available: z.number().int().min(0) }),
  /** Destacada en la portada del catálogo (el orden por defecto las pone primero). */
  featured: z.boolean(),
  /** Puede faltar. En los mocks, `/mocks/uploads/collections/{slug}.jpg`, que sirven los handlers. */
  imageUrl: z.string().nullable(),
})
export type PublicCollectionSummary = z.infer<typeof PublicCollectionSummarySchema>

/** @experimental Borrador (§17.1): ficha de una colección. */
export const PublicCollectionSchema = PublicCollectionSummarySchema.extend({
  description: z.string(),
  tastingNotes: z.string(),
  pairing: z.string(),
  gallery: z.array(z.string()),
  lot: z.object({ lotCode: z.string().nullable(), timeline: z.array(PublicTimelineEventSchema) }),
})
export type PublicCollection = z.infer<typeof PublicCollectionSchema>
