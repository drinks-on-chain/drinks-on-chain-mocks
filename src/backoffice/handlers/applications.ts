import { anyStaff, platform } from '../../erp/handlers/auth-context'
import { getErpDb, newId, nextSeq } from '../../erp/handlers/db'
import { ApiError, domainError, fieldError, notFound } from '../../erp/handlers/errors'
import { accepted, enumParam, listResult, noContent, ok, parseBody, strParam, type RouteContext, type RouteSpec } from '../../erp/handlers/http'
import type { WineryResponse } from '../../erp/schemas'
import { sha256Hex } from '../../shared/crypto'
import { applicationVerifyMail, simpleMail } from '../mail'
import type { StoredApplication } from '../model'
import {
  AddApplicationNoteSchema,
  APPLICATION_STATUSES,
  APPLICATION_TRANSITIONS,
  ApproveApplicationSchema,
  CreateWineryApplicationSchema,
  MeetingDoneSchema,
  OPEN_APPLICATION_STATUSES,
  RejectApplicationSchema,
  ScheduleMeetingSchema,
  VerifyWineryApplicationSchema,
  type ApplicationStatus,
  type WineryApplication,
  type WineryApplicationSummary,
} from '../schemas'
import { createInvitation, wineryTarget } from './invitations'
import { platformStaff } from './members'
import { bo, checkCaptcha, now, profileOf, recordAudit, sendMail, stamp, wineryDetail } from './support'
import { toInvitation } from '../model'

// Solicitudes de alta de bodega (contrato de la Ola 1 §3; proceso en docs-back/07 §1.2).

const PLATFORM_WRITERS = platform(['ADMIN', 'OPERATIONS'])

export function toApplication(a: StoredApplication): WineryApplication {
  const out: Partial<StoredApplication> = { ...a }
  delete out._mock
  return out as WineryApplication
}

function toSummary(a: StoredApplication): WineryApplicationSummary {
  const out: Partial<StoredApplication> = { ...a }
  delete out._mock
  delete out.notes
  return out as WineryApplicationSummary
}

function findApplication(id: string): StoredApplication {
  const a = bo().applications.find((x) => x.id === id)
  if (!a) throw notFound('Solicitud de alta no encontrada')
  return a
}

/** Cambia de estado respetando las transiciones (§3); si no, 409 `APPLICATION_INVALID_TRANSITION`. */
function transition(a: StoredApplication, to: ApplicationStatus): ApplicationStatus {
  const from = a.status
  if (!APPLICATION_TRANSITIONS[from].includes(to)) {
    throw domainError(409, 'APPLICATION_INVALID_TRANSITION', `La solicitud no puede pasar de ${from} a ${to}`)
  }
  a.status = to
  return from
}

/** Vida del enlace de verificación del correo de contacto (72 h, desde el último envío). */
export const APPLICATION_VERIFY_TTL_HOURS = 72

/** Caducidad del enlace de verificación de una solicitud `UNVERIFIED` (último envío + 72 h). */
function verifyExpiresAt(a: StoredApplication): number {
  return Date.parse(a.updatedAt) + APPLICATION_VERIFY_TTL_HOURS * 3_600_000
}

/**
 * ¿Solicitud abierta para el NIT? Recibida, en revisión o con reunión, o sin verificar con el enlace
 * aún válido (una sin verificar caducada no bloquea el NIT), como `openApplicationWhere` del backend.
 */
function isOpenApplication(a: StoredApplication, nowMs: number): boolean {
  if (a.status === 'UNVERIFIED') return verifyExpiresAt(a) > nowMs
  return OPEN_APPLICATION_STATUSES.includes(a.status)
}

/**
 * ¿Hay una bodega (en **cualquier** estado, también `REVOKED`: el NIT es único) o una solicitud
 * abierta con este NIT? Se excluyen la solicitud y la bodega de la propia operación.
 */
export function taxIdTaken(taxId: string, exceptApplicationId: string | null = null, exceptWineryId: string | null = null): boolean {
  const nowMs = Date.parse(now())
  const winery = getErpDb().wineries.some((w) => w.taxIdNit === taxId && w.id !== exceptWineryId)
  const open = bo().applications.some((a) => a.taxId === taxId && a.id !== exceptApplicationId && isOpenApplication(a, nowMs))
  return winery || open
}

/** 409 `ORG_TAX_ID_TAKEN` con el campo, como el backend. */
export function taxIdTakenError(taxId: string) {
  return new ApiError(409, 'ORG_TAX_ID_TAKEN', `Ya hay una bodega o una solicitud abierta con el NIT ${taxId}`, [
    fieldError('taxId', 'NIT ya registrado'),
  ])
}

/** 422 `APPLICATION_TOKEN_INVALID`: enlace desconocido, ya usado o caducado. */
const applicationTokenInvalid = () =>
  new ApiError(422, 'APPLICATION_TOKEN_INVALID', 'El enlace de verificación no es válido, ya se usó o caducó', [
    fieldError('token', 'Enlace no válido o caducado'),
  ])

/** Aviso a operaciones (correo a cada persona de operaciones y administración). */
function notifyOperations(subject: string, lines: string[], template: 'APPLICATION_NEW_FOR_OPERATIONS' | 'APPLICATION_DUPLICATE_FOR_OPERATIONS') {
  for (const u of platformStaff()) {
    if (u.isActive && ['ADMIN', 'OPERATIONS'].includes(u._mock.platformRole ?? 'SUPERADMIN')) {
      sendMail(simpleMail(u.email, template, subject, lines))
    }
  }
}

function audit(ctx: RouteContext, a: StoredApplication, action: string, extra: { before?: Record<string, unknown>; after?: Record<string, unknown>; reason?: string | null } = {}) {
  recordAudit(ctx, { action, resource: { type: 'winery_application', id: a.id }, organizationId: a.wineryId, ...extra })
}

/** Crea la bodega `INVITED` de una solicitud aprobada o de un alta directa. */
export function createInvitedWinery(
  ctx: RouteContext,
  data: {
    legalName: string
    tradeName: string
    taxId: string
    category: WineryResponse['beverageCategory']
    region: string
    contactEmail: string
    contactPhone?: string | null
    address?: string | null
    senasagRegistration?: string | null
    logoUrl?: string | null
    publicStory?: string | null
    website?: string | null
  },
  reason: string | null,
): WineryResponse {
  const createdAt = stamp()
  const winery: WineryResponse = {
    id: newId('winery'),
    legalName: data.legalName,
    commercialName: data.tradeName,
    beverageCategory: data.category,
    taxIdNit: data.taxId,
    senasagSanitaryReg: data.senasagRegistration ?? null,
    geographicRegion: data.region,
    countryCode: 'BO',
    address: data.address ?? null,
    contactEmail: data.contactEmail,
    contactPhone: data.contactPhone ?? null,
    logoUrl: data.logoUrl ?? null,
    stellarPublicKey: null,
    onchainProducerId: null,
    onchainRegisterTxHash: null,
    isExportCertified: false,
    certificationStatus: 'INVITED',
    approvedAt: null,
    createdAt,
    members: [],
  }
  getErpDb().wineries.push(winery)
  const profile = profileOf(winery)
  profile.publicStory = data.publicStory ?? null
  profile.website = data.website ?? null
  profile.statusHistory = [{ status: 'INVITED', at: createdAt, by: ctx.auth.user.fullName, reason }]
  recordAudit(ctx, {
    action: 'WINERY_CREATED',
    resource: { type: 'winery', id: winery.id },
    organizationId: winery.id,
    after: { status: 'INVITED', tradeName: winery.commercialName, taxId: winery.taxIdNit },
    reason,
  })
  return winery
}

export const applicationRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/public/winery-applications',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, CreateWineryApplicationSchema)
      const fakeId = () => `00000000-0000-5000-8000-${sha256Hex(`honeypot:${nextSeq('honeypot')}`).slice(0, 12)}`
      // Campo trampa relleno: 202 silencioso sin crear nada.
      if (body.website && body.website.trim() !== '') return accepted({ id: fakeId(), status: 'UNVERIFIED' })
      checkCaptcha(body.captchaToken)
      const email = body.contactEmail.toLowerCase()
      // La misma persona reenvía la misma solicitud sin haberla verificado: se actualiza y se manda
      // un enlace nuevo (el anterior deja de valer).
      const previous = bo().applications.find((x) => x.status === 'UNVERIFIED' && x.taxId === body.taxId && x.contactEmail === email)
      // NIT ya usado: 202 igualmente (no se filtran datos) y aviso a operaciones.
      if (taxIdTaken(body.taxId, previous?.id ?? null)) {
        notifyOperations(`Solicitud duplicada: NIT ${body.taxId}`, [
          `Llegó una solicitud de ${body.tradeName} con el NIT ${body.taxId}, que ya tiene una bodega o una solicitud abierta.`,
          `Contacto: ${body.contactName} <${body.contactEmail}>.`,
        ], 'APPLICATION_DUPLICATE_FOR_OPERATIONS')
        bo().alerts.push({
          id: newId('alert'),
          level: 'WARNING',
          message: `Solicitud duplicada de ${body.tradeName}: el NIT ${body.taxId} ya existe.`,
          createdAt: now(),
          link: '/solicitudes',
        })
        recordAudit(ctx, {
          action: 'WINERY_APPLICATION_DUPLICATE_TAX_ID',
          resource: { type: 'winery_application', id: null },
          organizationId: null,
          after: { taxId: body.taxId, tradeName: body.tradeName },
        })
        return accepted({ id: fakeId(), status: 'UNVERIFIED' })
      }
      const createdAt = stamp()
      const token = `apv_${sha256Hex(`application-verify:${nextSeq('application-verify')}:${body.taxId}`).slice(0, 24)}`
      if (previous) {
        Object.assign(previous, {
          updatedAt: createdAt,
          legalName: body.legalName,
          tradeName: body.tradeName,
          category: body.category,
          region: body.region,
          contactName: body.contactName,
          contactPhone: body.contactPhone ?? null,
          message: body.message ?? null,
        })
        previous._mock.verifyToken = token
        sendMail(applicationVerifyMail({ to: previous.contactEmail, token, tradeName: previous.tradeName }))
        audit(ctx, previous, 'WINERY_APPLICATION_SUBMITTED', {
          after: { tradeName: previous.tradeName, taxId: previous.taxId, contactEmail: previous.contactEmail, resubmitted: true },
        })
        return accepted({ id: previous.id, status: 'UNVERIFIED' })
      }
      const a: StoredApplication = {
        id: newId('winery-application'),
        status: 'UNVERIFIED',
        createdAt,
        updatedAt: createdAt,
        legalName: body.legalName,
        tradeName: body.tradeName,
        taxId: body.taxId,
        category: body.category,
        region: body.region,
        contactName: body.contactName,
        contactEmail: email,
        contactPhone: body.contactPhone ?? null,
        message: body.message ?? null,
        assignee: null,
        meeting: null,
        decision: null,
        wineryId: null,
        notes: [],
        _mock: { verifyToken: token },
      }
      bo().applications.unshift(a)
      sendMail(applicationVerifyMail({ to: a.contactEmail, token, tradeName: a.tradeName }))
      audit(ctx, a, 'WINERY_APPLICATION_SUBMITTED', { after: { tradeName: a.tradeName, taxId: a.taxId, contactEmail: a.contactEmail, resubmitted: false } })
      return accepted({ id: a.id, status: 'UNVERIFIED' })
    },
  },
  {
    method: 'post',
    path: '/v1/public/winery-applications/verify',
    access: 'public',
    async handle(ctx) {
      const body = await parseBody(ctx.request, VerifyWineryApplicationSchema)
      const a = bo().applications.find((x) => x._mock.verifyToken === body.token)
      // Desconocido, ya usado o caducado (72 h desde el último envío) → 422.
      if (!a || a.status !== 'UNVERIFIED' || verifyExpiresAt(a) <= Date.parse(now())) throw applicationTokenInvalid()
      transition(a, 'RECEIVED')
      a.updatedAt = stamp()
      a._mock.verifyToken = null
      sendMail(simpleMail(a.contactEmail, 'APPLICATION_RECEIVED', 'Recibimos tu solicitud', [
        `Gracias, ${a.contactName}. La solicitud de ${a.tradeName} ya está en manos del equipo de operaciones.`,
        'Te escribiremos por este correo con la respuesta o para agendar una reunión.',
      ]))
      notifyOperations(`Solicitud nueva: ${a.tradeName}`, [`${a.tradeName} (${a.region}) envió una solicitud de alta.`], 'APPLICATION_NEW_FOR_OPERATIONS')
      audit(ctx, a, 'WINERY_APPLICATION_VERIFIED', { before: { status: 'UNVERIFIED' }, after: { status: 'RECEIVED' } })
      return noContent()
    },
  },
  {
    method: 'get',
    path: '/v1/platform/winery-applications',
    access: anyStaff,
    list: 'paged',
    handle({ query }) {
      const status = enumParam(query, 'status', APPLICATION_STATUSES)
      const q = strParam(query, 'q')?.toLowerCase()
      const assigneeId = strParam(query, 'assigneeId')
      const items = bo()
        .applications.filter(
          (a) =>
            (status ? a.status === status : a.status !== 'UNVERIFIED') &&
            (!assigneeId || a.assignee?.userId === assigneeId) &&
            (!q || [a.legalName, a.tradeName, a.taxId, a.contactName, a.contactEmail, a.region].some((v) => v.toLowerCase().includes(q))),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .map(toSummary)
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/platform/winery-applications/:id',
    access: anyStaff,
    handle: ({ params }) => ok(toApplication(findApplication(params.id!))),
  },
  {
    method: 'post',
    path: '/v1/platform/winery-applications/:id/take',
    access: PLATFORM_WRITERS,
    async handle(ctx) {
      const a = findApplication(ctx.params.id!)
      // Solo se toma una solicitud recibida (RECEIVED → IN_REVIEW).
      if (a.status !== 'RECEIVED') {
        throw domainError(409, 'APPLICATION_INVALID_TRANSITION', `Solo se toma una solicitud RECEIVED (esta está ${a.status})`)
      }
      transition(a, 'IN_REVIEW')
      a.assignee = { userId: ctx.auth.user.id, fullName: ctx.auth.user.fullName }
      a.updatedAt = stamp()
      audit(ctx, a, 'WINERY_APPLICATION_TAKEN', { before: { status: 'RECEIVED', assigneeId: null }, after: { status: 'IN_REVIEW', assigneeId: ctx.auth.user.id } })
      return ok(toApplication(a))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/winery-applications/:id/notes',
    access: PLATFORM_WRITERS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, AddApplicationNoteSchema)
      const a = findApplication(ctx.params.id!)
      if (a.status === 'UNVERIFIED') throw domainError(409, 'APPLICATION_INVALID_TRANSITION', 'La solicitud aún no tiene el correo verificado')
      const at = stamp()
      const note = { id: newId('application-note'), text: body.text, by: ctx.auth.user.fullName, at }
      a.notes.push(note)
      a.updatedAt = at
      audit(ctx, a, 'WINERY_APPLICATION_NOTE_ADDED', { after: { noteId: note.id } })
      return ok(toApplication(a))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/winery-applications/:id/schedule-meeting',
    access: PLATFORM_WRITERS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, ScheduleMeetingSchema)
      const a = findApplication(ctx.params.id!)
      transition(a, 'MEETING_SCHEDULED')
      a.meeting = { scheduledAt: new Date(body.scheduledAt).toISOString().replace(/\.\d{3}Z$/, 'Z'), channel: body.channel, notes: body.notes ?? null }
      a.updatedAt = stamp()
      audit(ctx, a, 'WINERY_APPLICATION_MEETING_SCHEDULED', { before: { status: 'IN_REVIEW' }, after: { status: 'MEETING_SCHEDULED', ...a.meeting } })
      return ok(toApplication(a))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/winery-applications/:id/meeting-done',
    access: PLATFORM_WRITERS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, MeetingDoneSchema)
      const a = findApplication(ctx.params.id!)
      transition(a, 'IN_REVIEW')
      const at = stamp()
      if (a.meeting) a.meeting = { ...a.meeting, notes: body.notes }
      a.notes.push({ id: newId('application-note'), text: body.notes, by: ctx.auth.user.fullName, at })
      a.updatedAt = at
      audit(ctx, a, 'WINERY_APPLICATION_MEETING_DONE', { before: { status: 'MEETING_SCHEDULED' }, after: { status: 'IN_REVIEW' } })
      return ok(toApplication(a))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/winery-applications/:id/approve',
    access: PLATFORM_WRITERS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, ApproveApplicationSchema)
      const a = findApplication(ctx.params.id!)
      if (!APPLICATION_TRANSITIONS[a.status].includes('APPROVED')) {
        throw domainError(409, 'APPLICATION_INVALID_TRANSITION', `La solicitud no puede pasar de ${a.status} a APPROVED`)
      }
      if (taxIdTaken(a.taxId, a.id)) throw taxIdTakenError(a.taxId)
      const reason = body.reason ?? null
      const winery = createInvitedWinery(ctx, {
        legalName: a.legalName,
        tradeName: a.tradeName,
        taxId: a.taxId,
        category: a.category,
        region: a.region,
        contactEmail: a.contactEmail,
        contactPhone: a.contactPhone,
      }, reason ?? 'Solicitud aprobada')
      const invitation = createInvitation(ctx, {
        target: wineryTarget(winery),
        email: body.ownerEmail ?? a.contactEmail,
        role: 'OWNER',
        invitedBy: ctx.auth.user,
        viaPlatform: true,
        inviteeName: body.ownerFullName ?? a.contactName,
        reason,
        ownerInvite: true,
      })
      transition(a, 'APPROVED')
      const at = stamp()
      a.decision = { by: ctx.auth.user.fullName, at, reason }
      a.wineryId = winery.id
      a.updatedAt = at
      sendMail(simpleMail(a.contactEmail, 'APPLICATION_APPROVED', `${a.tradeName} fue aprobada en Drinks on Chain`, [
        `La solicitud de ${a.tradeName} fue aprobada.`,
        'La persona titular recibirá una invitación para activar la cuenta de la bodega.',
      ]))
      audit(ctx, a, 'WINERY_APPLICATION_APPROVED', { before: { status: 'IN_REVIEW' }, after: { status: 'APPROVED', wineryId: winery.id }, reason })
      return ok({ application: toApplication(a), winery: wineryDetail(winery), invitation: toInvitation(invitation, now()) })
    },
  },
  {
    method: 'post',
    path: '/v1/platform/winery-applications/:id/reject',
    access: PLATFORM_WRITERS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, RejectApplicationSchema)
      const a = findApplication(ctx.params.id!)
      const from = transition(a, 'REJECTED')
      const at = stamp()
      a.decision = { by: ctx.auth.user.fullName, at, reason: body.reason }
      a.updatedAt = at
      sendMail(simpleMail(a.contactEmail, 'APPLICATION_REJECTED', `Sobre la solicitud de ${a.tradeName}`, [
        `Revisamos la solicitud de ${a.tradeName} y por ahora no podemos aprobarla.`,
        `Motivo: ${body.reason}`,
      ]))
      audit(ctx, a, 'WINERY_APPLICATION_REJECTED', { before: { status: from }, after: { status: 'REJECTED' }, reason: body.reason })
      return ok(toApplication(a))
    },
  },
]
