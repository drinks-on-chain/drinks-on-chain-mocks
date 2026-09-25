import type { SetupWorker, StartOptions } from 'msw/browser'
import { createErpHandlers, type ErpHandlerOptions } from './erp/handlers'

// Entrada `@drinks-on-chain/mocks/browser`: arranca el Service Worker de MSW en la app.
// Requiere `public/mockServiceWorker.js` (`pnpm exec msw init public --save`).

export interface StartMockWorkerOptions extends ErpHandlerOptions {
  /** URL del script del worker. Por defecto `/mockServiceWorker.js`. */
  serviceWorkerUrl?: string
  /** Silencia los mensajes de MSW en la consola. */
  quiet?: boolean
  /** Qué hacer con peticiones sin handler. Por defecto `'bypass'`. */
  onUnhandledRequest?: StartOptions['onUnhandledRequest']
}

let starting: Promise<SetupWorker> | null = null

/**
 * Arranca (una sola vez) el worker con los handlers del ERP y resuelve cuando ya intercepta.
 * Llamadas repetidas devuelven la misma promesa.
 */
export function startMockWorker(options: StartMockWorkerOptions = {}): Promise<SetupWorker> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('startMockWorker solo puede ejecutarse en el navegador'))
  }
  starting ??= (async () => {
    const { setupWorker } = await import('msw/browser')
    const { serviceWorkerUrl, quiet, onUnhandledRequest, ...handlerOptions } = options
    const worker = setupWorker(...createErpHandlers(handlerOptions))
    await worker.start({
      serviceWorker: { url: serviceWorkerUrl ?? '/mockServiceWorker.js' },
      onUnhandledRequest: onUnhandledRequest ?? 'bypass',
      quiet: quiet ?? false,
    })
    return worker
  })()
  return starting
}

export { getScenario, resetScenario, setScenario, SCENARIOS, type ScenarioName } from './shared/scenarios'
export { resetErpDb } from './erp/handlers'
