import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deriveLotView,
  deriveLotViews,
  deriveRestStatus,
  type BottlingBatchResponse,
  type FermentationTankResponse,
  type HarvestBatchResponse,
  type LotChain,
  type ProductionBatchResponse,
  type TerroirResponse,
  type WineAgingResponse,
} from '../src'

const dir = join(import.meta.dirname, 'reference', 'erp')
const load = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T

const chain: LotChain = {
  harvestBatches: load<HarvestBatchResponse[]>('harvest-batches.json'),
  terroirs: load<TerroirResponse[]>('terroirs.json'),
  tanks: load<FermentationTankResponse[]>('fermentation-tanks.json'),
  wineAgings: load<WineAgingResponse[]>('wine-aging.json'),
  productionBatches: load<ProductionBatchResponse[]>('production-batches.json'),
  bottlings: load<BottlingBatchResponse[]>('bottling.json'),
}

describe('deriveLotViews', () => {
  it('reproduce lots-view.json a partir de la cadena (fecha 2026-09-25)', () => {
    expect(deriveLotViews(chain, { today: '2026-09-25' })).toStrictEqual(load('lots-view.json'))
  })

  it('acepta un Date como "hoy"', () => {
    expect(deriveLotViews(chain, { today: new Date(Date.UTC(2026, 8, 25, 18)) })).toStrictEqual(load('lots-view.json'))
  })

  it('los fixtures cubren las etapas principales', () => {
    const stages = new Set(deriveLotViews(chain, { today: '2026-09-25' }).map((l) => l.stage))
    expect([...stages].sort()).toEqual(['crianza', 'embotellado', 'fermentacion', 'pesaje', 'rechazado', 'reposo'])
  })

  it('bifurcación: tanque COMPLETED sin crianza ni destilación', () => {
    const h = chain.harvestBatches.find((x) => x.phytosanitaryStatus === 'APPROVED')!
    const tank: FermentationTankResponse = { ...chain.tanks[0]!, id: 'tk-x', harvestBatchId: h.id, status: 'COMPLETED', destinationType: 'WINE_AGING' }
    const view = deriveLotView(h, { ...chain, tanks: [tank], wineAgings: [], productionBatches: [], bottlings: [] })
    expect(view.stage).toBe('bifurcacion')
    expect(view.kind).toBeNull()
  })

  it('el candado de reposo se libera al cumplir 180 días', () => {
    const view = (today: string) =>
      deriveLotViews(chain, { today }).find((l) => l.harvestBatchCode === 'HARV-2026-PARRALES-01')!
    const before = view('2026-09-25')
    expect(before.lock).toMatchObject({ kind: 'reposo', released: false, daysRemaining: 18 })
    const after = view('2026-10-13')
    expect(after.lock).toMatchObject({ kind: 'reposo', released: true, daysRemaining: 0 })
  })

  it('funciona con datos incompletos (parcela ausente, sin tanques)', () => {
    const h = chain.harvestBatches[0]!
    const lone = deriveLotView(h, { ...chain, terroirs: [], tanks: [] }, { today: '2026-09-25' })
    expect(lone.terroir.id).toBe(h.terroirId)
    expect(lone.stage).toBe('vendimia')
    expect(lone.kind).toBeNull()
  })

  it('deriveRestStatus coincide con production-rest-status.json', () => {
    const rest = chain.productionBatches.map((p) => deriveRestStatus(p, { today: '2026-09-25' }))
    expect(rest).toStrictEqual(load('production-rest-status.json'))
  })
})
