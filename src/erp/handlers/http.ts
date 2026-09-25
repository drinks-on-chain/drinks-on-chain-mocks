import { delay, http, HttpResponse, type HttpHandler } from 'msw'
import type { z } from 'zod'
import type { ErrorEnvelope, SuccessEnvelope } from '../../shared/envelope'
import { DEFAULT_LIMIT, DEFAULT_OFFSET, toListPayload, type Paged } from '../../shared/list'
import {
  defaultLatency,
  getScenario,
  pickLatency,
  SLOW_SCENARIO_DELAY_MS,
  type LatencyOption,
} from '../../shared/scenarios'
import { checkAccess, readAuth, requireAuth, type AccessRule, type AuthContext } from './auth-context'
import { nowIso } from './db'
import { ApiError, badRequest, unauthorized, validationError } from './errors'

// Infraestructura común de los handlers: envoltorio, escenarios, latencia, sesión, roles,
// validación del cuerpo y paginación.

export interface ErpHandlerOptions {
  /**
   * Origen del backend que se intercepta, p. ej. `https://136.243.223.39.sslip.io`.
   * Por defecto cualquier origen (`*`). Con un origen concreto se añade además un 404 con
   * envoltorio para las rutas `/v1/*` desconocidas.
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
}

export interface RouteResult {
  status: number
  data: unknown
}

export interface RouteSpec {
  method: 'get' | 'post' | 'patch'
  /** Ruta con prefijo, p. ej. `/v1/terroirs/:id`. */
  path: string
  access: AccessRule | 'public'
  /** Lista afectada por el escenario `empty` (`paged` según LIST_SHAPE, `array` si el OpenAPI declara array). */
  list?: 'paged' | 'array'
  handle: (ctx: RouteContext) => RouteResult | Promise<RouteResult>
}

export const ok = (data: unknown, status = 200): RouteResult => ({ status, data })
export const created = (data: unknown): RouteResult => ({ status: 201, data })

function envelopePath(url: URL): string {
  return `${url.pathname}${url.search}`
}

function successResponse(url: URL, status: number, data: unknown) {
  const body: SuccessEnvelope<unknown> = { success: true, statusCode: status, timestamp: nowIso(), path: envelopePath(url), data }
  return HttpResponse.json(body, { status })
}

export function errorResponse(url: URL, error: ApiError) {
  const body: ErrorEnvelope = {
    success: false,
    statusCode: error.statusCode,
    timestamp: nowIso(),
    path: envelopePath(url),
    error: { code: error.code, message: error.message, details: error.details ?? null },
  }
  return HttpResponse.json(body, { status: error.statusCode })
}

function normalizeBase(baseUrl: string | undefined): string {
  if (!baseUrl || baseUrl === '*') return '*'
  return baseUrl.replace(/\/+$/, '')
}

async function applyLatency(latency: LatencyOption, extra: number) {
  const ms = pickLatency(latency) + extra
  if (ms > 0) await delay(ms)
}

export function buildHandler(spec: RouteSpec, options: ErpHandlerOptions = {}): HttpHandler {
  const base = normalizeBase(options.baseUrl)
  const latency = options.latency ?? defaultLatency()
  return http[spec.method](`${base}${spec.path}`, async ({ request, params }) => {
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
        const empty = spec.list === 'array' ? [] : toListPayload({ items: [], total: 0, ...pageParams(url.searchParams) })
        return successResponse(url, 200, empty)
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
      }
      const result = await spec.handle(ctx)
      return successResponse(url, result.status, result.data)
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(url, err)
      const message = err instanceof Error ? err.message : String(err)
      return errorResponse(url, new ApiError(500, 'INTERNAL_SERVER_ERROR', message))
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

/** 404 con envoltorio para rutas `/v1/*` sin handler (solo con `baseUrl` explícito). */
export function buildFallbackHandler(options: ErpHandlerOptions): HttpHandler | null {
  const base = normalizeBase(options.baseUrl)
  if (base === '*') return null
  return http.all(`${base}/v1/*`, ({ request }) => {
    const url = new URL(request.url)
    return errorResponse(url, new ApiError(404, 'NOT_FOUND', `Cannot ${request.method} ${envelopePath(url)}`))
  })
}

// ---------------------------------------------------------------------------
// Cuerpo y query
// ---------------------------------------------------------------------------

/** Lee y valida el cuerpo JSON con un esquema zod (400 como el backend). */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  return validate(await readJson(request), schema)
}

/** Valida un valor ya leído con un esquema zod (400 VALIDATION_ERROR). */
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

function queryError(message: string): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', 'Validation failed', [message])
}

export function pageParams(query: URLSearchParams): { limit: number; offset: number } {
  const limit = intParam(query, 'limit') ?? DEFAULT_LIMIT
  const offset = intParam(query, 'offset') ?? DEFAULT_OFFSET
  if (limit < 1) throw queryError('limit must not be less than 1')
  if (offset < 0) throw queryError('offset must not be less than 0')
  return { limit, offset }
}

export function intParam(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) throw queryError(`${name} must be an integer number`)
  return n
}

export function boolParam(query: URLSearchParams, name: string): boolean | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw queryError(`${name} must be a boolean value`)
}

export function enumParam<T extends string>(query: URLSearchParams, name: string, values: readonly T[]): T | undefined {
  const raw = query.get(name)
  if (raw === null || raw === '') return undefined
  if (!(values as readonly string[]).includes(raw)) throw queryError(`${name} must be one of the following values: ${values.join(', ')}`)
  return raw as T
}

export function strParam(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name)
  return raw === null || raw === '' ? undefined : raw
}

/** Recorta y envuelve una lista según LIST_SHAPE. */
export function listResult<T>(items: readonly T[], query: URLSearchParams): RouteResult {
  const { limit, offset } = pageParams(query)
  const page: Paged<T> = { items: items.slice(offset, offset + limit), total: items.length, limit, offset }
  return ok(toListPayload(page))
}

/** Asigna solo los campos presentes (no `undefined`) de un PATCH. */
export function applyPatch<T extends object>(target: T, patch: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value
  }
  return target
}
