import type { HttpHandler } from 'msw'
import { BACKOFFICE_ROUTE_SPECS, setMockAppUrls, withErpExtras } from '../../backoffice/handlers'
import type { AppUrls } from '../../backoffice/mail'
import { resetErpDb as resetDb } from './db'
import { buildFallbackHandlers, buildHandlers, resetIdempotency, type ErpHandlerOptions, type RouteSpec } from './http'
import { authUserRoutes } from './routes/auth-users'
import { bottlingLabRoutes } from './routes/bottling-lab'
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
  ...traceabilitySystemRoutes,
].map(withErpExtras)

/** Todas las rutas simuladas (ERP + Ola 1). La usa la prueba de contrato. */
export const MOCK_ROUTE_SPECS: readonly RouteSpec[] = [...ERP_ROUTE_SPECS, ...BACKOFFICE_ROUTE_SPECS]

/** Rutas simuladas (método en mayúsculas y ruta con `:param`), p. ej. para un panel de desarrollo. */
export const ERP_ROUTES: ReadonlyArray<{ method: string; path: string; public: boolean }> = MOCK_ROUTE_SPECS.map((r) => ({
  method: r.method.toUpperCase(),
  path: r.path,
  public: r.access === 'public',
}))

export interface MockHandlerOptions extends ErpHandlerOptions {
  /** URL base de cada app en los enlaces de los correos del buzón simulado (por defecto, localhost). */
  appUrls?: Partial<AppUrls>
}

/**
 * Crea los handlers MSW de todos los dominios (ERP + Ola 1). Comparten una base de datos en
 * memoria (`resetErpDb()`) y la sesión.
 */
export function createErpHandlers(options: MockHandlerOptions = {}): HttpHandler[] {
  const { appUrls, ...rest } = options
  if (appUrls) setMockAppUrls(appUrls)
  return [...MOCK_ROUTE_SPECS.flatMap((spec) => buildHandlers(spec, rest)), ...buildFallbackHandlers(rest)]
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
export { mockAccessToken, type AuthContext } from './auth-context'
export { expireAccessTokens, REFRESH_COOKIE, resetSessions } from './sessions'
export { BACKOFFICE_ROUTE_SPECS, getMockAppUrls, mockMailbox, setMockAppUrls, type MailboxFilter } from '../../backoffice/handlers'
