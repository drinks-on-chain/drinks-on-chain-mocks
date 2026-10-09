import { chainRoutes } from '../../chain/handlers'
import { setMockPublicApiBaseUrl } from '../../chain/runtime'
import { marketplaceDraftRoutes } from '../../marketplace/handlers'
import { publicChainRoutes } from '../../public/chain-handlers'
import { tokenizationRoutes } from '../../tokenization/handlers'
import type { HttpHandler } from 'msw'
import { BACKOFFICE_ROUTE_SPECS, setMockAppUrls, withErpExtras } from '../../backoffice/handlers'
import type { AppUrls } from '../../backoffice/mail'
import { resetErpDb as resetDb } from './db'
import { buildFallbackHandlers, buildHandlers, resetIdempotency, type ErpHandlerOptions, type RouteSpec } from './http'
import { buildMockFileHandlers } from './mock-files'
import { authUserRoutes } from './routes/auth-users'
import { publicRoutes } from '../../public/handlers'
import { bottlingLabRoutes } from './routes/bottling-lab'
import { lotRoutes } from './routes/lots'
import { terroirHarvestRoutes } from './routes/terroirs-harvest'
import { traceabilitySystemRoutes } from './routes/traceability-system'
import { wineryRoutes } from './routes/wineries'
import { winemakingRoutes } from './routes/winemaking'

// Handlers MSW: las operaciones del OpenAPI del ERP (incluida /v1/health), las que adelanta el
// contrato de la Ola 0 y las de la Ola 1 (back office, bodegas, equipos, configuración, bitácora
// y segundo factor; openapi/pendientes.json). Cada una responde en `${baseUrl}/v1/...` y en
// `/api/v1/...` de cualquier origen (P-1).

/** Rutas del ERP (con la bitácora de sus escrituras y la idempotencia de los 9 POST de alta). */
export const ERP_ROUTE_SPECS: readonly RouteSpec[] = [
  ...authUserRoutes,
  ...wineryRoutes,
  ...terroirHarvestRoutes,
  ...winemakingRoutes,
  ...bottlingLabRoutes,
  ...lotRoutes,
  ...traceabilitySystemRoutes,
].map(withErpExtras)

/**
 * Rutas públicas: las de la Ola 2 (pasaportes, directorio de bodegas), el borrador del catálogo
 * (§17.1) y las de la Ola 3 (registro, `stellar.toml`, verificación, metadatos del NFT, imágenes).
 */
export const PUBLIC_ROUTE_SPECS: readonly RouteSpec[] = [...publicRoutes, ...publicChainRoutes]

/** Rutas de la Ola 3: tokenización (ERP y back office) y cadena. */
export const TOKENIZATION_ROUTE_SPECS: readonly RouteSpec[] = tokenizationRoutes.map(withErpExtras)
export const CHAIN_ROUTE_SPECS: readonly RouteSpec[] = chainRoutes

/** BORRADOR de la Etapa 4 (contrato de la Ola 3 §13.1): cuenta del consumidor y compra. Fuera del OpenAPI. */
export const MARKETPLACE_DRAFT_ROUTE_SPECS: readonly RouteSpec[] = marketplaceDraftRoutes

/** Todas las rutas simuladas (ERP + Ola 1 + públicas). La usa la prueba de contrato. */
export const MOCK_ROUTE_SPECS: readonly RouteSpec[] = [
  ...ERP_ROUTE_SPECS,
  ...BACKOFFICE_ROUTE_SPECS,
  ...TOKENIZATION_ROUTE_SPECS,
  ...CHAIN_ROUTE_SPECS,
  ...PUBLIC_ROUTE_SPECS,
  ...MARKETPLACE_DRAFT_ROUTE_SPECS,
]

/**
 * Rutas simuladas (método en mayúsculas y ruta con `:param`), p. ej. para un panel de desarrollo.
 * `draft`: borrador que no está en el OpenAPI del backend (su contrato de ola).
 */
export const ERP_ROUTES: ReadonlyArray<{ method: string; path: string; public: boolean; draft?: string }> = MOCK_ROUTE_SPECS.map((r) => ({
  method: r.method.toUpperCase(),
  path: r.path,
  public: r.access === 'public',
  ...(r.draft ? { draft: r.draft } : {}),
}))

export interface MockHandlerOptions extends ErpHandlerOptions {
  /** URL base de cada app en los enlaces de los correos del buzón simulado (por defecto, localhost). */
  appUrls?: Partial<AppUrls>
  /**
   * Archivos de `/mocks/uploads/…` (logotipos, etiquetas, imágenes del catálogo, informes, ZIP de
   * códigos). `placeholder` (por defecto): los handlers sirven un archivo de demostración (imagen
   * SVG, PDF de una página o el ZIP). `passthrough`: no se interceptan (la app sirve los suyos
   * desde `public/mocks/uploads/`).
   */
  uploads?: 'placeholder' | 'passthrough'
  /**
   * `PUBLIC_API_BASE_URL` de los mocks (Ola 3): base del `token_uri` de los contratos que se
   * desplieguen en la sesión. Por defecto, `http://localhost:4000` (como en los fixtures).
   */
  publicApiBaseUrl?: string
}

/**
 * Crea los handlers MSW de todos los dominios (ERP + Ola 1). Comparten una base de datos en
 * memoria (`resetErpDb()`) y la sesión.
 */
export function createErpHandlers(options: MockHandlerOptions = {}): HttpHandler[] {
  const { appUrls, uploads = 'placeholder', publicApiBaseUrl, ...rest } = options
  if (appUrls) setMockAppUrls(appUrls)
  if (publicApiBaseUrl !== undefined) setMockPublicApiBaseUrl(publicApiBaseUrl)
  return [...MOCK_ROUTE_SPECS.flatMap((spec) => buildHandlers(spec, rest)), ...(uploads === 'placeholder' ? buildMockFileHandlers() : []), ...buildFallbackHandlers(rest)]
}

/** Alias con nombre neutro: los handlers ya no son solo del ERP. */
export const createMockHandlers = createErpHandlers

/** Descarta los cambios: fixtures, reloj, sesiones, estado guardado e idempotencia. */
export function resetErpDb(): void {
  resetDb()
  resetIdempotency()
}

export type { ErpHandlerOptions, RouteSpec } from './http'
export { CLIENT_APP_HEADER, IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, SAME_ORIGIN_API_PREFIX } from './http'
export { advanceMockClock, getErpDb, type BackofficeState, type ErpDb } from './db'
export { COLLECTIONS_DRAFT_CONTRACT, PUBLIC_LOOKUP_LIMIT, PUBLIC_RATE_LIMIT } from '../../public/handlers'
export { mockAccessToken, type AuthContext } from './auth-context'
export { expireAccessTokens, expireRefreshGrace, LOGIN_LOCK_POLICY, REFRESH_COOKIE, REFRESH_GRACE_SECONDS, resetSessions } from './sessions'
export { BACKOFFICE_ROUTE_SPECS, getMockAppUrls, mockMailbox, setMockAppUrls, type MailboxFilter } from '../../backoffice/handlers'
export { DEFAULT_PUBLIC_API_BASE_URL, getMockPublicApiBaseUrl, mockChain, setMockPublicApiBaseUrl, type ChainNetworkMode, type MockChain } from '../../chain/runtime'
export { CHAIN_STEP_MS, TRANSIENT_CHAIN_ERRORS } from '../../chain/engine'
export { MOCK_EXPLORER_BASE_URL } from '../../chain/views'
export type { ChainState, ForcedChainFailure } from '../../chain/state'
export type { MarketplaceState } from '../../marketplace/handlers'
export { mockTokenization, type MockTokenization, type ResubmitAsWineryOptions } from '../../tokenization/runtime'
export { MINT_HOLD_CODES } from '../../chain/engine'
export { INDEXER_GAP_LEDGERS, RECONCILED_ALERT_CODES, type ChainDriftInput } from '../../chain/service'
export type { ChainDrift, ChainNotice } from '../../chain/state'
