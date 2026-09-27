import { PLATFORM_ORGANIZATION } from '../../erp/catalog'
import { membershipsOf } from '../../erp/handlers/auth-context'
import { getErpDb } from '../../erp/handlers/db'
import { notFound } from '../../erp/handlers/errors'
import { revokeSessionsOfOrganization } from '../../erp/handlers/sessions'
import { uid } from '../../shared/uuid'
import type { MemberRole, MockUser, PlatformRole, WineryMemberItem, WineryResponse } from '../../erp/schemas'
import { simpleMail } from '../mail'
import { effectiveInvitationStatus, toInvitation, type MemberBlock } from '../model'
import type { AccountDetail, AccountMembership, BlockedBy, Member, PlatformUser } from '../schemas'
import { bo, findUser, now, sendMail } from './support'

// Miembros de una bodega y personal de plataforma (contrato de la Ola 1 §5).

export function blockOf(membershipId: string): MemberBlock | undefined {
  return bo().blocks.find((b) => b.membershipId === membershipId)
}

/**
 * Cómo se ve el equipo (`TeamService` del backend): `FULL` (dueño), `BASIC` (el resto de roles:
 * `lastLoginAt: null`) o `PLATFORM` (back office: además el estado de la cuenta completa).
 */
export type TeamView = 'FULL' | 'BASIC' | 'PLATFORM'

/** Estado de la cuenta completa de una persona (`users.is_active`). */
export function accountStatusOf(user: MockUser | undefined): { accountStatus: 'ACTIVE' | 'BLOCKED'; accountBlockedReason: string | null } {
  const blocked = Boolean(user && !user.isActive)
  return { accountStatus: blocked ? 'BLOCKED' : 'ACTIVE', accountBlockedReason: blocked ? (bo().accountBlocks[user!.id] ?? null) : null }
}

export function toMember(item: WineryMemberItem, view: TeamView = 'FULL'): Member {
  const block = item.isActive ? undefined : blockOf(item.id)
  const user = findUser(item.userId)
  return {
    membershipId: item.id,
    userId: item.userId,
    fullName: item.fullName,
    email: item.email,
    role: item.memberRole,
    status: item.isActive ? 'ACTIVE' : 'BLOCKED',
    blockedBy: item.isActive ? null : (block?.by ?? 'OWNER'),
    blockedReason: item.isActive ? null : (block?.reason ?? null),
    joinedAt: item.joinedAt,
    lastLoginAt: view === 'BASIC' ? null : (user?.lastLoginAt ?? null),
    ...(view === 'PLATFORM' ? accountStatusOf(user) : {}),
  }
}

/** Miembros de una bodega por antigüedad (como el backend: `createdAt` ascendente). */
export function membersOfWinery(winery: WineryResponse, view: TeamView = 'FULL'): Member[] {
  return [...(winery.members ?? [])]
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id))
    .map((m) => toMember(m, view))
}

/** Membresía de esa bodega (la de otra organización o inexistente → 404 `NOT_FOUND`). */
export function findWineryMember(winery: WineryResponse, membershipId: string): WineryMemberItem {
  const m = winery.members?.find((x) => x.id === membershipId)
  if (!m) throw notFound('Miembro no encontrado')
  return m
}

/** Enlace de la membresía en el perfil de la persona (`wineryMemberships`). */
function linkOf(winery: WineryResponse, member: WineryMemberItem) {
  return findUser(member.userId)?.wineryMemberships.find((m) => m.wineryId === winery.id)
}

/** Bloquea o desbloquea una membresía de bodega (y revoca sus sesiones en esa organización). */
export function setMemberBlocked(
  winery: WineryResponse,
  member: WineryMemberItem,
  blocked: { by: BlockedBy; reason: string | null } | null,
): void {
  const state = bo()
  member.isActive = blocked === null
  const link = linkOf(winery, member)
  if (link) link.isActive = member.isActive
  state.blocks = state.blocks.filter((b) => b.membershipId !== member.id)
  if (blocked) {
    state.blocks.push({ membershipId: member.id, organizationId: winery.id, by: blocked.by, reason: blocked.reason, at: now() })
    revokeSessionsOfOrganization(winery.id, member.userId)
  }
}

export function setMemberRole(winery: WineryResponse, member: WineryMemberItem, role: MemberRole): void {
  member.memberRole = role
  const link = linkOf(winery, member)
  if (link) link.memberRole = role
}

/** Miembros activos + invitaciones pendientes (cuentan para `equipo.maxColaboradoresPorBodega`). */
export function teamSize(organizationId: string): number {
  const winery = getErpDb().wineries.find((w) => w.id === organizationId)
  const active = (winery?.members ?? []).filter((m) => m.isActive).length
  const pending = bo().invitations.filter(
    (i) => i.organizationId === organizationId && effectiveInvitationStatus(i, now()) === 'PENDING',
  ).length
  return active + pending
}

/** Aviso al dueño de un cambio que hizo el back office en su equipo (EQP-10), salvo que sea el afectado. */
export function notifyOwner(winery: WineryResponse, subject: string, lines: string[], exceptUserId: string | null = null): void {
  const owner = winery.members?.find((m) => m.memberRole === 'OWNER' && m.isActive)
  if (!owner || owner.userId === exceptUserId) return
  sendMail(simpleMail(owner.email, 'TEAM_CHANGED_BY_PLATFORM', subject, lines))
}

// ---------------------------------------------------------------------------
// Personal de plataforma
// ---------------------------------------------------------------------------

export const platformMembershipId = (userId: string) => uid(`membership:platform:${userId}`)

/** Personas con membresía de plataforma (activa o bloqueada). */
export function platformStaff(): MockUser[] {
  return getErpDb().users.filter((u) => membershipsOf(u).some((m) => m.organizationType === 'PLATFORM'))
}

export function platformRoleOf(user: MockUser): PlatformRole {
  return user._mock.platformRole ?? 'SUPERADMIN'
}

export function toPlatformUser(user: MockUser): PlatformUser {
  const membershipId = platformMembershipId(user.id)
  const membership = membershipsOf(user).find((m) => m.organizationType === 'PLATFORM')
  const block = blockOf(membershipId)
  const blocked = membership?.status === 'BLOCKED' || !user.isActive
  return {
    membershipId,
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    role: platformRoleOf(user),
    status: blocked ? 'BLOCKED' : 'ACTIVE',
    blockedBy: blocked ? 'PLATFORM' : null,
    blockedReason: blocked ? (block?.reason ?? bo().accountBlocks[user.id] ?? null) : null,
    joinedAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
    mfaEnabled: Boolean(bo().mfa.find((m) => m.userId === user.id)?.enrolled),
    invitationId: null,
    ...accountStatusOf(user),
  }
}

/** Usuarios internos: miembros de la plataforma + invitaciones pendientes (`status: 'INVITED'`). */
export function platformUsers(): PlatformUser[] {
  const members = platformStaff().map(toPlatformUser)
  const nowIso = now()
  const invited: PlatformUser[] = bo()
    .invitations.filter((i) => i.organizationId === PLATFORM_ORGANIZATION.id && effectiveInvitationStatus(i, nowIso) === 'PENDING')
    .map((i) => {
      const inv = toInvitation(i, nowIso)
      const existing = getErpDb().users.find((u) => u.email.toLowerCase() === inv.email.toLowerCase())
      return {
        membershipId: null,
        userId: existing?.id ?? null,
        // Como el backend: el nombre de la cuenta o, sin cuenta, el correo.
        fullName: existing?.fullName ?? inv.email,
        email: inv.email,
        role: inv.role as PlatformRole,
        status: 'INVITED',
        blockedBy: null,
        blockedReason: null,
        joinedAt: null,
        lastLoginAt: null,
        mfaEnabled: false,
        invitationId: inv.id,
        ...(existing ? accountStatusOf(existing) : { accountStatus: null, accountBlockedReason: null }),
      }
    })
  return [...members, ...invited]
}

/** `GET /v1/platform/accounts/{userId}`: estado de la cuenta y sus membresías (por antigüedad). */
export function accountDetail(user: MockUser): AccountDetail {
  const { accountStatus, accountBlockedReason } = accountStatusOf(user)
  const memberships: AccountMembership[] = membershipsOf(user).map((m) => {
    const block = m.status === 'BLOCKED' ? blockOf(m.id) : undefined
    return {
      membershipId: m.id,
      organizationId: m.organizationId,
      organizationType: m.organizationType,
      organizationName: m.organizationName,
      organizationStatus: m.organizationStatus,
      role: m.role,
      status: m.status,
      blockedBy: m.status === 'BLOCKED' ? (block?.by ?? 'PLATFORM') : null,
      blockedReason: m.status === 'BLOCKED' ? (block?.reason ?? null) : null,
    }
  })
  return {
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    status: accountStatus,
    blockedReason: accountBlockedReason,
    blockedAt: accountStatus === 'BLOCKED' ? (bo().accountBlockedAt?.[user.id] ?? null) : null,
    memberships,
  }
}

/** Persona de plataforma por id de membresía (404 si no existe). */
export function staffByMembershipId(membershipId: string): MockUser {
  const user = platformStaff().find((u) => platformMembershipId(u.id) === membershipId)
  if (!user) throw notFound('Membresía de plataforma no encontrada')
  return user
}

/** Aviso por correo a una persona (bloqueos de cuenta, 2FA restablecido…). */
export function notifyPerson(user: MockUser, template: 'MFA_RESET' | 'TEAM_CHANGED_BY_PLATFORM', subject: string, lines: string[]): void {
  sendMail(simpleMail(user.email, template, subject, lines))
}
