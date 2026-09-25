import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuthResponseSchema,
  BatchLabAnalysisResponseSchema,
  BottlingBatchResponseSchema,
  EnologicalTreatmentSchema,
  FermentationLogSchema,
  FermentationTankResponseSchema,
  HarvestBatchResponseSchema,
  LotViewSchema,
  MockUserSchema,
  ProductionBatchResponseSchema,
  PublicPassportMapSchema,
  RestStatusResponseSchema,
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
  'fermentation-logs.json': z.array(FermentationLogSchema),
  'enological-treatments.json': z.array(EnologicalTreatmentSchema),
  'wine-aging.json': z.array(WineAgingResponseSchema),
  'production-batches.json': z.array(ProductionBatchResponseSchema),
  'production-rest-status.json': z.array(RestStatusResponseSchema),
  'bottling.json': z.array(BottlingBatchResponseSchema),
  'lab-analyses.json': z.array(BatchLabAnalysisResponseSchema),
  'traceability-public.json': PublicPassportMapSchema,
  'lots-view.json': z.array(LotViewSchema),
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
