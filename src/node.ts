import type { RequestHandler } from 'msw'
import { setupServer, type SetupServer } from 'msw/node'
import { createErpHandlers, type MockHandlerOptions } from './erp/handlers'

// Entrada `@drinks-on-chain/mocks/node`: servidor MSW para Vitest, Playwright o scripts.

export interface SetupMockServerOptions extends MockHandlerOptions {
  /** Handlers propios que se evalúan antes que los de los mocks. */
  extraHandlers?: RequestHandler[]
}

/**
 * Crea un servidor MSW con todos los handlers (ERP + Ola 1, sin latencia por defecto).
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

export {
  advanceMockClock,
  createErpHandlers,
  createMockHandlers,
  expireAccessTokens,
  expireRefreshGrace,
  getErpDb,
  mockAccessToken,
  mockChain,
  mockTokenization,
  mockMailbox,
  resetErpDb,
  resetSessions,
  setMockAppUrls,
} from './erp/handlers'
export { getScenario, resetScenario, setScenario, SCENARIOS, type ScenarioName } from './shared/scenarios'
export { DEMO_NEW_PASSWORD, DEMO_PASSWORD, demoStaff, demoUsers } from './erp/fixtures'
export { DEMO_TOTP_SECRET, generateTotp, MOCK_TOTP_BYPASS_CODE } from './shared/totp'
