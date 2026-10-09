import { wineryDetail } from '../backoffice/handlers/support'
import { WINERY_CATEGORIES, type PublicWineryProfile } from '../backoffice/schemas'
import { getErpDb, nowStamp } from '../erp/handlers/db'
import { getScenario } from '../shared/scenarios'
import { ApiError, notFound } from '../erp/handlers/errors'
import { boolParam, enumParam, listResult, ok, strParam, type RouteContext, type RouteResult, type RouteSpec } from '../erp/handlers/http'
import { LOT_PRODUCT_TYPES, type Lot } from '../erp/schemas'
import { looksLikeBottleCode, isValidBottleCode, normalizeBottleCode } from '../erp/trace/bottle-code'
import { findBottle } from '../erp/trace/bottling'
import { dossierCanonical, lotAttachments, signedFileUrl } from '../erp/trace/dossier'
import { lotDossier } from '../erp/trace/state'
import { traceCtx } from '../erp/handlers/trace-context'
import { sha256Hex } from '../shared/crypto'
import { buildCollections, rankedCollections, sortCollections } from './collections'
import { buildBottlePassport, buildLotPassport, findLotByCode, LOT_CODE_PATTERN, toPublicProfile, type PublicWineryInfo } from './passport'
import { COLLECTION_SORTS, COLLECTION_STATUSES, type PublicCollectionSummary } from './schemas'

// Rutas públicas de la Ola 2 (contrato §12): pasaportes de lote y de botella, expediente canónico,
// adjuntos públicos y directorio de bodegas. Sin sesión. Más el BORRADOR del catálogo (§17.1), que
// no está en el OpenAPI del backend.

/** Contrato que adelanta el catálogo: lo declaran sus `RouteSpec` (`draft`) y `openapi/pendientes.json`. */
export const COLLECTIONS_DRAFT_CONTRACT = 'plan/contratos/o2-erp-confiable.md §17.1'

/** Freno a la enumeración de códigos (S-24): más de 20 inexistentes en 10 min desde una IP → 429. */
export const PUBLIC_LOOKUP_LIMIT = { misses: 20, windowMs: 10 * 60_000 } as const

/** Perfil público de una bodega; el pasaporte sigue visible aunque no esté activa (S-23). */
export function publicWineryOf(wineryId: string): PublicWineryInfo {
  const w = getErpDb().wineries.find((x) => x.id === wineryId)
  if (!w) return { slug: wineryId, tradeName: '', region: '', category: 'OTHER', logoUrl: null, publicStory: null, website: null, active: false }
  const d = wineryDetail(w)
  return { slug: d.slug, tradeName: d.tradeName, region: d.region, category: d.category, logoUrl: d.logoUrl, publicStory: d.publicStory, website: d.website, active: d.status === 'ACTIVE' }
}

/** IP real del visitante: la que firma el proxy de la app (`X-DOC-Client-IP`) o la de `X-Forwarded-For`. */
function clientIp(ctx: RouteContext): string {
  const h = ctx.request.headers
  return h.get('x-doc-client-ip')?.trim() || h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}

/**
 * Límite general del pasaporte público (PUB-05): 60 peticiones por minuto e IP para todas sus rutas
 * juntas (`RATE_LIMIT_PASSPORT_PER_MINUTE` del backend; `/v1/public/wineries` tiene 120). Los mocks
 * no cuentan las peticiones: el escenario `pasaporte-saturado` responde como si ya se hubiera superado.
 */
export const PUBLIC_RATE_LIMIT = { perMinute: 60, retryAfterSeconds: 60 } as const

/** 404 uniforme: código de botella o de lote inexistente, expediente sin cerrar o adjunto privado. */
const codeNotFound = () => new ApiError(404, 'PUB_CODE_NOT_FOUND', 'Código no encontrado', null, { 'Cache-Control': 'public, max-age=30' })
const codeMalformed = () =>
  new ApiError(422, 'PUB_CODE_MALFORMED', 'El código no es válido: revisa que esté completo y bien escrito', [{ field: 'code', message: 'Código mal formado o con el carácter de control incorrecto' }], {
    'Cache-Control': 'no-store',
  })

/**
 * Ejecuta una consulta del visor con sus límites: el general (escenario `pasaporte-saturado`) y el
 * freno a la enumeración, con el reloj de los mocks (S-24: cada código bien formado que no existe
 * cuenta para su IP; al superar 20 en 10 minutos, todas sus consultas del pasaporte responden 429
 * hasta que acaba la ventana).
 */
export function lookup<T>(ctx: RouteContext, find: () => T): T {
  if (getScenario() === 'pasaporte-saturado') {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Demasiadas peticiones. Vuelve a intentarlo en un momento', null, { 'Retry-After': String(PUBLIC_RATE_LIMIT.retryAfterSeconds), 'Cache-Control': 'no-store' })
  }
  const db = getErpDb()
  const ip = clientIp(ctx)
  const since = db.clock - PUBLIC_LOOKUP_LIMIT.windowMs
  const misses = (db.publicMisses[ip] ?? []).filter((at) => at > since)
  db.publicMisses[ip] = misses
  if (misses.length > PUBLIC_LOOKUP_LIMIT.misses) {
    const retryAfter = Math.max(1, Math.ceil(((misses[0] as number) + PUBLIC_LOOKUP_LIMIT.windowMs - db.clock) / 1000))
    throw new ApiError(429, 'PUB_TOO_MANY_LOOKUPS', 'Demasiados códigos inexistentes desde esta conexión. Vuelve a intentarlo más tarde', null, { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' })
  }
  try {
    return find()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PUB_CODE_NOT_FOUND') misses.push(db.clock)
    throw err
  }
}

/** `If-None-Match` con el mismo `ETag` → 304 sin cuerpo. */
function notModified(ctx: RouteContext, etag: string, cacheControl: string): RouteResult | null {
  const sent = ctx.request.headers.get('if-none-match')
  if (!sent || !sent.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) return null
  return { status: 304, data: undefined, headers: { 'Cache-Control': cacheControl, ETag: etag } }
}

/**
 * Respuesta con caché pública y `ETag` del contenido (con `If-None-Match` → 304). El pasaporte de un
 * lote con el expediente cerrado se guarda 1 h; el resto, 60 s (el de una botella siempre, porque su
 * código aún se puede anular, S-14).
 */
function cached(ctx: RouteContext, data: { generatedAt?: string; lot?: { generatedAt: string } }, longLived: boolean): RouteResult {
  const stable = JSON.stringify(data, (key, value: unknown) => (key === 'generatedAt' ? undefined : value))
  const etag = `"${sha256Hex(stable).slice(0, 32)}"`
  const cacheControl = `public, max-age=${longLived ? 3600 : 60}, stale-while-revalidate=600`
  return notModified(ctx, etag, cacheControl) ?? { status: 200, data, headers: { 'Cache-Control': cacheControl, ETag: etag } }
}

const isCertified = (lot: Lot) => lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED'

function lotPassport(ctx: RouteContext, lotCode: string): RouteResult {
  const code = lotCode.trim().toUpperCase()
  if (!LOT_CODE_PATTERN.test(code)) throw codeMalformed()
  const db = getErpDb()
  const lot = findLotByCode(db, code)
  if (!lot) throw codeNotFound()
  return cached(ctx, buildLotPassport(db, lot, publicWineryOf(lot.wineryId), nowStamp()), isCertified(lot))
}

function bottlePassport(ctx: RouteContext, raw: string): RouteResult {
  const code = normalizeBottleCode(raw)
  if (!isValidBottleCode(code)) throw codeMalformed()
  const db = getErpDb()
  const found = findBottle(db, code)
  if (!found) throw codeNotFound()
  const { lot, bottleLot, ref } = found
  return cached(ctx, buildBottlePassport(db, lot, bottleLot, { code, serial: ref.serial, generation: ref.generation }, publicWineryOf(lot.wineryId), nowStamp()), false)
}

/** Lote embotellado de un código de lote de la URL (422 si la forma es imposible, 404 si no existe). */
export function publicLot(lotCode: string): Lot {
  const code = decodeURIComponent(lotCode).trim().toUpperCase()
  if (!LOT_CODE_PATTERN.test(code)) throw codeMalformed()
  const lot = findLotByCode(getErpDb(), code)
  if (!lot) throw codeNotFound()
  return lot
}

export const publicRoutes: RouteSpec[] = [
  {
    // Resuelve el código del visor: de botella (8 caracteres con control) o de lote.
    method: 'get',
    path: '/v1/public/passports/:code',
    access: 'public',
    handle: (ctx) =>
      lookup(ctx, () => {
        const raw = decodeURIComponent(ctx.params.code!)
        if (LOT_CODE_PATTERN.test(raw.trim().toUpperCase())) return lotPassport(ctx, raw)
        if (looksLikeBottleCode(normalizeBottleCode(raw))) return bottlePassport(ctx, raw)
        throw codeMalformed()
      }),
  },
  {
    method: 'get',
    path: '/v1/public/lots/:lotCode',
    access: 'public',
    handle: (ctx) => lookup(ctx, () => lotPassport(ctx, decodeURIComponent(ctx.params.lotCode!))),
  },
  {
    method: 'get',
    path: '/v1/public/bottles/:code',
    access: 'public',
    handle: (ctx) => lookup(ctx, () => bottlePassport(ctx, decodeURIComponent(ctx.params.code!))),
  },
  {
    // Bytes canónicos del expediente (solo cerrado), sin el envoltorio `data`, para recalcular la huella.
    method: 'get',
    path: '/v1/public/lots/:lotCode/dossier',
    access: 'public',
    handle: (ctx) =>
      lookup(ctx, () => {
        const lot = publicLot(ctx.params.lotCode!)
        const dossier = lotDossier(getErpDb(), lot.id)
        if (dossier?.status !== 'CLOSED' || !dossier.hash) throw codeNotFound()
        // Los bytes tal como se guardaron al cerrar, con la huella como `ETag`.
        const etag = `"${dossier.hash}"`
        const cacheControl = 'public, max-age=3600, stale-while-revalidate=600'
        return (
          notModified(ctx, etag, cacheControl) ?? {
            status: 200,
            data: undefined,
            raw: { body: dossierCanonical(getErpDb(), traceCtx(null), lot), contentType: 'application/json; charset=utf-8' },
            headers: { 'Cache-Control': cacheControl, ETag: etag },
          }
        )
      }),
  },
  {
    // 302 a una URL firmada de corta vida (solo adjuntos `PUBLIC`).
    method: 'get',
    path: '/v1/public/lots/:lotCode/attachments/:attachmentId',
    access: 'public',
    handle: (ctx) =>
      lookup(ctx, () => {
        const lot = publicLot(ctx.params.lotCode!)
        const attachment = lotAttachments(getErpDb(), lot).find((a) => a.id === ctx.params.attachmentId && a.visibility === 'PUBLIC')
        if (!attachment) throw codeNotFound()
        return { status: 302, data: undefined, headers: { Location: signedFileUrl(traceCtx(null), attachment.key).url, 'Cache-Control': 'no-store' } }
      }),
  },
  {
    // Directorio público: solo bodegas `ACTIVE`, por nombre comercial (O2-WEB-1).
    method: 'get',
    path: '/v1/public/wineries',
    access: 'public',
    list: 'paged',
    handle({ query }) {
      const region = strParam(query, 'region')?.toLowerCase()
      const category = enumParam(query, 'category', WINERY_CATEGORIES)
      const items: PublicWineryProfile[] = getErpDb()
        .wineries.filter((w) => w.certificationStatus === 'ACTIVE')
        .map((w) => toPublicProfile(publicWineryOf(w.id)))
        .filter((p) => (!region || p.region.toLowerCase().includes(region)) && (!category || p.category === category))
        .sort((a, b) => a.tradeName.localeCompare(b.tradeName, 'es'))
      return { ...listResult(items, query), headers: { 'Cache-Control': 'public, max-age=60' } }
    },
  },

  // ----- BORRADOR del catálogo (contrato §17.1; fuera del OpenAPI del backend) -----
  {
    method: 'get',
    path: '/v1/public/collections',
    access: 'public',
    list: 'paged',
    draft: COLLECTIONS_DRAFT_CONTRACT,
    handle({ query }) {
      const productType = enumParam(query, 'productType', LOT_PRODUCT_TYPES)
      const status = enumParam(query, 'status', COLLECTION_STATUSES)
      const winery = strParam(query, 'winery')
      const q = strParam(query, 'q')?.toLowerCase()
      const featured = boolParam(query, 'featured')
      const sort = enumParam(query, 'sort', COLLECTION_SORTS)
      const filtered = rankedCollections(getErpDb(), publicWineryOf, nowStamp(), getErpDb().marketplace.sold).filter(
        (c) =>
          (!productType || c.productType === productType) &&
          (!status || c.status === status) &&
          (!winery || c.winery.slug === winery) &&
          (featured === undefined || c.featured === featured) &&
          (!q || `${c.name} ${c.winery.tradeName}`.toLowerCase().includes(q)),
      )
      // Vienen en el orden por defecto (`featured`); con otro, se reordenan.
      const items: PublicCollectionSummary[] = (sort && sort !== 'featured' ? sortCollections(filtered, sort) : filtered)
        .map(({ description: _d, tastingNotes: _t, pairing: _p, gallery: _g, lot: _l, createdAt: _c, ...summary }) => summary)
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/public/collections/:slug',
    access: 'public',
    draft: COLLECTIONS_DRAFT_CONTRACT,
    handle({ params }) {
      const collection = buildCollections(getErpDb(), publicWineryOf, nowStamp(), getErpDb().marketplace.sold).find((c) => c.slug === params.slug)
      if (!collection) throw notFound(`Colección "${params.slug}" no encontrada`)
      return ok(collection)
    },
  },
]
