import { profileOf } from '../backoffice/handlers/support'
import { chainCtx } from '../chain/runtime'
import { getErpDb } from '../erp/handlers/db'
import { ApiError } from '../erp/handlers/errors'
import { getScenario } from '../shared/scenarios'
import { ok, type RouteSpec } from '../erp/handlers/http'
import { demoBottlePng } from '../shared/png'
import { publicChainRegistry, publicDossierVerification, publicNftMetadata } from '../tokenization/views'
import { lookup, publicLot } from './handlers'

// Rutas públicas de la Ola 3 (contrato §3.2, §6.5 y §7.3), sin sesión: registro de cuentas y
// contratos oficiales, `stellar.toml`, verificación del anclaje de un lote, metadatos del NFT
// (`token_uri`) e imágenes de las colecciones.

const CACHE_5_MIN = { 'Cache-Control': 'public, max-age=300' }

/** `/.well-known/stellar.toml` (SEP-1): cuentas de la plataforma y de cada bodega activa. */
function stellarToml(): string {
  const registry = publicChainRegistry(getErpDb(), chainCtx())
  const accounts = [registry.platform.operationsAccount, registry.platform.anchorAccount, ...registry.wineries.map((w) => w.account)].filter(Boolean)
  return [
    'VERSION="2.0.0"',
    `NETWORK_PASSPHRASE="${registry.networkPassphrase}"`,
    'ACCOUNTS=[',
    ...accounts.map((a, i) => `  "${a}"${i < accounts.length - 1 ? ',' : ''}`),
    ']',
    '',
    '[DOCUMENTATION]',
    'ORG_NAME="Drinks on Chain"',
    'ORG_URL="https://www.drinksonchain.com"',
    'ORG_DESCRIPTION="Trazabilidad y preventa de vinos y singanis de Bolivia"',
    '',
    // Los contratos no van en `[[CURRENCIES]]` (S-7): su fuente canónica es `GET /v1/public/chain/registry`.
  ].join('\n')
}

export const publicChainRoutes: RouteSpec[] = [
  {
    // Fuera de `/v1`: lo sirve el backend en su raíz.
    method: 'get',
    path: '/.well-known/stellar.toml',
    access: 'public',
    handle: () => ({ status: 200, data: undefined, raw: { body: stellarToml(), contentType: 'text/plain; charset=utf-8' }, headers: { ...CACHE_5_MIN, 'Access-Control-Allow-Origin': '*' } }),
  },
  {
    method: 'get',
    path: '/v1/public/chain/registry',
    access: 'public',
    handle: () => ({ ...ok(publicChainRegistry(getErpDb(), chainCtx())), headers: CACHE_5_MIN }),
  },
  {
    method: 'get',
    path: '/v1/public/lots/:lotCode/verification',
    access: 'public',
    handle(ctx) {
      // Escenario `verificacion-no-encontrada`: la verificación responde 404 aunque el pasaporte cargue
      // (un lote que dejó de publicarse). Fuera de `lookup`: no cuenta para el freno a la enumeración.
      if (getScenario() === 'verificacion-no-encontrada') throw new ApiError(404, 'PUB_CODE_NOT_FOUND', 'Código no encontrado', null, { 'Cache-Control': 'public, max-age=30' })
      return lookup(ctx, () => {
        const lot = publicLot(ctx.params.lotCode!)
        const view = publicDossierVerification(getErpDb(), chainCtx(), lot, `/v1/public/lots/${encodeURIComponent(lot.lotCode!)}/dossier`)
        return { ...ok(view), headers: { 'Cache-Control': `public, max-age=${view.anchor?.status === 'ANCHORED' ? 3600 : 60}` } }
      })
    },
  },
  {
    method: 'get',
    path: '/v1/public/nft/:winerySlug/:tokenId',
    access: 'public',
    handle({ params }) {
      const notFound = () => new ApiError(404, 'PUB_TOKEN_NOT_FOUND', 'Ese NFT no existe en el contrato de la bodega', null, { 'Cache-Control': 'public, max-age=30' })
      const tokenId = Number(params.tokenId)
      const winery = getErpDb().wineries.find((w) => profileOf(w).slug === params.winerySlug)
      if (!winery || !Number.isInteger(tokenId) || tokenId < 0) throw notFound()
      const metadata = publicNftMetadata(getErpDb(), chainCtx(), winery.id, tokenId)
      if (!metadata) throw notFound()
      return { ...ok(metadata), headers: CACHE_5_MIN }
    },
  },
  {
    // Bytes de la imagen (los mocks no guardan los archivos subidos: sirven una de demostración).
    method: 'get',
    path: '/v1/public/collections/images/:imageId',
    access: 'public',
    handle({ params }) {
      const image = getErpDb()
        .chain.collections.flatMap((c) => c.commercial.images)
        .find((i) => i.id === params.imageId)
      if (!image) throw new ApiError(404, 'FILE_NOT_FOUND', 'Imagen no encontrada')
      return { status: 200, data: undefined, raw: { body: demoBottlePng(image.key), contentType: 'image/png' }, headers: { 'Cache-Control': 'public, max-age=86400' } }
    },
  },
]
