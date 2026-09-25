import type { HttpHandler } from 'msw'
import { buildFallbackHandler, buildHandler, type ErpHandlerOptions, type RouteSpec } from './http'
import { authUserRoutes } from './routes/auth-users'
import { bottlingLabRoutes } from './routes/bottling-lab'
import { terroirHarvestRoutes } from './routes/terroirs-harvest'
import { traceabilitySystemRoutes } from './routes/traceability-system'
import { wineryRoutes } from './routes/wineries'
import { winemakingRoutes } from './routes/winemaking'

// Handlers MSW del ERP: las 36 rutas del OpenAPI (35 de negocio + /v1/health).

const routes: RouteSpec[] = [
  ...authUserRoutes,
  ...wineryRoutes,
  ...terroirHarvestRoutes,
  ...winemakingRoutes,
  ...bottlingLabRoutes,
  ...traceabilitySystemRoutes,
]

/** Rutas simuladas (método en mayúsculas y ruta con `:param`), p. ej. para un panel de desarrollo. */
export const ERP_ROUTES: ReadonlyArray<{ method: string; path: string; public: boolean }> = routes.map((r) => ({
  method: r.method.toUpperCase(),
  path: r.path,
  public: r.access === 'public',
}))

/** Crea los handlers MSW del ERP. Comparten una base de datos en memoria (`resetErpDb()`). */
export function createErpHandlers(options: ErpHandlerOptions = {}): HttpHandler[] {
  const handlers = routes.map((spec) => buildHandler(spec, options))
  const fallback = buildFallbackHandler(options)
  return fallback ? [...handlers, fallback] : handlers
}

export type { ErpHandlerOptions } from './http'
export { getErpDb, resetErpDb, type ErpDb } from './db'
export { mockAccessToken, type AuthContext } from './auth-context'
