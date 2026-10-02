import { delay, http, HttpResponse, type HttpHandler } from 'msw'
import type { z } from 'zod'
import { canonicalJson, sha256Hex } from '../../shared/crypto'
import type { ErrorEnvelope, SuccessEnvelope } from '../../shared/envelope'
import { DEFAULT_LIMIT, DEFAULT_OFFSET, MAX_LIMIT, type ListPage } from '../../shared/list'
import {
  defaultLatency,
  getScenario,
  pickLatency,
  SLOW_SCENARIO_DELAY_MS,
  type LatencyOption,
} from '../../shared/scenarios'
import type { CertificationStatus } from '../schemas'
import { checkAccess, checkOrgActive, readAuth, requireAuth, resolveTenant, type AccessRule, type AuthContext } from './auth-context'
import { nowIso, persistErpDb } from './db'
import { ApiError, badRequest, fieldError, invalid, tokenInvalid, validationError } from './errors'
import { backupTrace, restoreTrace, runDailyTasks, syncDataScenario } from './trace-context'
import { spanishErrorMap } from './zod-es'

// Infraestructura común de los handlers: envoltorio, escenarios, latencia, sesión, roles,
// bodega activa, idempotencia, validación del cuerpo y paginación.
//
// Cada ruta responde en dos sitios (P-1, contrato de la Ola 0 §7):
//   `${baseUrl}/v1/...`  el backend directo (por defecto cualquier origen: `*/v1/...`)
//   `*/api/v1/...`       el proxy de la propia app (`/api/v1/*` de su origen → `${API_ORIGIN}/v1/*`)
// El `path` del envoltorio es siempre `/v1/...`, como lo ve el backend detrás del proxy.

/** Prefijo con el que las apps exponen la API en su propio origen (P-1). */
export const SAME_ORIGIN_API_PREFIX = '/api'

/** Cabecera con la que cada app se identifica en la bitácora (contrato de la Ola 1 §7). */
export const CLIENT_APP_HEADER = 'x-client-app'

/** Cabecera de idempotencia (contrato de la Ola 0 §3) y la de las respuestas repetidas. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed'

export interface ErpHandlerOptions {
  /**
   * Origen del backend que se intercepta, p. ej. `https://136.243.223.39.sslip.io` (se toleran
   * la barra final y un `/v1` final). Por defecto cualquier origen (`*`). Con un origen
   * concreto se añade además un 404 con envoltorio para las rutas `/v1/*` desconocidas.
   * En ambos casos se atiende también `/api/v1/*` de cualquier origen (P-1).
   */
  baseUrl?: string
  /** Latencia simulada. Por defecto 200–400 ms en el navegador y 0 en Node. */
  latency?: LatencyOption
}

export interface RouteContext {
  request: Request
  url: URL
  query: URLSearchParams
  params: Record<string, string>
  /** Sesión (en rutas públicas lanza 401 si no hay token). */
  auth: AuthContext
  /** Sesión opcional (rutas públicas). */
  optionalAuth: AuthContext | null
  /** Cookies de la petición (cabecera `Cookie`, almacén de MSW y `document.cookie`). */
  cookies: Record<string, string>
  /** `X-Correlation-ID` de la petición o el generado para la respuesta. */
  correlationId: string
  /** Valor de la cabecera `X-Client-App` (`ERP`, `BACKOFFICE`…) o `null`. */
  clientApp: string | null
  /** ¿Es una ruta pública? */
  isPublic: boolean
}

export interface RouteResult {
  status: number
  /** `undefined` con 204 (sin cuerpo). */
  data: unknown
  /** Cabeceras extra (p. ej. `Set-Cookie`). */
  headers?: Record<string, string>
  /** Respuesta sin envoltorio (p. ej. `text/csv` de la exportación de la bitácora). */
  raw?: { body: string; contentType: string }
}

export interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'put'
  /** Ruta con prefijo, p. ej. `/v1/terroirs/:id`. */
  path: string
  access: AccessRule | 'public'
  /** Colección (`{ items, total, limit, offset }`): la vacía el escenario `empty`. */
  list?: 'paged'
  /**
   * Estados de la bodega activa en los que la ruta sigue permitida (por defecto solo `ACTIVE`;
   * el resto → 403 `ORG_NOT_ACTIVE`). Solo aplica a las reglas de bodega.
   */
  allowInactiveOrg?: readonly CertificationStatus[]
  /** Acepta `Idempotency-Key` (los 9 POST de alta del ERP, contrato de la Ola 0 §3). */
  idempotent?: boolean
  handle: (ctx: RouteContext) => RouteResult | Promise<RouteResult>
  /** Se ejecuta tras una respuesta 2xx (p. ej. la bitácora de las escrituras del ERP). */
  afterSuccess?: (ctx: RouteContext, result: RouteResult) => void
  /**
   * Ruta obsoleta que se retira en H1 (contrato de la Ola 1 §11): la ruta que la sustituye. Como el
   * backend, sigue funcionando y responde `Deprecation: true` y `Link: <sustituta>; rel="successor-version"`.
   */
  deprecated?: string
  /**
   * Ruta en BORRADOR que no está en el OpenAPI del backend (su valor es el contrato que la adelanta,
   * p. ej. el catálogo del contrato de la Ola 2 §17.1). Responde `X-Mock-Draft` con esa referencia
   * y la prueba de contrato la valida solo contra el esquema zod de los mocks.
   */
  draft?: string
}

/** Cabeceras de una ruta obsoleta (`DeprecatedRoute` del backend). */
export function deprecationHeaders(replacement: string): Record<string, string> {
  return { Deprecation: 'true', Link: `<${replacement}>; rel="successor-version"` }
}

export const ok = (data: unknown, status = 200): RouteResult => ({ status, data })
export const created = (data: unknown): RouteResult => ({ status: 201, data })
export const accepted = (data: unknown = null): RouteResult => ({ status: 202, data })
export const noContent = (headers?: Record<string, string>): RouteResult => ({ status: 204, data: undefined, headers })

/** `path` del envoltorio: el que ve el backend (sin el prefijo `/api` del proxy de la app). */
export function envelopePath(url: URL): string {
  const pathname = url.pathname.startsWith(`${SAME_ORIGIN_API_PREFIX}/v1/`)
    ? url.pathname.slice(SAME_ORIGIN_API_PREFIX.length)
    : url.pathname
  return `${pathname}${url.search}`
}

let correlationSeq = 0

/** `X-Correlation-ID`: el de la petición o uno nuevo (contrato de la Ola 0 §3). */
function correlationIdOf(request: Request | undefined): string {
  return request?.headers.get('x-correlation-id') || `mock-${++correlationSeq}`
}

function successResponse(request: Request, url: URL, result: RouteResult, correlationId = correlationIdOf(request)) {
  const headers = { 'X-Correlation-ID': correlationId, ...result.headers }
  // 204 sin cuerpo y redirecciones (302 a la URL firmada de un adjunto público).
  if (result.status === 204 || (result.status >= 300 && result.status < 400)) return new HttpResponse(null, { status: result.status, headers })
  if (result.raw) {
    return new HttpResponse(result.raw.body, { status: result.status, headers: { ...headers, 'Content-Type': result.raw.contentType } })
  }
  const body: SuccessEnvelope<unknown> = {
    success: true,
    statusCode: result.status,
    timestamp: nowIso(),
    path: envelopePath(url),
    data: result.data,
  }
  return HttpResponse.json(body, { status: result.status, headers })
}

export function errorResponse(url: URL, error: ApiError, request?: Request, correlationId = correlationIdOf(request)) {
  const body: ErrorEnvelope = {
    success: false,
    statusCode: error.statusCode,
    timestamp: nowIso(),
    path: envelopePath(url),
    error: { code: error.code, message: error.message, details: error.details ?? null },
  }
  return HttpResponse.json(body, { status: error.statusCode, headers: { 'X-Correlation-ID': correlationId, ...error.headers } })
}

/** Origen normalizado: `*`, o la URL sin barra final ni `/v1` final. */
export function normalizeBase(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim()
  if (!trimmed || trimmed === '*') return '*'
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** Patrones MSW de una ruta `/v1/...`: el backend directo y el proxy `/api/v1/...` de la app. */
export function routePatterns(base: string, path: string): string[] {
  // `*/v1/...` ya cubre `…/api/v1/...` de cualquier origen.
  if (base === '*') return [`*${path}`]
  const direct = `${base}${path}`
  const proxied = `*${SAME_ORIGIN_API_PREFIX}${path}`
  return direct === proxied ? [direct] : [direct, proxied]
}

async function applyLatency(latency: LatencyOption, extra: number) {
  const ms = pickLatency(latency) + extra
  if (ms > 0) await delay(ms)
}

export function buildHandlers(spec: RouteSpec, options: ErpHandlerOptions = {}): HttpHandler[] {
  const base = normalizeBase(options.baseUrl)
  return routePatterns(base, spec.path).map((pattern) => buildHandlerFor(pattern, spec, options))
}

// ---------------------------------------------------------------------------
// Idempotency-Key (contrato de la Ola 0 §3; comportamiento del backend O0-BE-2)
// ---------------------------------------------------------------------------

interface IdempotentRecord {
  fingerprint: string
  status: number
  data: unknown
  headers?: Record<string, string>
}
/** Respuestas guardadas por persona + método y ruta + clave (en memoria, como Redis con TTL de 24 h). */
const idempotencyStore = new Map<string, IdempotentRecord>()

/** Borra las respuestas idempotentes guardadas (lo llama `resetErpDb` a través de `resetMocks`). */
export function resetIdempotency(): void {
  idempotencyStore.clear()
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function idempotencyKeyOf(request: Request, url: URL, auth: AuthContext | null): Promise<{ key: string; fingerprint: string } | null> {
  const raw = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim()
  if (!raw) return null
  if (!UUID_RE.test(raw)) {
    throw new ApiError(422, 'IDEMPOTENCY_KEY_INVALID', `${IDEMPOTENCY_KEY_HEADER} no válida`, [
      fieldError(IDEMPOTENCY_KEY_HEADER, `${IDEMPOTENCY_KEY_HEADER} debe ser un UUID`),
    ])
  }
  const text = await request.clone().text()
  const body = parseLoose(text)
  const route = `${request.method.toUpperCase()} ${envelopePath(new URL(url.pathname, url.origin))}`
  return { key: [auth?.user.id ?? 'anonymous', route, raw.toLowerCase()].join('|'), fingerprint: sha256Hex(canonicalJson(body)) }
}

/** JSON del cuerpo o el texto tal cual (huella de la idempotencia). */
function parseLoose(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function buildHandlerFor(pattern: string, spec: RouteSpec, options: ErpHandlerOptions): HttpHandler {
  const latency = options.latency ?? defaultLatency()
  return http[spec.method](pattern, async ({ request, params, cookies }) => {
    const url = new URL(request.url)
    const scenario = getScenario()
    if (scenario === 'offline') return HttpResponse.error()
    await applyLatency(latency, scenario === 'slow' ? SLOW_SCENARIO_DELAY_MS : 0)
    const correlationId = correlationIdOf(request)
    const writes = spec.method !== 'get'
    // Ola 2: escenario de datos activo, tarea diaria de los candados y copia de la trazabilidad
    // para deshacer una escritura que falle a medias (como la transacción del backend).
    syncDataScenario()
    runDailyTasks()
    const backup = writes ? backupTrace() : null
    try {
      if (scenario === 'error' && !spec.path.startsWith('/v1/auth/')) {
        throw new ApiError(500, 'INTERNAL_ERROR', 'Error interno del servidor (escenario de prueba "error")')
      }
      let session: AuthContext | null
      if (spec.access === 'public') {
        session = readAuthOrNull(request)
      } else {
        session = requireAuth(request)
        checkAccess(session, spec.access, request.method)
        checkOrgActive(session, spec.access, spec.allowInactiveOrg)
        if (spec.access.kind === 'winery') {
          const body = writes ? parseLoose(await request.clone().text()) : null
          session = resolveTenant(session, request.method, url.searchParams, body)
        }
      }
      if (scenario === 'empty' && spec.list) {
        const empty: ListPage<never> = { items: [], total: 0, ...pageParams(url.searchParams) }
        return successResponse(request, url, ok(empty), correlationId)
      }
      const idem = spec.idempotent ? await idempotencyKeyOf(request, url, session) : null
      if (idem) {
        const saved = idempotencyStore.get(idem.key)
        if (saved && saved.fingerprint !== idem.fingerprint) {
          throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', `La ${IDEMPOTENCY_KEY_HEADER} ya se usó con otro cuerpo`)
        }
        if (saved) {
          const replay: RouteResult = { status: saved.status, data: saved.data, headers: { ...saved.headers, [IDEMPOTENT_REPLAYED_HEADER]: 'true' } }
          return successResponse(request, url, replay, correlationId)
        }
      }
      const ctx: RouteContext = {
        request,
        url,
        query: url.searchParams,
        params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        get auth() {
          if (!session) throw tokenInvalid('Token de acceso ausente')
          return session
        },
        optionalAuth: session,
        cookies: { ...cookies },
        correlationId,
        clientApp: request.headers.get(CLIENT_APP_HEADER),
        isPublic: spec.access === 'public',
      }
      const result = await spec.handle(ctx)
      if (idem) {
        idempotencyStore.set(idem.key, {
          fingerprint: idem.fingerprint,
          status: result.status,
          data: JSON.parse(JSON.stringify(result.data ?? null)) as unknown,
          headers: result.headers,
        })
      }
      spec.afterSuccess?.(ctx, result)
      if (writes) persistErpDb()
      const extra = { ...(spec.deprecated ? deprecationHeaders(spec.deprecated) : {}), ...(spec.draft ? { 'X-Mock-Draft': spec.draft } : {}) }
      return successResponse(request, url, Object.keys(extra).length > 0 ? { ...result, headers: { ...result.headers, ...extra } } : result, correlationId)
    } catch (err) {
      if (backup) restoreTrace(backup)
      // Las escrituras fallidas también pueden dejar rastro (bitácora de intentos, retos TOTP).
      if (writes) persistErpDb()
      const error = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
      if (spec.deprecated) Object.assign(error.headers, deprecationHeaders(spec.deprecated))
      return errorResponse(url, error, request, correlationId)
    }
  })
}

/** En rutas públicas un token inválido se ignora (como el backend). */
function readAuthOrNull(request: Request): AuthContext | null {
  try {
    return readAuth(request)
  } catch {
    return null
  }
}

/** 404 con envoltorio para rutas `/v1/*` (y `/api/v1/*`) sin handler (solo con `baseUrl` explícito). */
export function buildFallbackHandlers(options: ErpHandlerOptions): HttpHandler[] {
  const base = normalizeBase(options.baseUrl)
  if (base === '*') return []
  return routePatterns(base, '/v1/*').map((pattern) =>
    http.all(pattern, ({ request }) => {
      const url = new URL(request.url)
      return errorResponse(url, new ApiError(404, 'NOT_FOUND', `Cannot ${request.method} ${envelopePath(url)}`), request)
    }),
  )
}

// ---------------------------------------------------------------------------
// Cuerpo y query
// ---------------------------------------------------------------------------

/** Lee y valida el cuerpo JSON con un esquema zod (422 VALIDATION_ERROR con los campos). */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  return validate(await readJson(request), schema)
}

/**
 * Cuerpo de un alta (`Create*`): como el backend (`@IsOptional()` de class-validator), un
 * `null` en un campo opcional cuenta como omitido. Los esquemas `Create*` no lo declaran.
 */
export async function parseCreateBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  return validate(omitNulls(await readJson(request)), schema)
}

/** Quita las claves de primer nivel con valor `null` (altas: `null` = omitido). */
export function omitNulls(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null))
}

/** Valida un valor ya leído con un esquema zod (422 VALIDATION_ERROR, mensajes en español). */
export function validate<S extends z.ZodType>(raw: unknown, schema: S): z.infer<S> {
  const result = schema.safeParse(raw, { error: spanishErrorMap })
  if (!result.success) throw validationError(result.error.issues)
  return result.data
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw badRequest(`El cuerpo no es un JSON válido${err instanceof Error ? `: ${err.message}` : ''}`)
  }
}

function queryError(field: string, message: string): ApiError {
  return invalid([fieldError(field, message)])
}

/** `limit` (1–100, por defecto 20) y `offset` (≥ 0); fuera de rango → 422. */
export function pageParams(query: URLSearchParams): { limit: number; offset: number } {
  const limit = intParam(query, 'limit') ?? DEFAULT_LIMIT
  const offset = intParam(query, 'offset') ?? DEFAULT_OFFSET
  if (limit < 1) throw queryError('limit', 'limit no puede ser menor que 1')
  if (limit > MAX_LIMIT) throw queryError('limit', `limit no puede ser mayor que ${MAX_LIMIT}`)
  if (offset < 0) throw queryError('offset', 'offset no puede ser menor que 0')
  return { limit, offset }
}

export function intParam(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) throw queryError(name, `${name} debe ser un número entero`)
  return n
}

export function boolParam(query: URLSearchParams, name: string): boolean | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw queryError(name, `${name} debe ser true o false`)
}

export function enumParam<T extends string>(query: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (!(values as readonly string[]).includes(raw)) {
    throw queryError(name, `${name} debe ser uno de estos valores: ${values.join(', ')}`)
  }
  return raw as T
}

export function strParam(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name)
  return raw === null || raw === '' ? undefined : raw
}

/** Recorta una colección y la devuelve como `{ items, total, limit, offset }`. */
export function listResult<T>(items: readonly T[], query: URLSearchParams): RouteResult {
  const { limit, offset } = pageParams(query)
  const page: ListPage<T> = { items: items.slice(offset, offset + limit), total: items.length, limit, offset }
  return ok(page)
}

/** Asigna solo los campos presentes (no `undefined`) de un PATCH. */
export function applyPatch<T extends object>(target: T, patch: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value
  }
  return target
}
