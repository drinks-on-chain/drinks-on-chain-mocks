import { platform } from '../../erp/handlers/auth-context'
import { newId, persistErpDb } from '../../erp/handlers/db'
import { ApiError, domainError, fieldError, invalid, notFound } from '../../erp/handlers/errors'
import { created, enumParam, listResult, ok, parseBody, strParam, type RouteContext, type RouteResult, type RouteSpec } from '../../erp/handlers/http'
import { platformRolesWith } from '../permissions'
import {
  UpdateWaitlistEntrySchema,
  WAITLIST_CSV_COLUMNS,
  WAITLIST_EMAIL_LIMIT_PER_HOUR,
  WAITLIST_EXPORT_MAX_ROWS,
  WAITLIST_RESOURCE_TYPE,
  WAITLIST_STATUSES,
  WAITLIST_TYPES,
  WaitlistJoinRequestSchema,
  type WaitlistEntry,
  type WaitlistJoinResponse,
  type WaitlistSource,
  type WaitlistStats,
  type WaitlistType,
} from '../schemas'
import { dateParam } from './audit'
import { bo, checkCaptcha, now, recordAudit, stamp } from './support'

// Lista de espera (plan/contratos/o1b-lista-de-espera.md), como el backend v0.1.1
// (`src/modules/waitlist`): inscripción pública con campo trampa y límite por correo, y gestión
// desde el back office (lista, orígenes, estado y notas, exportación CSV). Todo queda en la bitácora.

/** Lectura: los roles de plataforma con `FULL` o `READ` en la capacidad `waitlist`. */
const READERS = platform(platformRolesWith('waitlist', 'FULL', 'READ'))
/** Estado, notas y exportación: solo `FULL` (soporte no). */
const WRITERS = platform(platformRolesWith('waitlist', 'FULL'))

const HOUR_MS = 3_600_000

const entries = (): WaitlistEntry[] => bo().waitlist

/** Última posición entregada de un tipo (el contador por tipo del backend). */
function lastPosition(type: WaitlistType): number {
  return entries().reduce((max, e) => (e.type === type && e.position > max ? e.position : max), 0)
}

/**
 * Límite por correo (3 por hora; ventana fija desde la primera inscripción, hora real como el
 * bloqueo del login): por encima → 429 `TOO_MANY_REQUESTS` con `Retry-After`. Los límites por IP
 * del backend no se simulan.
 */
function checkEmailLimit(email: string): void {
  const state = bo()
  const attempts = (state.waitlistAttempts ??= {})
  const at = Date.now()
  let hit = attempts[email]
  if (!hit || at - hit.firstAt >= HOUR_MS) hit = { count: 0, firstAt: at }
  hit.count += 1
  attempts[email] = hit
  if (hit.count > WAITLIST_EMAIL_LIMIT_PER_HOUR) {
    const retryAfter = Math.max(1, Math.ceil((hit.firstAt + HOUR_MS - at) / 1000))
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Ya recibimos varias inscripciones con este correo: vuelve a intentarlo más tarde', null, {
      'Retry-After': String(retryAfter),
    })
  }
}

/** Totales por tipo (`GET /v1/public/waitlist/stats`). */
export function waitlistStats(): WaitlistStats {
  const count = (type: WaitlistType) => entries().filter((e) => e.type === type).length
  return { consumers: count('CONSUMER'), wineries: count('WINERY') }
}

// ---------------------------------------------------------------------------
// Filtros de la lista y de la exportación
// ---------------------------------------------------------------------------

function filterEntries(query: URLSearchParams): WaitlistEntry[] {
  const type = enumParam(query, 'type', WAITLIST_TYPES)
  const status = enumParam(query, 'status', WAITLIST_STATUSES)
  const source = strParam(query, 'source')?.trim().toLowerCase()
  const q = strParam(query, 'q')?.trim()
  const problems = [
    ...(source && source.length > 40 ? [fieldError('source', 'source admite hasta 40 caracteres')] : []),
    ...(q && q.length > 200 ? [fieldError('q', 'q admite hasta 200 caracteres')] : []),
  ]
  if (problems.length) throw invalid(problems)
  const from = dateParam(query, 'from')
  const to = dateParam(query, 'to')
  const needle = q?.toLowerCase()
  return entries().filter((e) => {
    const createdAt = Date.parse(e.createdAt)
    return (
      (!type || e.type === type) &&
      (!status || e.status === status) &&
      (!source || e.source === source) &&
      (from === undefined || createdAt >= from) &&
      (to === undefined || createdAt <= to) &&
      (!needle ||
        [e.fullName, e.email, e.wineryName].some((v) => v?.toLowerCase().includes(needle)) ||
        Boolean(e.phone?.includes(q!)))
    )
  })
}

/** Más reciente primero (desempate por id). */
const byNewest = (a: WaitlistEntry, b: WaitlistEntry) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
/** Orden de llegada (exportación). */
const byArrival = (a: WaitlistEntry, b: WaitlistEntry) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** BOM UTF-8: Excel abre el archivo con tildes y eñes bien. */
export const CSV_BOM = '﻿'
const CSV_EOL = '\r\n'
/** Inicio de celda que una hoja de cálculo interpretaría como fórmula (inyección de fórmulas). */
const FORMULA_START = /^[=+\-@\t\r]/

/** Celda segura: un apóstrofo delante de lo que parece una fórmula y comillas si hace falta. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : String(value)
  if (FORMULA_START.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * CSV de la lista de espera como el del backend: UTF-8 con BOM, separador coma, CRLF, celdas
 * protegidas contra fórmulas. Columnas = claves de `WaitlistEntry` sin `id` (ni IP ni agente de usuario).
 */
export function waitlistCsv(rows: readonly WaitlistEntry[]): string {
  const lines = rows.map((e) => WAITLIST_CSV_COLUMNS.map((column) => csvCell(e[column])).join(','))
  return CSV_BOM + [WAITLIST_CSV_COLUMNS.join(','), ...lines].join(CSV_EOL) + CSV_EOL
}

/** Nombre del archivo: `lista-de-espera-20260925-1200.csv` (UTC, reloj de los mocks). */
export function waitlistExportFilename(iso: string): string {
  return `lista-de-espera-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 13)}${iso.slice(14, 16)}.csv`
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

async function join(ctx: RouteContext): Promise<RouteResult> {
  const body = await parseBody(ctx.request, WaitlistJoinRequestSchema)
  // El backend solo comprueba el captcha con `WAITLIST_CAPTCHA_REQUIRED=true`; aquí, si llega.
  if (body.captchaToken) checkCaptcha(body.captchaToken)
  const type = body.type
  const reply = (position: number) => created({ type, position } satisfies WaitlistJoinResponse)
  // Campo trampa relleno: 201 con una posición verosímil, sin guardar nada.
  if (body.website?.trim()) return reply(lastPosition(type) + 1)
  checkEmailLimit(body.email)
  const existing = entries().find((e) => e.type === type && e.email === body.email)
  if (existing) {
    // Ya inscrito en ese tipo: misma respuesta con su posición. Los datos nuevos no pisan los
    // anteriores; solo completan teléfono, ciudad y región si estaban vacíos.
    if (!existing.phone && body.phone) existing.phone = body.phone
    if (!existing.city && body.city) existing.city = body.city
    if (!existing.region && body.region) existing.region = body.region
    return reply(existing.position)
  }
  const at = stamp()
  const entry: WaitlistEntry = {
    id: newId('waitlist-entry'),
    type,
    position: lastPosition(type) + 1,
    status: 'NEW',
    fullName: body.fullName,
    email: body.email,
    phone: body.phone ?? null,
    city: body.city ?? null,
    interest: body.interest ?? null,
    wineryName: body.wineryName ?? null,
    region: body.region ?? null,
    produces: body.produces ?? null,
    message: body.message ?? null,
    locale: body.locale ?? 'es',
    source: body.source ?? null,
    consentAt: at,
    createdAt: at,
    contactedAt: null,
    contactedBy: null,
    notes: null,
  }
  entries().push(entry)
  // Sin datos personales en la bitácora: solo el tipo y el origen.
  recordAudit(ctx, {
    action: 'WAITLIST_JOINED',
    resource: { type: WAITLIST_RESOURCE_TYPE, id: entry.id },
    organizationId: null,
    after: { type: entry.type, source: entry.source },
  })
  return reply(entry.position)
}

async function update(ctx: RouteContext): Promise<RouteResult> {
  const body = await parseBody(ctx.request, UpdateWaitlistEntrySchema)
  const entry = entries().find((e) => e.id === ctx.params.id)
  if (!entry) throw notFound('Inscripción de la lista de espera no encontrada')
  const before = entry.status
  const statusChanged = body.status !== undefined && body.status !== before
  const notes = body.notes ?? null
  const notesChanged = body.notes !== undefined && notes !== entry.notes
  // Sin cambios: la inscripción tal cual, sin evento en la bitácora.
  if (!statusChanged && !notesChanged) return ok(entry)
  if (notesChanged) entry.notes = notes
  if (statusChanged) {
    entry.status = body.status!
    if (entry.status === 'CONTACTED') {
      entry.contactedAt = stamp()
      entry.contactedBy = ctx.auth.user.fullName
    } else if (entry.status === 'NEW') {
      entry.contactedAt = null
      entry.contactedBy = null
    }
  }
  // Sin el texto de las notas (pueden llevar datos personales).
  recordAudit(ctx, {
    action: 'WAITLIST_STATUS_CHANGED',
    resource: { type: WAITLIST_RESOURCE_TYPE, id: entry.id },
    organizationId: null,
    before: { status: before },
    after: { status: entry.status, notesChanged },
  })
  return ok(entry)
}

function exportCsv(ctx: RouteContext): RouteResult {
  const { query } = ctx
  const rows = filterEntries(query).sort(byArrival)
  if (rows.length > WAITLIST_EXPORT_MAX_ROWS) {
    throw domainError(
      422,
      'WAITLIST_EXPORT_TOO_LARGE',
      `La exportación tiene ${rows.length} filas y el máximo es ${WAITLIST_EXPORT_MAX_ROWS}: acota las fechas o los filtros`,
      null,
    )
  }
  recordAudit(ctx, {
    action: 'WAITLIST_EXPORTED',
    resource: { type: WAITLIST_RESOURCE_TYPE, id: null },
    organizationId: null,
    after: {
      rows: rows.length,
      filters: {
        type: strParam(query, 'type') ?? null,
        status: strParam(query, 'status') ?? null,
        source: strParam(query, 'source')?.trim().toLowerCase() ?? null,
        from: strParam(query, 'from') ?? null,
        to: strParam(query, 'to') ?? null,
        // El texto buscado puede ser un correo o un teléfono: no se guarda.
        searched: Boolean(strParam(query, 'q')?.trim()),
      },
    },
  })
  // Es un GET, pero deja un evento en la bitácora: se guarda como una escritura.
  persistErpDb()
  return {
    status: 200,
    data: undefined,
    headers: {
      'Content-Disposition': `attachment; filename="${waitlistExportFilename(now())}"`,
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(rows.length),
    },
    raw: { body: waitlistCsv(rows), contentType: 'text/csv; charset=utf-8' },
  }
}

function sources(query: URLSearchParams): WaitlistSource[] {
  const type = enumParam(query, 'type', WAITLIST_TYPES)
  const counts = new Map<string | null, number>()
  for (const e of entries()) if (!type || e.type === type) counts.set(e.source, (counts.get(e.source) ?? 0) + 1)
  // Del origen más numeroso al menos; a igualdad, por nombre (`null` = sin origen, primero).
  return [...counts]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || (a.source ?? '').localeCompare(b.source ?? '', 'es'))
}

export const waitlistRoutes: RouteSpec[] = [
  { method: 'post', path: '/v1/public/waitlist', access: 'public', handle: join },
  {
    method: 'get',
    path: '/v1/public/waitlist/stats',
    access: 'public',
    handle: () => ({ ...ok(waitlistStats()), headers: { 'Cache-Control': 'public, max-age=60' } }),
  },
  {
    method: 'get',
    path: '/v1/platform/waitlist',
    access: READERS,
    list: 'paged',
    handle: ({ query }) => listResult(filterEntries(query).sort(byNewest), query),
  },
  { method: 'get', path: '/v1/platform/waitlist/sources', access: READERS, handle: ({ query }) => ok(sources(query)) },
  { method: 'get', path: '/v1/platform/waitlist/export', access: WRITERS, handle: exportCsv },
  { method: 'patch', path: '/v1/platform/waitlist/:id', access: WRITERS, handle: update },
]
