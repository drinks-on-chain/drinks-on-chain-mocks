import { z } from 'zod'
import { CalendarDateSchema } from './lots'

// Contenido canónico del expediente del lote, `doc-dossier/1` (contrato de la Ola 2 §10 y §20;
// `domain/dossier.ts` del backend): lo que devuelven `GET /v1/lots/{id}/dossier/canonical` y
// `GET /v1/public/lots/{lotCode}/dossier`, sin envoltorio. Su SHA-256 (sobre los bytes UTF-8 del
// JSON canónico RFC 8785) es la huella del lote.
//
// - Medidas (kilos, litros, grados, pH…): **cadenas de escala fija** con la escala de su columna
//   (`"18400.000"`). Los enteros (botellas, cL, meses, añada) son números.
// - Instantes en ISO 8601 UTC con milisegundos; fechas de calendario `YYYY-MM-DD`.
// - Personas como `{ membershipId, role }`: sin nombres ni correos. Sin textos libres (notas,
//   motivos), sin URL ni claves de archivos y sin los códigos de botella (va su raíz Merkle).
// - Los registros anulados por una corrección siguen, marcados con `voidedAt`.
// - Las propiedades sin dato van con `null` (nunca se omiten).

/** Decimal como cadena de escala fija (`"1500.000"`). */
const Fixed = z.string().regex(/^-?\d+\.\d+$/)
const NullableFixed = Fixed.nullable()
const Instant = z.iso.datetime({ offset: true })
const NullableInstant = Instant.nullable()

/** Persona del expediente: membresía y rol, sin nombre. */
export const DossierActorSchema = z.object({ membershipId: z.string(), role: z.string().nullable() })
const Actor = DossierActorSchema.nullable()

const Balance = z.object({
  availableLiters: Fixed,
  waterDilutionLiters: Fixed,
  bottledLiters: Fixed,
  leftoverLiters: Fixed,
  lossLiters: Fixed,
  lossPercent: Fixed,
  pureAlcohol: z.object({ availableLiters: Fixed, bottledLiters: Fixed }).nullable(),
})

export const CanonicalDossierSchema = z.object({
  schema: z.literal('doc-dossier/1'),
  /** `null` en la vista previa (expediente abierto). */
  closedAt: NullableInstant,
  closedBy: Actor,
  winery: z.object({ id: z.string(), lotPrefix: z.string().nullable(), tradeName: z.string() }),
  lot: z.object({
    id: z.string(),
    reference: z.string(),
    lotCode: z.string().nullable(),
    name: z.string(),
    productType: z.string().nullable(),
    harvestYear: z.number().int(),
    createdAt: Instant,
    createdBy: Actor,
    bottledAt: CalendarDateSchema.nullable(),
  }),
  /** Instantánea de reglas del lote (`LotRules`), tal como se guardó. */
  rules: z.record(z.string(), z.unknown()),
  harvests: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      intakeDate: CalendarDateSchema,
      harvestYear: z.number().int(),
      grossWeightKg: NullableFixed,
      tareWeightKg: NullableFixed,
      netWeightKg: NullableFixed,
      temperatureAtIntakeC: NullableFixed,
      phytosanitaryStatus: z.string(),
      /** La parcela tal como era al pesar. */
      terroir: z.object({ id: z.string(), parcelName: z.string(), altitudeMasl: NullableFixed, varietyName: z.string(), rawMaterialType: z.string(), takenAt: z.string().nullable() }),
      recordedAt: NullableInstant,
      recordedBy: Actor,
      maturityAnalyses: z.array(
        z.object({ id: z.string(), brixDegrees: NullableFixed, ph: NullableFixed, acidityGl: NullableFixed, measuredAt: NullableInstant, recordedAt: NullableInstant, recordedBy: Actor, source: z.string(), voidedAt: NullableInstant }),
      ),
      phytoDecisions: z.array(
        z.object({ id: z.string(), decision: z.string(), decidedAt: NullableInstant, recordedAt: NullableInstant, decidedBy: Actor, inspectionReportSha256: z.string().nullable(), source: z.string(), voidedAt: NullableInstant }),
      ),
    }),
  ),
  tanks: z.array(
    z.object({
      id: z.string(),
      tankCode: z.string(),
      material: z.string().nullable(),
      capacityLiters: NullableFixed,
      volumeFilledLiters: NullableFixed,
      finalVolumeLiters: NullableFixed,
      destinationType: z.string().nullable(),
      status: z.string(),
      startDate: NullableInstant,
      endDate: NullableInstant,
      recordedAt: NullableInstant,
      recordedBy: Actor,
      inputs: z.array(z.object({ harvestBatchId: z.string(), kg: NullableFixed })),
      readings: z.array(z.object({ id: z.string(), recordedAt: NullableInstant, temperatureCelsius: NullableFixed, specificGravity: NullableFixed, phValue: NullableFixed, voidedAt: NullableInstant })),
      treatments: z.array(
        z.object({ id: z.string(), treatmentType: z.string(), additiveName: z.string(), dosageAppliedGPerHl: NullableFixed, totalAppliedG: NullableFixed, regulatoryAuthCode: z.string(), appliedAt: NullableInstant, voidedAt: NullableInstant }),
      ),
    }),
  ),
  agings: z.array(
    z.object({
      id: z.string(),
      fermentationTankId: z.string(),
      containerType: z.string(),
      containerMaterial: z.string().nullable(),
      containerCount: z.number().int().nullable(),
      barrelUseCycle: z.number().int().nullable(),
      volumeLiters: NullableFixed,
      plannedMonths: z.number().int(),
      startDate: CalendarDateSchema,
      unlockDate: CalendarDateSchema,
      status: z.string(),
      discardedAt: NullableInstant,
      recordedAt: NullableInstant,
      recordedBy: Actor,
    }),
  ),
  distillations: z.array(
    z.object({
      id: z.string(),
      fermentationTankId: z.string(),
      processType: z.string(),
      equipmentIdentifier: z.string(),
      processStartDate: CalendarDateSchema,
      processEndDate: CalendarDateSchema.nullable(),
      inputVolumeLiters: NullableFixed,
      headsLiters: NullableFixed,
      heartLiters: NullableFixed,
      tailsLiters: NullableFixed,
      vinasseLiters: NullableFixed,
      heartAbvPercent: NullableFixed,
      restUntil: CalendarDateSchema.nullable(),
      status: z.string(),
      discardedAt: NullableInstant,
      recordedAt: NullableInstant,
      recordedBy: Actor,
    }),
  ),
  bottling: z
    .object({
      id: z.string(),
      lotCode: z.string(),
      productType: z.string(),
      bottlingDate: CalendarDateSchema,
      packagingFormatCl: z.number().int(),
      totalBottlesPackaged: z.number().int(),
      finalAlcoholAbv: NullableFixed,
      waterDilutionLiters: NullableFixed,
      bottleType: z.string().nullable(),
      leftover: z.object({ liters: NullableFixed, disposition: z.string() }).nullable(),
      /** Recalculado con los registros vigentes y el volumen entero de las fuentes embotelladas. */
      balance: Balance.nullable(),
      recordedAt: NullableInstant,
      recordedBy: Actor,
    })
    .nullable(),
  labAnalyses: z.array(
    z.object({
      id: z.string(),
      laboratoryName: z.string(),
      certificationCode: z.string(),
      analysisRequestDate: CalendarDateSchema.nullable(),
      testPerformedAt: CalendarDateSchema,
      actualAlcoholAbv: NullableFixed,
      totalAlcoholAbv: NullableFixed,
      totalAcidityTartaricGl: NullableFixed,
      volatileAcidityAceticGl: NullableFixed,
      freeSulfurDioxideMgL: NullableFixed,
      totalSulfurDioxideMgL: NullableFixed,
      reducingSugarsGl: NullableFixed,
      totalDryExtractGl: NullableFixed,
      sugarFreeDryExtractGl: NullableFixed,
      overpressureBar: NullableFixed,
      methanolContentMgL: NullableFixed,
      methanolMg100mlAa: NullableFixed,
      copperContentMgL: NullableFixed,
      conformityStatus: z.string().nullable(),
      /** `LabConformity` tal como se guardó. */
      conformity: z.unknown(),
      /** Vigente: ni sustituido por un reanálisis ni anulado. */
      current: z.boolean(),
      supersededAt: NullableInstant,
      voidedAt: NullableInstant,
      recordedAt: NullableInstant,
      recordedBy: Actor,
    }),
  ),
  corrections: z.array(
    z.object({
      id: z.string(),
      target: z.object({ type: z.string(), id: z.string() }),
      kind: z.string(),
      /** De un texto libre (notas, motivos) queda solo el campo. */
      changes: z.array(z.object({ field: z.string(), before: z.unknown().optional(), after: z.unknown().optional() })),
      createdAt: NullableInstant,
      createdBy: Actor,
    }),
  ),
  attachments: z.array(z.object({ kind: z.string(), sha256: z.string().nullable() })),
  /** Los códigos no van en claro: su número y la raíz Merkle (`merkleLeaf`, `merkleRootFromProof`). */
  bottleCodes: z.object({ count: z.number().int().min(0), merkleRoot: z.string(), algorithm: z.literal('sha256-merkle/serial-code-salt') }).nullable(),
})
export type CanonicalDossier = z.infer<typeof CanonicalDossierSchema>

/** Propiedades de primer nivel del expediente canónico, en el orden del contrato. */
export const CANONICAL_DOSSIER_KEYS = ['schema', 'closedAt', 'closedBy', 'winery', 'lot', 'rules', 'harvests', 'tanks', 'agings', 'distillations', 'bottling', 'labAnalyses', 'corrections', 'attachments', 'bottleCodes'] as const
