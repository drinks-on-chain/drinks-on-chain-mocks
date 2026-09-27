import { delay, http, HttpResponse, type HttpHandler } from 'msw'
import type { z } from 'zod'
import type { ErrorEnvelope, SuccessEnvelope } from '../../shared/envelope'
import { DEFAULT_LIMIT, DEFAULT_OFFSET, MAX_LIMIT, type ListPage } from '../../shared/list'
import {
  defaultLatency,
  getScenario,
  pickLatency,
  SLOW_SCENARIO_DELAY_MS,
  type LatencyOption,
} from '../../shared/scenarios'
import { checkAccess, readAuth, requireAuth, type AccessRule, type AuthContext } from './auth-context'
import { nowIso } from './db'
import { ApiError, badRequest, fieldError, invalid, unauthorized, validationError } from './errors'

// Infraestructura común de los handlers: envoltorio, escenarios, latencia, sesión, roles,
// validación del cuerpo y paginación.
//
// Cada ruta responde en dos sitios (P-1, contrato de la Ola 0 §7):
//   `${baseUrl}/v1/...`  el backend directo (por defecto cualquier origen: `*/v1/...`)
//   `*/api/v1/...`       el proxy de la propia app (`/api/v1/*` de su origen → `${API_ORIGIN}/v1/*`)
// El `path` del envoltorio es siempre `/v1/...`, como lo ve el backend detrás del proxy.

/** Prefijo con el que las apps exponen la API en su propio origen (P-1). */
export const SAME_ORIGIN_API_PREFIX = '/api'

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
}

export interface RouteResult {
  status: number
  /** `undefined` con 204 (sin cuerpo). */
  data: unknown
  /** Cabeceras extra (p. ej. `Set-Cookie`). */
  headers?: Record<string, string>
}

export interface RouteSpec {
  method: 'get' | 'post' | 'patch'
  /** Ruta con prefijo, p. ej. `/v1/terroirs/:id`. */
  path: string
  access: AccessRule | 'public'
  /** Colección (`{ items, total, limit, offset }`): la vacía el escenario `empty`. */
  list?: 'paged'
  handle: (ctx: RouteContext) => RouteResult | Promise<RouteResult>
}

export const ok = (data: unknown, status = 200): RouteResult => ({ status, data })
export const created = (data: unknown): RouteResult => ({ status: 201, data })
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
function correlationHeaders(request: Request | undefined): Record<string, string> {
  const incoming = request?.headers.get('x-correlation-id')
  return { 'X-Correlation-ID': incoming || `mock-${++correlationSeq}` }
}

function successResponse(request: Request, url: URL, result: RouteResult) {
  const headers = { ...correlationHeaders(request), ...result.headers }
  if (result.status === 204) return new HttpResponse(null, { status: 204, headers })
  const body: SuccessEnvelope<unknown> = {
    success: true,
    statusCode: result.status,
    timestamp: nowIso(),
    path: envelopePath(url),
    data: result.data,
  }
  return HttpResponse.json(body, { status: result.status, headers })
}

export function errorResponse(url: URL, error: ApiError, request?: Request) {
  const body: ErrorEnvelope = {
    success: false,
    statusCode: error.statusCode,
    timestamp: nowIso(),
    path: envelopePath(url),
    error: { code: error.code, message: error.message, details: error.details ?? null },
  }
  return HttpResponse.json(body, { status: error.statusCode, headers: correlationHeaders(request) })
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

function buildHandlerFor(pattern: string, spec: RouteSpec, options: ErpHandlerOptions): HttpHandler {
  const latency = options.latency ?? defaultLatency()
  return http[spec.method](pattern, async ({ request, params, cookies }) => {
    const url = new URL(request.url)
    const scenario = getScenario()
    if (scenario === 'offline') return HttpResponse.error()
    await applyLatency(latency, scenario === 'slow' ? SLOW_SCENARIO_DELAY_MS : 0)
    try {
      if (scenario === 'error' && !spec.path.startsWith('/v1/auth/')) {
        throw new ApiError(500, 'INTERNAL_SERVER_ERROR', 'Error interno del servidor (escenario de prueba "error")')
      }
      let session: AuthContext | null
      if (spec.access === 'public') {
        session = readAuthOrNull(request)
      } else {
        session = requireAuth(request)
        checkAccess(session, spec.access)
      }
      if (scenario === 'empty' && spec.list) {
        const empty: ListPage<never> = { items: [], total: 0, ...pageParams(url.searchParams) }
        return successResponse(request, url, ok(empty))
      }
      const ctx: RouteContext = {
        request,
        url,
        query: url.searchParams,
        params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        get auth() {
          if (!session) throw unauthorized()
          return session
        },
        optionalAuth: session,
        cookies: { ...cookies },
      }
      const result = await spec.handle(ctx)
      return successResponse(request, url, result)
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(url, err, request)
      const message = err instanceof Error ? err.message : String(err)
      return errorResponse(url, new ApiError(500, 'INTERNAL_SERVER_ERROR', message), request)
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

/** Valida un valor ya leído con un esquema zod (422 VALIDATION_ERROR). */
export function validate<S extends z.ZodType>(raw: unknown, schema: S): z.infer<S> {
  const result = schema.safeParse(raw)
  if (!result.success) throw validationError(result.error.issues)
  return result.data
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'JSON inválido')
  }
}

function queryError(field: string, message: string): ApiError {
  return invalid([fieldError(field, message)])
}

/** `limit` (1–100, por defecto 20) y `offset` (≥ 0); fuera de rango → 422. */
export function pageParams(query: URLSearchParams): { limit: number; offset: number } {
  const limit = intParam(query, 'limit') ?? DEFAULT_LIMIT
  const offset = intParam(query, 'offset') ?? DEFAULT_OFFSET
  if (limit < 1) throw queryError('limit', 'limit must not be less than 1')
  if (limit > MAX_LIMIT) throw queryError('limit', `limit must not be greater than ${MAX_LIMIT}`)
  if (offset < 0) throw queryError('offset', 'offset must not be less than 0')
  return { limit, offset }
}

export function intParam(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) throw queryError(name, `${name} must be an integer number`)
  return n
}

export function boolParam(query: URLSearchParams, name: string): boolean | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw queryError(name, `${name} must be a boolean value`)
}

export function enumParam<T extends string>(query: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (!(values as readonly string[]).includes(raw)) {
    throw queryError(name, `${name} must be one of the following values: ${values.join(', ')}`)
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
