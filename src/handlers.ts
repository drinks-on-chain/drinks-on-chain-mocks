// Entrada `@drinks-on-chain/mocks/handlers`: handlers MSW, escenarios, base en memoria y buzón
// simulado. Importa msw: no la uses desde código de producción.

export {
  advanceMockClock,
  BACKOFFICE_ROUTE_SPECS,
  CLIENT_APP_HEADER,
  createErpHandlers,
  createMockHandlers,
  ERP_ROUTE_SPECS,
  ERP_ROUTES,
  expireAccessTokens,
  expireRefreshGrace,
  getErpDb,
  getMockAppUrls,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  mockAccessToken,
  mockMailbox,
  MOCK_ROUTE_SPECS,
  PUBLIC_ROUTE_SPECS,
  COLLECTIONS_DRAFT_CONTRACT,
  PUBLIC_LOOKUP_LIMIT,
  PUBLIC_RATE_LIMIT,
  LOGIN_LOCK_POLICY,
  REFRESH_COOKIE,
  REFRESH_GRACE_SECONDS,
  resetErpDb,
  resetSessions,
  SAME_ORIGIN_API_PREFIX,
  setMockAppUrls,
} from './erp/handlers'
export type {
  AuthContext,
  BackofficeState,
  ErpDb,
  ErpHandlerOptions,
  MailboxFilter,
  MockHandlerOptions,
  RouteSpec,
} from './erp/handlers'
export {
  DATA_SCENARIOS,
  getScenario,
  isDataScenario,
  isScenarioName,
  resetScenario,
  RESPONSE_SCENARIOS,
  SCENARIO_DESCRIPTIONS,
  SCENARIO_QUERY_PARAM,
  SCENARIO_STORAGE_KEY,
  SCENARIOS,
  setScenario,
  SLOW_SCENARIO_DELAY_MS,
  type DataScenarioName,
  type LatencyOption,
  type ResponseScenarioName,
  type ScenarioName,
} from './shared/scenarios'
export { DEMO_NEW_PASSWORD, DEMO_PASSWORD, demoStaff, demoUsers, type DemoUser } from './erp/fixtures'
export { PASSPORT_CASES, SINGANI_CASE, type PassportCase } from './erp/trace/demo'
export { DEFAULT_APP_URLS, type AppUrls } from './backoffice/mail'
export { DEMO_TOTP_SECRET, generateTotp, MOCK_TOTP_BYPASS_CODE } from './shared/totp'
