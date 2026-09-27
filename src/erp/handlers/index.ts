import type { HttpHandler } from 'msw'
import { buildFallbackHandlers, buildHandlers, type ErpHandlerOptions, type RouteSpec } from './http'
import { authUserRoutes } from './routes/auth-users'
import { bottlingLabRoutes } from './routes/bottling-lab'
import { terroirHarvestRoutes } from './routes/terroirs-harvest'
import { traceabilitySystemRoutes } from './routes/traceability-system'
import { wineryRoutes } from './routes/wineries'
import { winemakingRoutes } from './routes/winemaking'

// Handlers MSW del ERP: las 45 operaciones del OpenAPI (incluida /v1/health) más las que
// adelanta el contrato de la Ola 0 (openapi/pendientes.json). Cada una responde en
// `${baseUrl}/v1/...` y en `/api/v1/...` de cualquier origen (P-1).

/** Especificación de todas las rutas (la usa la prueba de contrato). */
export const ERP_ROUTE_SPECS: readonly RouteSpec[] = [
  ...authUserRoutes,
  ...wineryRoutes,
  ...terroirHarvestRoutes,
  ...winemakingRoutes,
  ...bottlingLabRoutes,
  ...traceabilitySystemRoutes,
]

/** Rutas simuladas (método en mayúsculas y ruta con `:param`), p. ej. para un panel de desarrollo. */
export const ERP_ROUTES: ReadonlyArray<{ method: string; path: string; public: boolean }> = ERP_ROUTE_SPECS.map((r) => ({
  method: r.method.toUpperCase(),
  path: r.path,
  public: r.access === 'public',
}))

/** Crea los handlers MSW del ERP. Comparten una base de datos en memoria (`resetErpDb()`). */
export function createErpHandlers(options: ErpHandlerOptions = {}): HttpHandler[] {
  return [...ERP_ROUTE_SPECS.flatMap((spec) => buildHandlers(spec, options)), ...buildFallbackHandlers(options)]
}

export type { ErpHandlerOptions, RouteSpec } from './http'
export { SAME_ORIGIN_API_PREFIX } from './http'
export { getErpDb, resetErpDb, type ErpDb } from './db'
export { mockAccessToken, type AuthContext } from './auth-context'
export { expireAccessTokens, REFRESH_COOKIE, resetSessions } from './sessions'
