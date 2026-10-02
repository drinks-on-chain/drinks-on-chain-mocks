import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuthResponseSchema,
  BatchLabAnalysisResponseSchema,
  BottleLotSchema,
  BottlingBatchResponseSchema,
  CorrectionSchema,
  EnologicalTreatmentRecordSchema,
  FermentationLogRecordSchema,
  FermentationTankResponseSchema,
  HarvestBatchResponseSchema,
  LotDossierSchema,
  LotSchema,
  MaturityAnalysisSchema,
  MockUserSchema,
  PhytoDecisionSchema,
  PublicCollectionSchema,
  PublicLotPassportSchema,
  PublicWineryProfileSchema,
  ProductionBatchResponseSchema,
  RestStatusResponseSchema,
  StoredLotAttachmentSchema,
  StoredLotEventSchema,
  TerroirResponseSchema,
  WalletResponseSchema,
  WineAgingResponseSchema,
  WineryResponseSchema,
} from '../src'

// Cada fixture se valida contra su esquema; además, parsear no debe perder campos
// (un campo desconocido en el JSON rompe la prueba igual que uno que falte).

const dir = join(import.meta.dirname, '..', 'fixtures', 'erp')

const SCHEMAS: Record<string, z.ZodType> = {
  'wineries.json': z.array(WineryResponseSchema),
  'users.json': z.array(MockUserSchema),
  'wallets.json': z.array(WalletResponseSchema),
  'auth-login.json': z.record(z.string(), AuthResponseSchema),
  'terroirs.json': z.array(TerroirResponseSchema),
  'harvest-batches.json': z.array(HarvestBatchResponseSchema),
  'fermentation-tanks.json': z.array(FermentationTankResponseSchema),
  'fermentation-logs.json': z.array(FermentationLogRecordSchema),
  'enological-treatments.json': z.array(EnologicalTreatmentRecordSchema),
  'wine-aging.json': z.array(WineAgingResponseSchema),
  'production-batches.json': z.array(ProductionBatchResponseSchema),
  'production-rest-status.json': z.array(RestStatusResponseSchema),
  'bottling.json': z.array(BottlingBatchResponseSchema),
  'lab-analyses.json': z.array(BatchLabAnalysisResponseSchema),
  // Ola 2
  'lots.json': z.array(LotSchema),
  'lot-events.json': z.array(StoredLotEventSchema),
  'maturity-analyses.json': z.array(MaturityAnalysisSchema),
  'phyto-decisions.json': z.array(PhytoDecisionSchema),
  'bottle-lots.json': z.array(BottleLotSchema),
  'corrections.json': z.array(CorrectionSchema),
  'lot-attachments.json': z.array(StoredLotAttachmentSchema),
  'lot-dossiers.json': z.array(LotDossierSchema),
}

const publicDir = join(import.meta.dirname, '..', 'fixtures', 'public')
const PUBLIC_SCHEMAS: Record<string, z.ZodType> = {
  'passports.json': z.record(z.string(), PublicLotPassportSchema),
  'bottle-codes.json': z.array(
    z.object({
      lotCode: z.string(),
      lotId: z.string(),
      total: z.number().int(),
      codes: z.array(z.object({ serial: z.number().int(), code: z.string(), status: z.enum(['ACTIVE', 'VOIDED']) })),
    }),
  ),
  'wineries.json': z.array(PublicWineryProfileSchema),
  'collections.json': z.array(PublicCollectionSchema),
}

describe('fixtures del ERP', () => {
  it('cada archivo tiene esquema', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    expect(files).toEqual(Object.keys(SCHEMAS).sort())
  })

  it.each(Object.keys(SCHEMAS))('%s cumple su esquema zod sin campos extra', (name) => {
    const data: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    const result = SCHEMAS[name]!.safeParse(data)
    if (!result.success) throw new Error(z.prettifyError(result.error))
    expect(result.data).toStrictEqual(data)
  })

  it.each(Object.keys(PUBLIC_SCHEMAS))('public/%s cumple su esquema zod sin campos extra', (name) => {
    expect(readdirSync(publicDir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(PUBLIC_SCHEMAS).sort())
    const data: unknown = JSON.parse(readFileSync(join(publicDir, name), 'utf8'))
    const result = PUBLIC_SCHEMAS[name]!.safeParse(data)
    if (!result.success) throw new Error(z.prettifyError(result.error))
    expect(result.data).toStrictEqual(data)
  })

  it('coherencia: neto = bruto − tara; cada embotellado tiene una sola fuente', () => {
    const harvests = JSON.parse(readFileSync(join(dir, 'harvest-batches.json'), 'utf8')) as z.infer<typeof HarvestBatchResponseSchema>[]
    for (const h of harvests) expect(h.netWeightKg).toBe(h.grossWeightKg - h.tareWeightKg)
    const bottlings = JSON.parse(readFileSync(join(dir, 'bottling.json'), 'utf8')) as z.infer<typeof BottlingBatchResponseSchema>[]
    for (const b of bottlings) {
      expect(Boolean(b.wineAgingBatchId) !== Boolean(b.productionBatchId)).toBe(true)
      expect(b.internationalLotCode).toMatch(/^[A-Z]{3}-\d{4}-[A-Z]+-\d{3}$/)
    }
  })
})
