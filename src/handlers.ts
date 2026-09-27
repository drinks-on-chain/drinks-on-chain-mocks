// Entrada `@drinks-on-chain/mocks/handlers`: handlers MSW, escenarios y base en memoria.
// Importa msw: no la uses desde código de producción.

export {
  createErpHandlers,
  ERP_ROUTE_SPECS,
  ERP_ROUTES,
  expireAccessTokens,
  getErpDb,
  mockAccessToken,
  REFRESH_COOKIE,
  resetErpDb,
  resetSessions,
  SAME_ORIGIN_API_PREFIX,
} from './erp/handlers'
export type { AuthContext, ErpDb, ErpHandlerOptions, RouteSpec } from './erp/handlers'
export {
  getScenario,
  isScenarioName,
  resetScenario,
  SCENARIO_DESCRIPTIONS,
  SCENARIO_QUERY_PARAM,
  SCENARIO_STORAGE_KEY,
  SCENARIOS,
  setScenario,
  SLOW_SCENARIO_DELAY_MS,
  type LatencyOption,
  type ScenarioName,
} from './shared/scenarios'
export { DEMO_PASSWORD, demoUsers, type DemoUser } from './erp/fixtures'
