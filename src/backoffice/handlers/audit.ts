import { dashboardChain, dashboardTokenization } from '../../tokenization/views'
import { anyStaff, orgMember, platform } from '../../erp/handlers/auth-context'
import { getErpDb } from '../../erp/handlers/db'
import { domainError, fieldError, invalid } from '../../erp/handlers/errors'
import { listResult, ok, strParam, type RouteSpec } from '../../erp/handlers/http'
import { PLATFORM_ORGANIZATION } from '../../erp/catalog'
import { effectiveInvitationStatus, verifyAuditChain } from '../model'
import { AUDIT_EXPORT_MAX_ROWS, type AuditEvent, type Dashboard } from '../schemas'
import { bo, now, nowMs } from './support'

// Bitácora (contrato de la Ola 1 §7) y tablero del back office (§8, con el bloque `waitlist` de O1b §2).

/** `from`/`to` aceptan `YYYY-MM-DD` (día completo) o fecha y hora ISO. */
export function dateParam(query: URLSearchParams, name: 'from' | 'to'): number | undefined {
  const raw = strParam(query, name)
  if (!raw) return undefined
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  const ms = Date.parse(dayOnly ? `${raw}T${name === 'from' ? '00:00:00' : '23:59:59'}Z` : raw)
  if (Number.isNaN(ms)) throw invalid([fieldError(name, `${name} debe ser una fecha AAAA-MM-DD o ISO 8601`)])
  return ms
}

function filterAudit(query: URLSearchParams, organizationId?: string): AuditEvent[] {
  const from = dateParam(query, 'from')
  const to = dateParam(query, 'to')
  const actorId = strParam(query, 'actorId')
  const org = organizationId ?? strParam(query, 'organizationId')
  const action = strParam(query, 'action')
  const resourceType = strParam(query, 'resourceType')
  const resourceId = strParam(query, 'resourceId')
  return bo().audit.filter((e) => {
    const at = Date.parse(e.occurredAt)
    return (
      (from === undefined || at >= from) &&
      (to === undefined || at <= to) &&
      (!actorId || e.actor.userId === actorId) &&
      (!org || e.organizationId === org) &&
      (!action || e.action === action) &&
      (!resourceType || e.resource.type === resourceType) &&
      (!resourceId || e.resource.id === resourceId)
    )
  })
}

const byNewest = (a: AuditEvent, b: AuditEvent) => b.seq - a.seq

const CSV_COLUMNS = [
  'seq',
  'occurredAt',
  'actorUserId',
  'actorFullName',
  'actorRole',
  'actorOrganizationId',
  'viaPlatform',
  'app',
  'ip',
  'action',
  'resourceType',
  'resourceId',
  'organizationId',
  'reason',
  'before',
  'after',
  'correlationId',
  'prevHash',
  'hash',
] as const

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV de la bitácora (orden cronológico, cabecera en la primera fila). */
export function auditCsv(events: readonly AuditEvent[]): string {
  const rows = events.map((e) =>
    [
      e.seq,
      e.occurredAt,
      e.actor.userId,
      e.actor.fullName,
      e.actor.role,
      e.actor.organizationId,
      e.actor.viaPlatform,
      e.source.app,
      e.source.ip,
      e.action,
      e.resource.type,
      e.resource.id,
      e.organizationId,
      e.reason,
      e.before,
      e.after,
      e.correlationId,
      e.prevHash,
      e.hash,
    ]
      .map(csvCell)
      .join(','),
  )
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n'
}

function dashboard(): Dashboard {
  const state = bo()
  const nowIso = now()
  const count = <T>(items: readonly T[], pred: (x: T) => boolean) => items.filter(pred).length
  const wineries = getErpDb().wineries
  const pending = state.invitations.filter((i) => effectiveInvitationStatus(i, nowIso) === 'PENDING')
  const in24h = Date.parse(nowIso) + 24 * 3_600_000
  return {
    applications: {
      unverified: count(state.applications, (a) => a.status === 'UNVERIFIED'),
      received: count(state.applications, (a) => a.status === 'RECEIVED'),
      inReview: count(state.applications, (a) => a.status === 'IN_REVIEW'),
      meetingScheduled: count(state.applications, (a) => a.status === 'MEETING_SCHEDULED'),
    },
    wineries: {
      invited: count(wineries, (w) => w.certificationStatus === 'INVITED'),
      active: count(wineries, (w) => w.certificationStatus === 'ACTIVE'),
      suspended: count(wineries, (w) => w.certificationStatus === 'SUSPENDED'),
    },
    invitations: {
      pending: pending.length,
      expiringIn24h: count(pending, (i) => Date.parse(i.expiresAt) <= in24h),
    },
    team: {
      // Membresías bloqueadas en bodegas + usuarios internos bloqueados en la plataforma.
      blockedMembers:
        wineries.reduce((n, w) => n + (w.members ?? []).filter((m) => !m.isActive).length, 0) +
        state.blocks.filter((b) => b.organizationId === PLATFORM_ORGANIZATION.id).length,
    },
    // Lista de espera: totales por tipo y las inscripciones de las últimas 24 h (los dos tipos).
    waitlist: {
      consumers: count(state.waitlist, (e) => e.type === 'CONSUMER'),
      wineries: count(state.waitlist, (e) => e.type === 'WINERY'),
      last24h: count(state.waitlist, (e) => Date.parse(e.createdAt) >= nowMs() - 24 * 3_600_000),
    },
    tokenization: dashboardTokenization(getErpDb().chain, nowIso),
    chain: dashboardChain(getErpDb().chain, nowIso),
    // Las alertas abiertas de la cadena (conciliación, transacciones fallidas) se suman a las del tablero.
    alerts: [
      ...state.alerts,
      ...getErpDb()
        .chain.alerts.filter((a) => a.resolvedAt === null)
        .map((a) => ({ id: a.id, level: a.level, message: a.message, createdAt: a.detectedAt, link: '/cadena/alertas' })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    recentAudit: [...state.audit].sort(byNewest).slice(0, 5),
  }
}

export const auditRoutes: RouteSpec[] = [
  {
    method: 'get',
    path: '/v1/platform/audit',
    access: platform(['ADMIN', 'OPERATIONS', 'SUPPORT']),
    list: 'paged',
    handle: ({ query }) => listResult(filterAudit(query).sort(byNewest), query),
  },
  {
    method: 'get',
    path: '/v1/platform/audit/export',
    access: platform(['ADMIN', 'OPERATIONS', 'SUPPORT']),
    handle({ query }) {
      const events = filterAudit(query).sort((a, b) => a.seq - b.seq)
      if (events.length > AUDIT_EXPORT_MAX_ROWS) {
        throw domainError(422, 'AUDIT_EXPORT_TOO_LARGE', `La exportación supera ${AUDIT_EXPORT_MAX_ROWS} filas: acota las fechas o los filtros`, null)
      }
      return { status: 200, data: undefined, raw: { body: auditCsv(events), contentType: 'text/csv; charset=utf-8' } }
    },
  },
  {
    method: 'get',
    path: '/v1/platform/audit/verify',
    access: platform(['ADMIN']),
    handle({ query }) {
      return ok(verifyAuditChain(bo().audit, { from: dateParam(query, 'from'), to: dateParam(query, 'to') }))
    },
  },
  {
    method: 'get',
    path: '/v1/organizations/current/audit',
    access: orgMember(['OWNER']),
    allowInactiveOrg: ['SUSPENDED'],
    list: 'paged',
    handle: ({ auth, query }) => listResult(filterAudit(query, auth.organizationId!).sort(byNewest), query),
  },
  {
    method: 'get',
    path: '/v1/platform/dashboard',
    access: anyStaff,
    handle: () => ok(dashboard()),
  },
]
