import { slugify } from '../backoffice/model'
import type { Lot } from '../erp/schemas'
import { bottleCodesSummary, bottleLotOf, harvestTerroir, lotHarvests, lotProjection, toLotView, type TraceState } from '../erp/trace/state'
import { publicTimeline, type WineryResolver } from './passport'
import type { PublicCollection, PublicCollectionStatus } from './schemas'

// BORRADOR del catálogo de colecciones (contrato de la Ola 2 §17.1). No lo implementa el backend
// en esta ola ni está en su OpenAPI: lo fija el OpenAPI borrador de la Etapa 4 (O3-PK-1) y puede
// cambiar. Solo existe para que la pantalla 2A del Marketplace (catálogo sin cuenta) se construya
// contra mocks. Las colecciones se derivan de los lotes de las bodegas activas; precio,
// disponibilidad y textos son de demostración.

/** Texto estable → entero (para variar precios y disponibilidad sin azar). */
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

const COPY = {
  SINGANI: {
    description: 'Singani de Moscatel de Alejandría de altura, destilado en alambique de cobre y reposado antes de embotellar.',
    tastingNotes: 'Nariz floral de azahar y jazmín, con cítricos y un fondo de uva fresca; boca seca, limpia y persistente.',
    pairing: 'Solo y frío, en chuflay o con frutas de carozo y postres de cítricos.',
  },
  WINE: {
    description: 'Vino de altura de los valles del sur de Bolivia, criado en barrica y embotellado en la propia bodega.',
    tastingNotes: 'Fruta negra madura, especias y un tanino firme que la altura afina; final largo y fresco.',
    pairing: 'Carnes a la parrilla, quesos curados y guisos de la cocina chapaca.',
  },
} as const

/** Nombre comercial de un lote migrado (su nombre es el código de lote): producto, parcela y añada. */
function collectionName(state: TraceState, lot: Lot): string {
  if (lot.rules.origin !== 'MIGRATION') return lot.name
  const harvest = lotHarvests(state, lot.id)[0]
  const parcel = harvest ? (harvestTerroir(state, harvest).parcelName.split('·').at(-1)?.trim() ?? '') : ''
  return `${lot.productType === 'SINGANI' ? 'Singani' : 'Vino'} ${parcel} ${lot.harvestYear}`.replace(/\s+/g, ' ')
}

/**
 * @experimental Borrador (§17.1). Colecciones del catálogo público a partir de los lotes con tipo
 * de producto y botellas (embotelladas, proyectadas o estimadas) de las bodegas activas.
 */
export function buildCollections(state: TraceState, wineryOf: WineryResolver, now: string): PublicCollection[] {
  const today = now.slice(0, 10)
  const slugs = new Set<string>()
  const out: PublicCollection[] = []
  for (const lot of [...state.lots].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const winery = wineryOf(lot.wineryId)
    if (!winery.active || !lot.productType || lot.stage === 'REJECTED' || lot.stage === 'DISCARDED') continue
    const bottled = lot.stage === 'BOTTLED' || lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED'
    const total = bottled ? bottleCodesSummary(bottleLotOf(state, lot.id)).active : (lot.estimatedBottles ?? lotProjection(state, lot).bottles)
    if (!total) continue
    const name = collectionName(state, lot)
    let slug = slugify(name)
    if (slugs.has(slug)) slug = `${slug}-${winery.slug}`
    slugs.add(slug)
    const seed = hash(slug)
    const status: PublicCollectionStatus = !bottled ? 'PRESALE' : seed % 5 === 0 ? 'SOLD_OUT' : 'ON_SALE'
    const sold = status === 'SOLD_OUT' ? total : Math.floor((total * ((seed % 60) + (bottled ? 20 : 5))) / 100)
    const base = lot.productType === 'SINGANI' ? 18_000 : 9_500
    const imageUrl = `/mocks/uploads/collections/${slug}.jpg`
    const view = toLotView(state, lot, { today, now })
    out.push({
      slug,
      name,
      productType: lot.productType,
      vintage: lot.harvestYear,
      winery: { slug: winery.slug, tradeName: winery.tradeName, region: winery.region },
      lotStage: lot.stage,
      estimatedReadyDate: bottled ? null : view.estimatedReadyDate,
      // El precio puede faltar (A-32): en origen aún no está decidido.
      price: lot.stage === 'ORIGIN' ? null : { amountMinor: base + (seed % 9) * 500, currency: 'BOB' },
      availability: { total, available: Math.max(0, total - sold) },
      status,
      imageUrl,
      description: COPY[lot.productType].description,
      tastingNotes: COPY[lot.productType].tastingNotes,
      pairing: COPY[lot.productType].pairing,
      gallery: [imageUrl, `/mocks/uploads/collections/${slug}-2.jpg`],
      lot: { lotCode: lot.lotCode, timeline: publicTimeline(state, lot.id) },
    })
  }
  return out
}
