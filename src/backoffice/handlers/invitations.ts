import { PLATFORM_ORGANIZATION } from '../../erp/catalog'
import { USER_ROLE_FOR_MEMBER } from '../../erp/derive'
import { anyUser, orgMember, type AuthContext } from '../../erp/handlers/auth-context'
import { getErpDb, newId, nextSeq } from '../../erp/handlers/db'
import { ApiError, domainError, fieldError, invalid, notFound, unauthorized } from '../../erp/handlers/errors'
import { created, enumParam, listResult, ok, parseBody, type RouteContext, type RouteSpec } from '../../erp/handlers/http'
import { createUser, findUserByEmail, openSession, sessionResult } from '../../erp/handlers/routes/auth-users'
import { addMembership } from '../../erp/handlers/routes/wineries'
import { getSession, rememberOrganization, rotateRefresh, setActiveOrganization } from '../../erp/handlers/sessions'
import type { MemberRole, MembershipRole, MockUser, OrganizationType, PlatformRole, WineryResponse } from '../../erp/schemas'
import { sha256Hex } from '../../shared/crypto'
import { invitationMail } from '../mail'
import { effectiveInvitationStatus, toInvitation, type StoredInvitation } from '../model'
import {
  AcceptInvitationSchema,
  CreateInvitationSchema,
  INVITATION_STATUSES,
  InvitationActionSchema,
  type Invitation,
  type InvitationPreview,
} from '../schemas'
import { startMfaChallenge } from './identity'
import { platformMembershipId, setMemberBlocked, setMemberRole, teamSize } from './members'
import {
  activateWinery,
  bo,
  checkPassword,
  effectiveSetting,
  findWinery,
  invitationTtlHours,
  now,
  personActor,
  profileOf,
  recordAudit,
  sendMail,
  stamp,
} from './support'

// Invitaciones (contrato de la Ola 1 §2): dueño, colaboradores y usuarios internos.
//
// Tokens: los de los fixtures son legibles (`demo-invitacion-…`). Los que emiten los handlers son
// "portátiles" (`inv.<base64url(JSON)>.<firma>`): llevan los datos de la invitación para que la
// app que abre el enlace (el ERP) la reconozca aunque la haya creado otra app (el Backoffice),
// porque cada app tiene su propio estado de mocks en su localStorage. El backend real usa tokens
// opacos: las apps no deben leer su contenido.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function b64url(text: string): string {
  let binary = ''
  for (const b of encoder.encode(text)) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return decoder.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

interface PortableInvitation {
  v: 1
  n: number
  inv: Omit<StoredInvitation, '_mock'> & { inviteeName: string | null }
  winery: Pick<
    WineryResponse,
    'legalName' | 'commercialName' | 'beverageCategory' | 'taxIdNit' | 'geographicRegion' | 'contactEmail' | 'contactPhone' | 'createdAt'
  > | null
}

function signature(body: string): string {
  return sha256Hex(`doc-mocks:${body}`).slice(0, 12)
}

function portableToken(inv: StoredInvitation): string {
  const w = inv.organizationType === 'WINERY' ? getErpDb().wineries.find((x) => x.id === inv.organizationId) : undefined
  const payload: PortableInvitation = {
    v: 1,
    n: nextSeq('invitation-token'),
    inv: {
      id: inv.id,
      email: inv.email,
      organizationId: inv.organizationId,
      organizationType: inv.organizationType,
      organizationName: inv.organizationName,
      role: inv.role,
      status: 'PENDING',
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
      invitedBy: inv.invitedBy,
      inviteeName: inv._mock.inviteeName,
    },
    winery: w
      ? {
          legalName: w.legalName,
          commercialName: w.commercialName,
          beverageCategory: w.beverageCategory,
          taxIdNit: w.taxIdNit,
          geographicRegion: w.geographicRegion,
          contactEmail: w.contactEmail,
          contactPhone: w.contactPhone ?? null,
          createdAt: w.createdAt,
        }
      : null,
  }
  const body = b64url(JSON.stringify(payload))
  return `inv.${body}.${signature(body)}`
}

/** Importa una invitación emitida por los mocks de otra app (crea la bodega `INVITED` si falta). */
function importPortable(token: string): StoredInvitation | undefined {
  const [prefix, body, sig] = token.split('.')
  if (prefix !== 'inv' || !body || sig !== signature(body)) return undefined
  let payload: PortableInvitation
  try {
    payload = JSON.parse(fromB64url(body)) as PortableInvitation
  } catch {
    return undefined
  }
  const db = getErpDb()
  const known = bo().invitations.find((i) => i.id === payload.inv.id)
  if (known) return undefined // la conoce con otro token (reenviada o anulada aquí)
  if (payload.inv.organizationType === 'WINERY' && payload.winery && !db.wineries.some((w) => w.id === payload.inv.organizationId)) {
    const w = payload.winery
    const winery: WineryResponse = {
      id: payload.inv.organizationId,
      ...w,
      senasagSanitaryReg: null,
      countryCode: 'BO',
      address: null,
      logoUrl: null,
      stellarPublicKey: null,
      onchainProducerId: null,
      onchainRegisterTxHash: null,
      isExportCertified: false,
      certificationStatus: 'INVITED',
      approvedAt: null,
      members: [],
    }
    db.wineries.push(winery)
    profileOf(winery)
  }
  const { inviteeName, ...inv } = payload.inv
  const stored: StoredInvitation = { ...inv, _mock: { token, inviteeName, transfer: null, acceptedAt: null, revokedAt: null } }
  bo().invitations.push(stored)
  return stored
}

export function findInvitationByToken(token: string): StoredInvitation {
  const inv = bo().invitations.find((i) => i._mock.token === token) ?? importPortable(token)
  if (!inv) throw domainError(404, 'INVITATION_NOT_FOUND', 'La invitación no existe o el enlace ya no es válido')
  return inv
}

export function findInvitationById(id: string): StoredInvitation {
  const inv = bo().invitations.find((i) => i.id === id)
  if (!inv) throw domainError(404, 'INVITATION_NOT_FOUND', `Invitación con identificador "${id}" no encontrada`)
  return inv
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

export interface InvitationTarget {
  organizationId: string
  organizationType: OrganizationType
  organizationName: string
}

export function wineryTarget(w: WineryResponse): InvitationTarget {
  return { organizationId: w.id, organizationType: 'WINERY', organizationName: w.commercialName }
}

export const platformTarget: InvitationTarget = {
  organizationId: PLATFORM_ORGANIZATION.id,
  organizationType: 'PLATFORM',
  organizationName: PLATFORM_ORGANIZATION.name,
}

/** ¿Es ya miembro (activo o bloqueado) de la organización? */
function isMember(target: InvitationTarget, email: string): boolean {
  const user = findUserByEmail(email)
  if (!user) return false
  if (target.organizationType === 'PLATFORM') return Boolean(user._mock.platformRole) || user.userRole === 'PLATFORM_ADMIN'
  const winery = getErpDb().wineries.find((w) => w.id === target.organizationId)
  return Boolean(winery?.members?.some((m) => m.userId === user.id))
}

export interface CreateInvitationOptions {
  target: InvitationTarget
  email: string
  role: MembershipRole
  invitedBy: MockUser
  viaPlatform: boolean
  inviteeName?: string | null
  reason?: string | null
  /** Alta de bodega o transferencia: permite `OWNER` y no cuenta para el límite. */
  ownerInvite?: boolean
  transfer?: StoredInvitation['_mock']['transfer']
}

/** Crea la invitación con sus reglas (§2), "envía" el correo y deja la entrada de bitácora. */
export function createInvitation(ctx: RouteContext | null, o: CreateInvitationOptions): StoredInvitation {
  const email = o.email.trim().toLowerCase()
  if (o.role === 'OWNER' && !o.ownerInvite) {
    throw domainError(403, 'ORG_OWNER_ROLE_RESERVED', 'El rol de dueño solo se asigna en el alta de la bodega o al transferir la titularidad')
  }
  if (!o.transfer && isMember(o.target, email)) {
    throw domainError(409, 'ORG_ALREADY_MEMBER', 'Esa persona ya es miembro de la organización')
  }
  const nowIso = now()
  if (bo().invitations.some((i) => i.organizationId === o.target.organizationId && i.email.toLowerCase() === email && effectiveInvitationStatus(i, nowIso) === 'PENDING')) {
    throw domainError(409, 'INVITATION_ALREADY_PENDING', 'Ya hay una invitación pendiente para ese correo')
  }
  if (o.target.organizationType === 'WINERY' && !o.ownerInvite) {
    const limit = effectiveSetting('equipo.maxColaboradoresPorBodega', o.target.organizationId).value
    if (typeof limit === 'number' && teamSize(o.target.organizationId) >= limit) {
      throw domainError(422, 'ORG_MEMBER_LIMIT_REACHED', `La bodega alcanzó su límite de ${limit} colaboradores (miembros activos + invitaciones pendientes)`, 'email')
    }
  }
  const createdAt = stamp()
  const inv: StoredInvitation = {
    id: newId('invitation'),
    email,
    organizationId: o.target.organizationId,
    organizationType: o.target.organizationType,
    organizationName: o.target.organizationName,
    role: o.role,
    status: 'PENDING',
    expiresAt: new Date(Date.parse(createdAt) + invitationTtlHours() * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    createdAt,
    invitedBy: { userId: o.invitedBy.id, fullName: o.invitedBy.fullName, viaPlatform: o.viaPlatform },
    _mock: { token: '', inviteeName: o.inviteeName ?? null, transfer: o.transfer ?? null, acceptedAt: null, revokedAt: null },
  }
  inv._mock.token = portableToken(inv)
  bo().invitations.push(inv)
  sendInvitationMail(inv)
  recordAudit(ctx, {
    action: o.target.organizationType === 'PLATFORM' ? 'PLATFORM_USER_INVITED' : 'INVITATION_CREATED',
    resource: { type: 'INVITATION', id: inv.id },
    organizationId: inv.organizationId,
    after: { email, role: o.role, expiresAt: inv.expiresAt },
    reason: o.reason ?? null,
  })
  return inv
}

function sendInvitationMail(inv: StoredInvitation): void {
  sendMail(
    invitationMail({
      to: inv.email,
      token: inv._mock.token,
      organizationName: inv.organizationName,
      organizationType: inv.organizationType,
      role: inv.role,
      invitedByName: inv.invitedBy.fullName,
      expiresAt: inv.expiresAt,
    }),
  )
}

// ---------------------------------------------------------------------------
// Aceptar
// ---------------------------------------------------------------------------

function preview(inv: StoredInvitation): InvitationPreview {
  return {
    email: inv.email,
    organizationName: inv.organizationName,
    organizationType: inv.organizationType,
    role: inv.role,
    invitedByName: inv.invitedBy.fullName,
    expiresAt: inv.expiresAt,
    status: effectiveInvitationStatus(inv, now()),
    accountExists: Boolean(findUserByEmail(inv.email)),
  }
}

function assertPending(inv: StoredInvitation): void {
  const status = effectiveInvitationStatus(inv, now())
  if (status === 'EXPIRED') throw domainError(422, 'INVITATION_EXPIRED', 'La invitación caducó: pide que te la reenvíen', 'token')
  if (status !== 'PENDING') throw domainError(409, 'INVITATION_NOT_PENDING', `La invitación ya no está pendiente (${status})`)
}

/** Membresía de bodega de la invitación (nueva, reactivada o con el rol nuevo). */
function joinWinery(ctx: RouteContext, inv: StoredInvitation, user: MockUser): void {
  const winery = findWinery(inv.organizationId)
  const role = inv.role as MemberRole
  const existing = winery.members?.find((m) => m.userId === user.id)
  let membershipId: string
  if (existing) {
    setMemberRole(winery, existing, role)
    setMemberBlocked(winery, existing, null)
    membershipId = existing.id
  } else {
    membershipId = addMembership(winery, user, role, null).id
  }
  // Transferencia de titularidad: el dueño anterior pasa a enólogo o queda bloqueado.
  if (inv._mock.transfer) {
    const previous = winery.members?.find((m) => m.id === inv._mock.transfer!.previousOwnerMembershipId)
    if (previous && previous.userId !== user.id) {
      if (inv._mock.transfer.keepPreviousOwnerAs === 'ENOLOGIST') setMemberRole(winery, previous, 'ENOLOGIST')
      else {
        setMemberRole(winery, previous, 'ENOLOGIST')
        setMemberBlocked(winery, previous, { by: 'PLATFORM', reason: 'Transferencia de titularidad' })
      }
      recordAudit(ctx, {
        action: 'WINERY_OWNERSHIP_TRANSFERRED',
        resource: { type: 'WINERY', id: winery.id },
        organizationId: winery.id,
        before: { ownerUserId: previous.userId },
        after: { ownerUserId: user.id, previousOwnerAs: inv._mock.transfer.keepPreviousOwnerAs },
        actor: personActor(user, 'OWNER', winery.id),
      })
    }
  }
  recordAudit(ctx, {
    action: 'MEMBER_JOINED',
    resource: { type: 'MEMBERSHIP', id: membershipId },
    organizationId: winery.id,
    after: { role },
    actor: personActor(user, role, winery.id),
  })
  if (role === 'OWNER' && winery.certificationStatus === 'INVITED') activateWinery(ctx, winery, user)
}

function joinPlatform(ctx: RouteContext, inv: StoredInvitation, user: MockUser): void {
  user._mock.platformRole = inv.role as PlatformRole
  const membershipId = platformMembershipId(user.id)
  bo().blocks = bo().blocks.filter((b) => b.membershipId !== membershipId)
  recordAudit(ctx, {
    action: 'MEMBER_JOINED',
    resource: { type: 'MEMBERSHIP', id: membershipId },
    organizationId: PLATFORM_ORGANIZATION.id,
    after: { role: inv.role },
    actor: personActor(user, inv.role, PLATFORM_ORGANIZATION.id),
  })
}

async function accept(ctx: RouteContext) {
  const inv = findInvitationByToken(ctx.params.token!)
  assertPending(inv)
  const body = await parseBody(ctx.request, AcceptInvitationSchema)
  const auth: AuthContext | null = ctx.optionalAuth
  const existing = findUserByEmail(inv.email)
  let user: MockUser
  if (existing) {
    if (!auth) throw unauthorized(`Inicia sesión con ${inv.email} para aceptar la invitación`)
    if (auth.user.id !== existing.id) throw domainError(403, 'INVITATION_EMAIL_MISMATCH', 'La invitación es para otro correo')
    user = existing
  } else {
    if (auth) throw domainError(403, 'INVITATION_EMAIL_MISMATCH', 'La invitación es para otro correo: cierra la sesión para crear la cuenta')
    const missing = [
      ...(body.fullName ? [] : [fieldError('fullName', 'Campo obligatorio')]),
      ...(body.password ? [] : [fieldError('password', 'Campo obligatorio')]),
    ]
    if (missing.length) throw invalid(missing)
    checkPassword(body.password!)
    user = createUser({
      email: inv.email,
      password: body.password!,
      fullName: body.fullName!,
      userRole: inv.organizationType === 'PLATFORM' ? 'PLATFORM_ADMIN' : USER_ROLE_FOR_MEMBER[inv.role as MemberRole],
      wineryId: inv.organizationType === 'WINERY' ? inv.organizationId : null,
    })
    recordAudit(ctx, {
      action: 'USER_CREATED',
      resource: { type: 'USER', id: user.id },
      organizationId: inv.organizationId,
      after: { email: user.email, via: 'INVITATION' },
      actor: personActor(user, null, null),
    })
  }
  inv.status = 'ACCEPTED'
  inv._mock.acceptedAt = stamp()
  recordAudit(ctx, {
    action: 'INVITATION_ACCEPTED',
    resource: { type: 'INVITATION', id: inv.id },
    organizationId: inv.organizationId,
    actor: personActor(user, inv.role, inv.organizationId),
  })
  if (inv.organizationType === 'PLATFORM') {
    joinPlatform(ctx, inv, user)
    // El personal de plataforma entra siempre con el segundo factor (inscribirlo si es nuevo).
    return ok(startMfaChallenge(user))
  }
  joinWinery(ctx, inv, user)
  const session = auth?.sid ? getSession(auth.sid) : undefined
  if (session && !session.revoked) {
    rotateRefresh(session)
    setActiveOrganization(session, inv.organizationId)
    rememberOrganization(user.id, inv.organizationId)
    return sessionResult(user, session, ctx.url)
  }
  return sessionResult(user, openSession(user, { organizationId: inv.organizationId, mfa: auth?.mfa ?? false }), ctx.url)
}

// ---------------------------------------------------------------------------
// Reenviar y anular
// ---------------------------------------------------------------------------

/** ¿Puede gestionar esta invitación? Dueño de la organización (activa) o personal de plataforma. */
function assertCanManage(auth: AuthContext, inv: StoredInvitation): void {
  const staff = auth.organizationType === 'PLATFORM' && auth.mfa && auth.platformRole
  if (staff) {
    if (inv.organizationType === 'PLATFORM' && !['SUPERADMIN', 'ADMIN'].includes(auth.platformRole!)) {
      throw new ApiError(403, 'FORBIDDEN', 'Solo administración gestiona los usuarios internos')
    }
    return
  }
  if (auth.organizationId === inv.organizationId && auth.membershipRole === 'OWNER') {
    if (auth.organizationStatus !== 'ACTIVE') {
      throw new ApiError(403, 'ORG_NOT_ACTIVE', 'La bodega no está activa', [fieldError(null, auth.organizationStatus ?? 'INVITED')])
    }
    return
  }
  throw notFound(`Invitación con identificador "${inv.id}" no encontrada`)
}

export function resendInvitation(ctx: RouteContext, inv: StoredInvitation, reason: string | null): Invitation {
  const status = effectiveInvitationStatus(inv, now())
  if (status !== 'PENDING' && status !== 'EXPIRED') {
    throw domainError(409, 'INVITATION_NOT_PENDING', `Solo se reenvían invitaciones pendientes o caducadas (esta está ${status})`)
  }
  const at = stamp()
  inv.status = 'PENDING'
  inv.expiresAt = new Date(Date.parse(at) + invitationTtlHours() * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  inv._mock.token = portableToken(inv)
  sendInvitationMail(inv)
  recordAudit(ctx, {
    action: 'INVITATION_RESENT',
    resource: { type: 'INVITATION', id: inv.id },
    organizationId: inv.organizationId,
    before: { status },
    after: { status: 'PENDING', expiresAt: inv.expiresAt },
    reason,
  })
  return toInvitation(inv, now())
}

export function revokeInvitation(ctx: RouteContext, inv: StoredInvitation, reason: string | null): Invitation {
  const status = effectiveInvitationStatus(inv, now())
  if (status !== 'PENDING') throw domainError(409, 'INVITATION_NOT_PENDING', `Solo se anulan invitaciones pendientes (esta está ${status})`)
  inv.status = 'REVOKED'
  inv._mock.revokedAt = stamp()
  recordAudit(ctx, {
    action: 'INVITATION_REVOKED',
    resource: { type: 'INVITATION', id: inv.id },
    organizationId: inv.organizationId,
    before: { status: 'PENDING' },
    after: { status: 'REVOKED' },
    reason,
  })
  return toInvitation(inv, now())
}

/** Invitaciones de una organización (más recientes primero), con filtro por estado. */
export function invitationsOf(organizationId: string, status: string | undefined): Invitation[] {
  const nowIso = now()
  return bo()
    .invitations.filter((i) => i.organizationId === organizationId)
    .map((i) => toInvitation(i, nowIso))
    .filter((i) => !status || i.status === status)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

export const invitationRoutes: RouteSpec[] = [
  {
    method: 'get',
    path: '/v1/invitations/:token',
    access: 'public',
    handle: ({ params }) => ok(preview(findInvitationByToken(params.token!))),
  },
  {
    method: 'post',
    path: '/v1/invitations/:token/accept',
    access: 'public',
    handle: accept,
  },
  {
    method: 'post',
    path: '/v1/invitations/:id/resend',
    access: anyUser,
    async handle(ctx) {
      const body = await parseBody(ctx.request, InvitationActionSchema)
      const inv = findInvitationById(ctx.params.id!)
      assertCanManage(ctx.auth, inv)
      return ok(resendInvitation(ctx, inv, body.reason ?? null))
    },
  },
  {
    method: 'post',
    path: '/v1/invitations/:id/revoke',
    access: anyUser,
    async handle(ctx) {
      const body = await parseBody(ctx.request, InvitationActionSchema)
      const inv = findInvitationById(ctx.params.id!)
      assertCanManage(ctx.auth, inv)
      return ok(revokeInvitation(ctx, inv, body.reason ?? null))
    },
  },
  {
    method: 'get',
    path: '/v1/organizations/current/invitations',
    access: orgMember(['OWNER']),
    list: 'paged',
    handle({ auth, query }) {
      const status = enumParam(query, 'status', INVITATION_STATUSES)
      return listResult(invitationsOf(auth.organizationId!, status), query)
    },
  },
  {
    method: 'post',
    path: '/v1/organizations/current/invitations',
    access: orgMember(['OWNER']),
    async handle(ctx) {
      const body = await parseBody(ctx.request, CreateInvitationSchema)
      const winery = findWinery(ctx.auth.organizationId!)
      const inv = createInvitation(ctx, {
        target: wineryTarget(winery),
        email: body.email,
        role: body.role,
        invitedBy: ctx.auth.user,
        viaPlatform: false,
      })
      return created(toInvitation(inv, now()))
    },
  },
]

