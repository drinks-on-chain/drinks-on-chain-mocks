import type { SetupWorker, StartOptions } from 'msw/browser'
import { advanceMockClock, createErpHandlers, mockChain, mockMailbox, resetErpDb, type MockChain, type MockHandlerOptions } from './erp/handlers'
import { getScenario, setScenario } from './shared/scenarios'

// Entrada `@drinks-on-chain/mocks/browser`: arranca el Service Worker de MSW en la app.
// Requiere `public/mockServiceWorker.js` (`pnpm exec msw init public --save`).

export interface StartMockWorkerOptions extends MockHandlerOptions {
  /** URL del script del worker. Por defecto `/mockServiceWorker.js`. */
  serviceWorkerUrl?: string
  /** Silencia los mensajes de MSW en la consola. */
  quiet?: boolean
  /** Qué hacer con peticiones sin handler. Por defecto `'bypass'`. */
  onUnhandledRequest?: StartOptions['onUnhandledRequest']
  /**
   * Publica `window.__docMocks` (buzón, reinicio, reloj y escenario) para el panel `/__mocks` y las
   * e2e (`page.evaluate(() => window.__docMocks.mailbox.latest({ to }))`). Por defecto `true`.
   */
  exposeGlobal?: boolean
}

/** Lo que `startMockWorker` publica en `window.__docMocks`. */
export interface DocMocksGlobal {
  mailbox: typeof mockMailbox
  reset: typeof resetErpDb
  advanceClock: typeof advanceMockClock
  getScenario: typeof getScenario
  setScenario: typeof setScenario
  /** Red simulada de la Ola 3: `advance()`, `settle()`, `failNext()`, `setMode()`, `pending()`. */
  chain: MockChain
}

let starting: Promise<SetupWorker> | null = null

/**
 * Arranca (una sola vez) el worker con todos los handlers y resuelve cuando ya intercepta.
 * Llamadas repetidas devuelven la misma promesa.
 */
export function startMockWorker(options: StartMockWorkerOptions = {}): Promise<SetupWorker> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('startMockWorker solo puede ejecutarse en el navegador'))
  }
  // `?mock=<escenario>` se lee ya, antes de cualquier navegación: así queda guardado aunque la
  // primera petición llegue desde otra página sin el parámetro.
  getScenario()
  starting ??= (async () => {
    const { setupWorker } = await import('msw/browser')
    const { serviceWorkerUrl, quiet, onUnhandledRequest, exposeGlobal, ...handlerOptions } = options
    const worker = setupWorker(...createErpHandlers(handlerOptions))
    await worker.start({
      serviceWorker: { url: serviceWorkerUrl ?? '/mockServiceWorker.js' },
      onUnhandledRequest: onUnhandledRequest ?? 'bypass',
      quiet: quiet ?? false,
    })
    if (exposeGlobal !== false) {
      const api: DocMocksGlobal = { mailbox: mockMailbox, reset: resetErpDb, advanceClock: advanceMockClock, getScenario, setScenario, chain: mockChain }
      ;(window as unknown as { __docMocks?: DocMocksGlobal }).__docMocks = api
    }
    return worker
  })()
  return starting
}

export { getScenario, resetScenario, setScenario, SCENARIOS, type ScenarioName } from './shared/scenarios'
export {
  advanceMockClock,
  expireAccessTokens,
  expireRefreshGrace,
  getMockAppUrls,
  mockChain,
  mockMailbox,
  resetErpDb,
  resetSessions,
  setMockAppUrls,
} from './erp/handlers'
export { DEMO_NEW_PASSWORD, DEMO_PASSWORD, demoStaff, demoUsers, type DemoUser } from './erp/fixtures'
export { DEMO_TOTP_SECRET, generateTotp, MOCK_TOTP_BYPASS_CODE } from './shared/totp'
