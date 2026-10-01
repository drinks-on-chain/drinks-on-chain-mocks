import { PLATFORM_ORGANIZATION } from '../../erp/catalog'
import { anyStaff, membershipsOf, orgMember, platform, type AuthContext } from '../../erp/handlers/auth-context'
import { getErpDb } from '../../erp/handlers/db'
import { ApiError, domainError, fieldError, notFound } from '../../erp/handlers/errors'
import { created, enumParam, listResult, ok, parseBody, accepted, type RouteContext, type RouteSpec } from '../../erp/handlers/http'
import { revokeAllSessions, revokeSessionsOfOrganization } from '../../erp/handlers/sessions'
import { MEMBERSHIP_ROLES, type MockUser, type WineryMemberItem, type WineryResponse } from '../../erp/schemas'
import { toInvitation } from '../model'
import { PERMISSION_MATRIX } from '../permissions'
import {
  CreatePlatformUserSchema,
  INVITATION_STATUSES,
  MEMBER_STATUSES,
  MemberBlockSchema,
  PlatformActionSchema,
  PlatformCreateInvitationSchema,
  PlatformUpdateMemberRoleSchema,
  SendPasswordResetSchema,
  UpdateMemberRoleSchema,
  UpdatePlatformUserSchema,
  type Member,
  type UserAccountStatus,
} from '../schemas'
import { issuePasswordReset, mfaOf } from './identity'
import { assertTeamCapacity, createInvitation, invitationsOf, platformTarget, wineryTarget } from './invitations'
import {
  accountDetail,
  blockOf,
  findWineryMember,
  membersOfWinery,
  notifyOwner,
  notifyPerson,
  platformMembershipId,
  platformRoleOf,
  platformStaff,
  platformUsers,
  setMemberBlocked,
  setMemberRole,
  staffByMembershipId,
  toMember,
  toPlatformUser,
} from './members'
import { bo, findWinery, now, recordAudit } from './support'

// Equipo de una organización y usuarios internos (contrato de la Ola 1 §5).

const TEAM_STAFF = platform(['ADMIN', 'OPERATIONS', 'SUPPORT'])
const ADMINS = platform(['ADMIN'])

function filterMembers(members: Member[], query: URLSearchParams): Member[] {
  const status = enumParam(query, 'status', MEMBER_STATUSES)
  const role = enumParam(query, 'role', MEMBERSHIP_ROLES)
  return members.filter((m) => (!status || m.status === status) && (!role || m.role === role))
}

function memberAudit(
  ctx: RouteContext,
  winery: WineryResponse,
  member: WineryMemberItem,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  reason: string | null,
) {
  recordAudit(ctx, { action, resource: { type: 'membership', id: member.id }, organizationId: winery.id, before, after, reason })
}

// ---------------------------------------------------------------------------
// Reglas comunes (dueño y back office)
// ---------------------------------------------------------------------------

function changeRole(ctx: RouteContext, winery: WineryResponse, member: WineryMemberItem, role: WineryMemberItem['memberRole'], reason: string | null, viaPlatform: boolean) {
  if (role === 'OWNER' || member.memberRole === 'OWNER') {
    throw domainError(403, 'ORG_OWNER_ROLE_RESERVED', 'El rol de dueño solo cambia con la transferencia de titularidad')
  }
  const view = viaPlatform ? 'PLATFORM' : 'FULL'
  if (member.memberRole === role) return toMember(member, view)
  const before = member.memberRole
  setMemberRole(winery, member, role)
  memberAudit(ctx, winery, member, 'MEMBER_ROLE_CHANGED', { role: before }, { role }, reason)
  if (viaPlatform) {
    notifyOwner(winery, `Cambio en el equipo de ${winery.commercialName}`, [
      `El equipo de Drinks on Chain cambió el rol de ${member.fullName} a ${role}.`,
      ...(reason ? [`Motivo: ${reason}`] : []),
    ], member.userId)
  }
  // El rol viaja en el acceso: se cierran sus sesiones con esa bodega activa (`ROLE_CHANGED`).
  revokeSessionsOfOrganization(winery.id, member.userId)
  return toMember(member, view)
}

function block(ctx: RouteContext, winery: WineryResponse, member: WineryMemberItem, reason: string | null, viaPlatform: boolean) {
  if (!member.isActive) throw domainError(409, 'CONFLICT', 'El miembro ya está bloqueado')
  setMemberBlocked(winery, member, { by: viaPlatform ? 'PLATFORM' : 'OWNER', reason })
  memberAudit(ctx, winery, member, 'MEMBER_BLOCKED', { status: 'ACTIVE', blockedBy: null }, { status: 'BLOCKED', blockedBy: viaPlatform ? 'PLATFORM' : 'OWNER' }, reason)
  if (viaPlatform) {
    notifyOwner(winery, `Cambio en el equipo de ${winery.commercialName}`, [
      `El equipo de Drinks on Chain bloqueó a ${member.fullName} en ${winery.commercialName}.`,
      ...(reason ? [`Motivo: ${reason}`] : []),
    ], member.userId)
  }
  return toMember(member, viaPlatform ? 'PLATFORM' : 'FULL')
}

function unblock(ctx: RouteContext, winery: WineryResponse, member: WineryMemberItem, reason: string | null, viaPlatform: boolean) {
  if (member.isActive) throw domainError(409, 'CONFLICT', 'El miembro no está bloqueado')
  const by = blockOf(member.id)?.by ?? 'OWNER'
  if (!viaPlatform && by === 'PLATFORM') {
    throw domainError(403, 'ORG_BLOCKED_BY_PLATFORM', 'Este bloqueo lo hizo el equipo de Drinks on Chain: solo la plataforma puede levantarlo')
  }
  // Como el backend: desbloquear respeta el límite de colaboradores (activos + invitaciones pendientes).
  assertTeamCapacity(winery.id)
  setMemberBlocked(winery, member, null)
  memberAudit(ctx, winery, member, 'MEMBER_UNBLOCKED', { status: 'BLOCKED', blockedBy: by }, { status: 'ACTIVE' }, reason)
  if (viaPlatform) {
    notifyOwner(winery, `Cambio en el equipo de ${winery.commercialName}`, [
      `El equipo de Drinks on Chain desbloqueó a ${member.fullName} en ${winery.commercialName}.`,
      ...(reason ? [`Motivo: ${reason}`] : []),
    ], member.userId)
  }
  return toMember(member, viaPlatform ? 'PLATFORM' : 'FULL')
}

/** Nadie (dueño ni back office) se cambia ni se bloquea a sí mismo. */
function assertNotSelf(auth: AuthContext, member: WineryMemberItem) {
  if (member.userId === auth.user.id) throw domainError(403, 'ORG_CANNOT_MODIFY_SELF', 'No puedes cambiar ni bloquear tu propia membresía')
}

/** Bodega de una ruta del back office (`/platform/organizations/{organizationId}/…`): solo bodegas (si no, 404). */
function platformWinery(organizationId: string): WineryResponse {
  const w = getErpDb().wineries.find((x) => x.id === organizationId)
  if (!w) throw domainError(404, 'ORG_NOT_FOUND', 'Organización no encontrada')
  return w
}

/** Miembro del back office: de esa bodega (404) y que no sea quien actúa (403). */
function platformMember(ctx: RouteContext, winery: WineryResponse): WineryMemberItem {
  const member = findWineryMember(winery, ctx.params.membershipId!)
  assertNotSelf(ctx.auth, member)
  return member
}

// ---------------------------------------------------------------------------
// Usuarios internos
// ---------------------------------------------------------------------------

function assertNotSuperadmin(user: MockUser) {
  const isSuperadmin = membershipsOf(user).some((m) => m.organizationType === 'PLATFORM' && m.role === 'SUPERADMIN')
  if (isSuperadmin) {
    throw domainError(403, 'PLATFORM_SUPERADMIN_PROTECTED', 'El superusuario no se puede bloquear ni degradar')
  }
}

function accountStatus(user: MockUser): UserAccountStatus {
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.isActive ? 'ACTIVE' : 'BLOCKED',
    blockedReason: user.isActive ? null : (bo().accountBlocks[user.id] ?? null),
  }
}

/**
 * `POST /v1/platform/users/{membershipId}/block|unblock`: bloquea o desbloquea la membresía de
 * plataforma de un usuario interno (contrato de la Ola 1 §11 bis). La cuenta completa se bloquea
 * con `/v1/platform/accounts/{userId}/…`.
 */
function platformBlock(ctx: RouteContext, id: string, reason: string, blocked: boolean) {
  const staffUser = platformStaff().find((u) => platformMembershipId(u.id) === id)
  if (!staffUser) throw notFound(`Membresía de plataforma "${id}" no encontrada`)
  assertNotSuperadmin(staffUser)
  if (staffUser.id === ctx.auth.user.id) throw domainError(403, 'ORG_CANNOT_MODIFY_SELF', 'No puedes bloquearte a ti mismo')
  const state = bo()
  const membershipId = platformMembershipId(staffUser.id)
  const isBlocked = state.blocks.some((b) => b.membershipId === membershipId)
  if (isBlocked === blocked) throw domainError(409, 'CONFLICT', blocked ? 'Ya está bloqueado' : 'No está bloqueado')
  state.blocks = state.blocks.filter((b) => b.membershipId !== membershipId)
  if (blocked) {
    state.blocks.push({ membershipId, organizationId: PLATFORM_ORGANIZATION.id, by: 'PLATFORM', reason, at: now() })
    revokeSessionsOfOrganization(PLATFORM_ORGANIZATION.id, staffUser.id)
  }
  recordAudit(ctx, {
    action: blocked ? 'PLATFORM_USER_BLOCKED' : 'PLATFORM_USER_UNBLOCKED',
    resource: { type: 'membership', id: membershipId },
    organizationId: PLATFORM_ORGANIZATION.id,
    before: { status: blocked ? 'ACTIVE' : 'BLOCKED' },
    after: { status: blocked ? 'BLOCKED' : 'ACTIVE' },
    reason,
  })
  return ok(toPlatformUser(staffUser))
}

/**
 * `POST /v1/platform/accounts/{userId}/block|unblock`: la cuenta completa de una persona
 * (`UserAccountStatus`; revoca todas sus sesiones). Solo administración (contrato de la Ola 1 §11 bis).
 */
function accountBlock(ctx: RouteContext, id: string, reason: string, blocked: boolean) {
  const user = findAccount(id)
  assertNotSuperadmin(user)
  if (user.id === ctx.auth.user.id) throw domainError(403, 'ORG_CANNOT_MODIFY_SELF', 'No puedes bloquear tu propia cuenta')
  if (user.isActive !== blocked) throw domainError(409, 'CONFLICT', blocked ? 'La cuenta ya está bloqueada' : 'La cuenta no está bloqueada')
  user.isActive = !blocked
  const state = bo()
  state.accountBlocks[user.id] = blocked ? reason.slice(0, 500) : null
  state.accountBlockedAt ??= {}
  if (blocked) state.accountBlockedAt[user.id] = now()
  else delete state.accountBlockedAt[user.id]
  if (blocked) revokeAllSessions(user.id)
  recordAudit(ctx, {
    action: blocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED',
    resource: { type: 'user', id: user.id },
    organizationId: null,
    before: { isActive: blocked },
    after: { isActive: !blocked },
    reason,
  })
  return ok(accountStatus(user))
}

/** Persona por id (404 `USER_NOT_FOUND`, como el backend). */
function findAccount(id: string): MockUser {
  const user = getErpDb().users.find((u) => u.id === id)
  if (!user) throw domainError(404, 'USER_NOT_FOUND', 'Persona no encontrada')
  return user
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

export const teamRoutes: RouteSpec[] = [
  // Equipo de la bodega activa (dueño)
  {
    method: 'get',
    path: '/v1/organizations/current/members',
    access: orgMember(),
    list: 'paged',
    handle({ auth, query }) {
      const winery = findWinery(auth.organizationId!)
      // El dueño ve todo; los demás roles, solo nombres y roles de los miembros activos (`lastLoginAt: null`).
      const owner = auth.membershipRole === 'OWNER'
      const members = membersOfWinery(winery, owner ? 'FULL' : 'BASIC').filter((m) => owner || m.status === 'ACTIVE')
      return listResult(filterMembers(members, query), query)
    },
  },
  {
    method: 'patch',
    path: '/v1/organizations/current/members/:membershipId',
    access: orgMember(['OWNER']),
    async handle(ctx) {
      const body = await parseBody(ctx.request, UpdateMemberRoleSchema)
      const winery = findWinery(ctx.auth.organizationId!)
      const member = findWineryMember(winery, ctx.params.membershipId!)
      assertNotSelf(ctx.auth, member)
      return ok(changeRole(ctx, winery, member, body.role, null, false))
    },
  },
  {
    method: 'post',
    path: '/v1/organizations/current/members/:membershipId/block',
    access: orgMember(['OWNER']),
    async handle(ctx) {
      const body = await parseBody(ctx.request, MemberBlockSchema)
      const winery = findWinery(ctx.auth.organizationId!)
      const member = findWineryMember(winery, ctx.params.membershipId!)
      assertNotSelf(ctx.auth, member)
      return ok(block(ctx, winery, member, body.reason ?? null, false))
    },
  },
  {
    method: 'post',
    path: '/v1/organizations/current/members/:membershipId/unblock',
    access: orgMember(['OWNER']),
    async handle(ctx) {
      const body = await parseBody(ctx.request, MemberBlockSchema)
      const winery = findWinery(ctx.auth.organizationId!)
      const member = findWineryMember(winery, ctx.params.membershipId!)
      assertNotSelf(ctx.auth, member)
      return ok(unblock(ctx, winery, member, body.reason ?? null, false))
    },
  },
  // Equipo de cualquier bodega (back office)
  {
    method: 'get',
    path: '/v1/platform/organizations/:organizationId/members',
    access: TEAM_STAFF,
    list: 'paged',
    handle({ params, query }) {
      return listResult(filterMembers(membersOfWinery(platformWinery(params.organizationId!), 'PLATFORM'), query), query)
    },
  },
  {
    method: 'patch',
    path: '/v1/platform/organizations/:organizationId/members/:membershipId',
    access: TEAM_STAFF,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformUpdateMemberRoleSchema)
      const winery = platformWinery(ctx.params.organizationId!)
      return ok(changeRole(ctx, winery, platformMember(ctx, winery), body.role, body.reason, true))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/organizations/:organizationId/members/:membershipId/block',
    access: TEAM_STAFF,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformActionSchema)
      const winery = platformWinery(ctx.params.organizationId!)
      return ok(block(ctx, winery, platformMember(ctx, winery), body.reason, true))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/organizations/:organizationId/members/:membershipId/unblock',
    access: TEAM_STAFF,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformActionSchema)
      const winery = platformWinery(ctx.params.organizationId!)
      return ok(unblock(ctx, winery, platformMember(ctx, winery), body.reason, true))
    },
  },
  {
    // Ampliación del contrato de la Ola 1 (§11 bis): invitaciones de una bodega (las de plataforma, en `/platform/users`).
    method: 'get',
    path: '/v1/platform/organizations/:organizationId/invitations',
    access: TEAM_STAFF,
    list: 'paged',
    handle({ params, query }) {
      const winery = platformWinery(params.organizationId!)
      const status = enumParam(query, 'status', INVITATION_STATUSES)
      return listResult(invitationsOf(winery.id, status), query)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/organizations/:organizationId/invitations',
    access: TEAM_STAFF,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformCreateInvitationSchema)
      const winery = platformWinery(ctx.params.organizationId!)
      if (winery.certificationStatus !== 'ACTIVE' && winery.certificationStatus !== 'SUSPENDED') {
        throw new ApiError(403, 'ORG_NOT_ACTIVE', 'La bodega no está activa', [fieldError(null, winery.certificationStatus)])
      }
      const inv = createInvitation(ctx, {
        target: wineryTarget(winery),
        email: body.email,
        role: body.role,
        invitedBy: ctx.auth.user,
        viaPlatform: true,
        reason: body.reason ?? null,
      })
      notifyOwner(winery, `Invitación nueva en ${winery.commercialName}`, [
        `El equipo de Drinks on Chain invitó a ${inv.email} con el rol ${inv.role}.`,
        ...(body.reason ? [`Motivo: ${body.reason}`] : []),
      ])
      return created(toInvitation(inv, now()))
    },
  },
  // Usuarios internos
  {
    method: 'get',
    path: '/v1/platform/users',
    access: ADMINS,
    list: 'paged',
    handle({ query }) {
      const status = enumParam(query, 'status', ['ACTIVE', 'BLOCKED', 'INVITED'] as const)
      const role = enumParam(query, 'role', ['SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT'] as const)
      const items = platformUsers().filter((u) => (!status || u.status === status) && (!role || u.role === role))
      return listResult(items, query)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/users',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, CreatePlatformUserSchema)
      const inv = createInvitation(ctx, {
        target: platformTarget,
        email: body.email,
        role: body.role,
        invitedBy: ctx.auth.user,
        viaPlatform: true,
        reason: body.reason ?? null,
      })
      return created(toInvitation(inv, now()))
    },
  },
  {
    method: 'patch',
    path: '/v1/platform/users/:membershipId',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, UpdatePlatformUserSchema)
      const user = staffByMembershipId(ctx.params.membershipId!)
      assertNotSuperadmin(user)
      if (body.role && body.role !== platformRoleOf(user)) {
        if (user.id === ctx.auth.user.id) throw domainError(403, 'ORG_CANNOT_MODIFY_SELF', 'No puedes cambiar tu propio rol')
        const before = platformRoleOf(user)
        user._mock.platformRole = body.role
        // El rol viaja en el acceso: se cierran sus sesiones con la plataforma activa (`ROLE_CHANGED`).
        revokeSessionsOfOrganization(PLATFORM_ORGANIZATION.id, user.id)
        recordAudit(ctx, {
          action: 'PLATFORM_USER_ROLE_CHANGED',
          resource: { type: 'membership', id: platformMembershipId(user.id) },
          organizationId: PLATFORM_ORGANIZATION.id,
          before: { role: before },
          after: { role: body.role },
          reason: body.reason,
        })
      }
      return ok(toPlatformUser(user))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/users/:membershipId/block',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformActionSchema)
      return platformBlock(ctx, ctx.params.membershipId!, body.reason, true)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/users/:membershipId/unblock',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformActionSchema)
      return platformBlock(ctx, ctx.params.membershipId!, body.reason, false)
    },
  },
  {
    // Ampliación del contrato de la Ola 1 (§11 bis): estado de la cuenta completa y sus membresías.
    method: 'get',
    path: '/v1/platform/accounts/:userId',
    access: TEAM_STAFF,
    handle: ({ params }) => ok(accountDetail(findAccount(params.userId!))),
  },
  {
    method: 'post',
    path: '/v1/platform/accounts/:userId/block',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformActionSchema)
      return accountBlock(ctx, ctx.params.userId!, body.reason, true)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/accounts/:userId/unblock',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformActionSchema)
      return accountBlock(ctx, ctx.params.userId!, body.reason, false)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/users/:userId/send-password-reset',
    access: TEAM_STAFF,
    async handle(ctx) {
      const body = await parseBody(ctx.request, SendPasswordResetSchema)
      const user = findAccount(ctx.params.userId!)
      issuePasswordReset(ctx, user, user._mock.platformRole ? 'BACKOFFICE' : 'ERP')
      recordAudit(ctx, {
        action: 'USER_PASSWORD_RESET_SENT',
        resource: { type: 'user', id: user.id },
        organizationId: null,
        reason: body.reason ?? null,
      })
      return accepted()
    },
  },
  {
    method: 'post',
    path: '/v1/platform/users/:membershipId/reset-mfa',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, PlatformActionSchema)
      const user = staffByMembershipId(ctx.params.membershipId!)
      if (platformRoleOf(user) === 'SUPERADMIN' && ctx.auth.platformRole !== 'SUPERADMIN') {
        throw domainError(403, 'PLATFORM_SUPERADMIN_PROTECTED', 'El segundo factor del superusuario solo lo restablece otro superusuario')
      }
      const state = bo()
      const wasEnabled = Boolean(mfaOf(user.id)?.enrolled)
      state.mfa = state.mfa.filter((m) => m.userId !== user.id)
      state.mfa.push({ userId: user.id, enrolled: false, secret: null, enrolledAt: null, recoveryCodes: [] })
      revokeAllSessions(user.id)
      notifyPerson(user, 'MFA_RESET', 'Tu segundo factor se restableció', [
        'El equipo de administración restableció tu segundo factor.',
        'La próxima vez que inicies sesión tendrás que inscribir de nuevo tu app de autenticación.',
      ])
      recordAudit(ctx, {
        action: 'MFA_RESET',
        resource: { type: 'membership', id: platformMembershipId(user.id) },
        organizationId: PLATFORM_ORGANIZATION.id,
        before: { mfaEnabled: wasEnabled },
        after: { mfaEnabled: false },
        reason: body.reason,
      })
      return ok(toPlatformUser(user))
    },
  },
  {
    method: 'get',
    path: '/v1/platform/permissions',
    access: anyStaff,
    handle: () => ok(PERMISSION_MATRIX),
  },
]
