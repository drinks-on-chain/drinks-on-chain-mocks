import { uid } from '../shared/uuid'
import { slugify } from '../backoffice/model'
import type { Lot } from '../erp/schemas'
import { bottleCodesSummary, bottleLotOf, currentLab, harvestTerroir, lotHarvests, lotProjection, toLotView, type TraceState } from '../erp/trace/state'
import { publicTimeline, type WineryResolver } from './passport'
import type { PublicCollection, PublicCollectionSort, PublicCollectionStatus } from './schemas'

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

/** Una colección con lo que hace falta para ordenarla (`createdAt` del lote; no sale en la respuesta). */
export type RankedCollection = PublicCollection & { createdAt: string }

const priceOf = (c: PublicCollection): number | null => c.price?.amountMinor ?? null

/**
 * @experimental Borrador. Orden del catálogo: `featured` (por defecto: destacadas primero y, dentro,
 * las más recientes), `newest`, `price-asc`, `price-desc` (las que no tienen precio, al final) o `name`.
 */
export function sortCollections<T extends RankedCollection>(collections: readonly T[], sort: PublicCollectionSort = 'featured'): T[] {
  const createdAt = (c: T) => c.createdAt
  const newest = (a: T, b: T) => b.vintage - a.vintage || createdAt(b).localeCompare(createdAt(a)) || a.slug.localeCompare(b.slug)
  const byPrice = (direction: 1 | -1) => (a: T, b: T) => {
    const pa = priceOf(a)
    const pb = priceOf(b)
    if (pa === null || pb === null) return pa === pb ? newest(a, b) : pa === null ? 1 : -1
    return (pa - pb) * direction || newest(a, b)
  }
  const order: Record<PublicCollectionSort, (a: T, b: T) => number> = {
    featured: (a, b) => Number(b.featured) - Number(a.featured) || newest(a, b),
    newest,
    'price-asc': byPrice(1),
    'price-desc': byPrice(-1),
    name: (a, b) => a.name.localeCompare(b.name, 'es') || newest(a, b),
  }
  return [...collections].sort(order[sort])
}

/**
 * @experimental Borrador (§17.1). Colecciones del catálogo público a partir de los lotes con tipo
 * de producto y botellas (embotelladas, proyectadas o estimadas) de las bodegas activas, en el
 * orden por defecto (`featured`). No se ofrece un lote cuyo análisis vigente no es conforme.
 */
export function buildCollections(state: TraceState, wineryOf: WineryResolver, now: string, sold: Record<string, number> = {}): PublicCollection[] {
  return rankedCollections(state, wineryOf, now, sold).map(({ createdAt: _createdAt, ...collection }) => collection)
}

/** Las colecciones en el orden por defecto, con la fecha de su lote para poder reordenarlas. */
export function rankedCollections(state: TraceState, wineryOf: WineryResolver, now: string, sold: Record<string, number> = {}): RankedCollection[] {
  const today = now.slice(0, 10)
  const slugs = new Set<string>()
  const out: RankedCollection[] = []
  for (const lot of [...state.lots].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const winery = wineryOf(lot.wineryId)
    if (!winery.active || !lot.productType || lot.stage === 'REJECTED' || lot.stage === 'DISCARDED') continue
    if (currentLab(state, lot.id)?.conformityStatus === 'NON_CONFORMING') continue
    const bottled = lot.stage === 'BOTTLED' || lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED'
    const total = bottled ? bottleCodesSummary(bottleLotOf(state, lot.id)).active : (lot.estimatedBottles ?? lotProjection(state, lot).bottles)
    if (!total) continue
    const name = collectionName(state, lot)
    let slug = slugify(name)
    if (slugs.has(slug)) slug = `${slug}-${winery.slug}`
    slugs.add(slug)
    const seed = hash(slug)
    const status: PublicCollectionStatus = !bottled ? 'PRESALE' : seed % 5 === 0 ? 'SOLD_OUT' : 'ON_SALE'
    const sold0 = status === 'SOLD_OUT' ? total : Math.floor((total * ((seed % 60) + (bottled ? 20 : 5))) / 100)
    const base = lot.productType === 'SINGANI' ? 18_000 : 9_500
    const imageUrl = `/mocks/uploads/collections/${slug}.jpg`
    const view = toLotView(state, lot, { today, now })
    // Ola 3: si el lote tiene una colección real publicada, la ficha sale de ella (nombre, precio,
    // disponibilidad e imagen); el resto del catálogo sigue siendo de demostración.
    const real = state.chain.collections.find((c) => c.lotId === lot.id && c.status === 'PUBLISHED')
    if (real) {
      const tokens = state.chain.tokens.filter((t) => t.collectionId === real.id)
      const available = tokens.filter((t) => t.status === 'MINTED').length
      const realStatus: PublicCollectionStatus = available === 0 ? 'SOLD_OUT' : real.redeemableSince ? 'ON_SALE' : 'PRESALE'
      const images = real.commercial.images
      slugs.delete(slug)
      slugs.add(real.slug)
      out.push({
        id: real.id,
        slug: real.slug,
        name: real.commercial.name,
        productType: lot.productType,
        vintage: lot.harvestYear,
        winery: { slug: winery.slug, tradeName: winery.tradeName, region: winery.region },
        lotStage: lot.stage,
        estimatedReadyDate: real.commercial.estimatedRedeemDate ?? (bottled ? null : view.estimatedReadyDate),
        price: real.price ? { amountMinor: real.price.amountMinor, currency: 'BOB' } : null,
        availability: { total: real.quota, available },
        status: realStatus,
        saleState: realStatus,
        counts: { available },
        featured: true,
        imageUrl: images.find((i) => i.isCover)?.url ?? null,
        description: real.commercial.description,
        tastingNotes: real.commercial.tastingNotes ?? COPY[lot.productType].tastingNotes,
        pairing: real.commercial.pairing ?? COPY[lot.productType].pairing,
        gallery: images.map((i) => i.url),
        lot: { lotCode: lot.lotCode, timeline: publicTimeline(state, lot.id) },
        createdAt: lot.createdAt,
      })
      continue
    }
    const available = Math.max(0, total - sold0 - (sold[slug] ?? 0))
    const demoStatus: PublicCollectionStatus = available === 0 ? 'SOLD_OUT' : status
    out.push({
      id: uid(`public-collection:${slug}`),
      slug,
      name,
      productType: lot.productType,
      vintage: lot.harvestYear,
      winery: { slug: winery.slug, tradeName: winery.tradeName, region: winery.region },
      lotStage: lot.stage,
      estimatedReadyDate: bottled ? null : view.estimatedReadyDate,
      // El precio puede faltar (A-32): en origen aún no está decidido.
      price: lot.stage === 'ORIGIN' ? null : { amountMinor: base + (seed % 9) * 500, currency: 'BOB' },
      availability: { total, available },
      status: demoStatus,
      saleState: demoStatus,
      counts: { available },
      // Destacadas: los lotes con el expediente cerrado y una parte del resto en venta.
      featured: lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED' || (status === 'ON_SALE' && seed % 3 === 0),
      imageUrl,
      description: COPY[lot.productType].description,
      tastingNotes: COPY[lot.productType].tastingNotes,
      pairing: COPY[lot.productType].pairing,
      gallery: [imageUrl, `/mocks/uploads/collections/${slug}-2.jpg`],
      lot: { lotCode: lot.lotCode, timeline: publicTimeline(state, lot.id) },
      createdAt: lot.createdAt,
    })
  }
  return sortCollections(out)
}
