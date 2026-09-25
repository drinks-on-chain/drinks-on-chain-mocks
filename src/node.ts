import type { RequestHandler } from 'msw'
import { setupServer, type SetupServer } from 'msw/node'
import { createErpHandlers, type ErpHandlerOptions } from './erp/handlers'

// Entrada `@drinks-on-chain/mocks/node`: servidor MSW para Vitest, Playwright o scripts.

export interface SetupMockServerOptions extends ErpHandlerOptions {
  /** Handlers propios que se evalúan antes que los del ERP. */
  extraHandlers?: RequestHandler[]
}

/**
 * Crea un servidor MSW con los handlers del ERP (sin latencia por defecto).
 *
 *   const server = setupMockServer()
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
 *   afterEach(() => { server.resetHandlers(); resetErpDb() })
 *   afterAll(() => server.close())
 */
export function setupMockServer(options: SetupMockServerOptions = {}): SetupServer {
  const { extraHandlers = [], ...handlerOptions } = options
  return setupServer(...extraHandlers, ...createErpHandlers({ latency: 0, ...handlerOptions }))
}

export { createErpHandlers, getErpDb, mockAccessToken, resetErpDb } from './erp/handlers'
export { getScenario, resetScenario, setScenario, SCENARIOS, type ScenarioName } from './shared/scenarios'
export { demoUsers, DEMO_PASSWORD } from './erp/fixtures'
