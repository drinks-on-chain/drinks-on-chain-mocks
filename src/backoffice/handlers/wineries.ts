import { anyStaff, orgMember, platform } from '../../erp/handlers/auth-context'
import { getErpDb } from '../../erp/handlers/db'
import { domainError, notFound } from '../../erp/handlers/errors'
import { enumParam, listResult, ok, parseBody, strParam, created, type RouteContext, type RouteSpec } from '../../erp/handlers/http'
import { revokeSessionsOfOrganization } from '../../erp/handlers/sessions'
import type { WineryResponse } from '../../erp/schemas'
import { simpleMail } from '../mail'
import { toInvitation } from '../model'
import {
  CreatePlatformWinerySchema,
  TransferOwnershipSchema,
  UpdateCurrentOrganizationSchema,
  UpdatePlatformWinerySchema,
  WINERY_CATEGORIES,
  WINERY_STATUSES,
  WineryStatusActionSchema,
  type PublicWineryProfile,
  type WinerySummary,
  type WineryStatus,
} from '../schemas'
import { createInvitedWinery, taxIdTaken } from './applications'
import { createInvitation, wineryTarget } from './invitations'
import { bo, findWinery, now, ownerEmailOf, profileOf, recordAudit, sendMail, setWineryStatus, wineryDetail } from './support'

// Bodegas en el back office, perfil de la organización activa y perfil público (contrato de la
// Ola 1 §4).

const WRITERS = platform(['ADMIN', 'OPERATIONS'])
const ADMINS = platform(['ADMIN'])

function summary(w: WineryResponse): WinerySummary {
  const d = wineryDetail(w)
  return {
    id: d.id,
    slug: d.slug,
    legalName: d.legalName,
    tradeName: d.tradeName,
    taxId: d.taxId,
    category: d.category,
    region: d.region,
    status: d.status,
    lotPrefix: d.lotPrefix,
    owner: d.owner,
    membersCount: d.membersCount,
    createdAt: d.createdAt,
    activatedAt: d.activatedAt,
  }
}

/** Aplica los campos del perfil (Ola 1) al DTO del ERP y al perfil guardado. */
function applyProfile(w: WineryResponse, body: Record<string, unknown>): Record<string, unknown> {
  const profile = profileOf(w)
  const before: Record<string, unknown> = {}
  const set = (field: string, current: unknown, apply: () => void, value: unknown) => {
    if (value === undefined || value === current) return
    before[field] = current
    apply()
  }
  const b = body as {
    tradeName?: string
    legalName?: string
    taxId?: string
    category?: WineryResponse['beverageCategory']
    region?: string
    address?: string | null
    senasagRegistration?: string | null
    contactEmail?: string
    contactPhone?: string | null
    logoUrl?: string | null
    publicStory?: string | null
    website?: string | null
  }
  set('tradeName', w.commercialName, () => (w.commercialName = b.tradeName!), b.tradeName)
  set('legalName', w.legalName, () => (w.legalName = b.legalName!), b.legalName)
  set('taxId', w.taxIdNit, () => (w.taxIdNit = b.taxId!), b.taxId)
  set('category', w.beverageCategory, () => (w.beverageCategory = b.category!), b.category)
  set('region', w.geographicRegion, () => (w.geographicRegion = b.region!), b.region)
  set('address', w.address ?? null, () => (w.address = b.address ?? null), b.address)
  set('senasagRegistration', w.senasagSanitaryReg ?? null, () => (w.senasagSanitaryReg = b.senasagRegistration ?? null), b.senasagRegistration)
  set('contactEmail', w.contactEmail, () => (w.contactEmail = b.contactEmail!), b.contactEmail)
  set('contactPhone', w.contactPhone ?? null, () => (w.contactPhone = b.contactPhone ?? null), b.contactPhone)
  set('logoUrl', w.logoUrl ?? null, () => (w.logoUrl = b.logoUrl ?? null), b.logoUrl)
  set('publicStory', profile.publicStory, () => (profile.publicStory = b.publicStory ?? null), b.publicStory)
  set('website', profile.website, () => (profile.website = b.website ?? null), b.website)
  // Las membresías guardan el nombre comercial: se mantiene al día.
  if (b.tradeName !== undefined) {
    for (const u of getErpDb().users) for (const m of u.wineryMemberships) if (m.wineryId === w.id) m.wineryName = w.commercialName
  }
  return before
}

function afterOf(w: WineryResponse, keys: string[]): Record<string, unknown> {
  const d = wineryDetail(w) as unknown as Record<string, unknown>
  return Object.fromEntries(keys.map((k) => [k, d[k]]))
}

/** Suspender, reactivar o revocar (con motivo, aviso al dueño y sesiones revocadas). */
function changeStatus(ctx: RouteContext, w: WineryResponse, to: WineryStatus, from: readonly WineryStatus[], action: string, reason: string) {
  if (!from.includes(w.certificationStatus)) {
    throw domainError(409, 'ORG_INVALID_TRANSITION', `La bodega está ${w.certificationStatus} y no puede pasar a ${to}`)
  }
  setWineryStatus(ctx, w, to, { by: ctx.auth.user.fullName, reason, action })
  if (to === 'SUSPENDED' || to === 'REVOKED') revokeSessionsOfOrganization(w.id)
  if (to === 'REVOKED') {
    // Las invitaciones pendientes de una bodega revocada dejan de valer.
    for (const inv of bo().invitations) {
      if (inv.organizationId === w.id && inv.status === 'PENDING') {
        inv.status = 'REVOKED'
        inv._mock.revokedAt = now()
      }
    }
  }
  const owner = ownerEmailOf(w)
  const verb = { SUSPENDED: 'suspendida', ACTIVE: 'reactivada', REVOKED: 'revocada', INVITED: 'invitada' }[to]
  if (owner) {
    sendMail(simpleMail(owner, 'WINERY_STATUS_CHANGED', `${w.commercialName} fue ${verb}`, [`El equipo de Drinks on Chain dejó ${w.commercialName} ${verb}.`, `Motivo: ${reason}`]))
  }
  return ok(wineryDetail(w))
}

export const wineryPlatformRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/platform/wineries',
    access: WRITERS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, CreatePlatformWinerySchema)
      if (taxIdTaken(body.taxId)) throw domainError(409, 'ORG_TAX_ID_TAKEN', `Ya hay una bodega o una solicitud abierta con el NIT ${body.taxId}`)
      const reason = body.reason ?? null
      const winery = createInvitedWinery(ctx, body, reason ?? 'Alta directa')
      const invitation = createInvitation(ctx, {
        target: wineryTarget(winery),
        email: body.ownerEmail,
        role: 'OWNER',
        invitedBy: ctx.auth.user,
        viaPlatform: true,
        inviteeName: body.ownerFullName,
        reason,
        ownerInvite: true,
      })
      return created({ winery: wineryDetail(winery), invitation: toInvitation(invitation, now()) })
    },
  },
  {
    method: 'get',
    path: '/v1/platform/wineries',
    access: anyStaff,
    list: 'paged',
    handle({ query }) {
      const status = enumParam(query, 'status', WINERY_STATUSES)
      const category = enumParam(query, 'category', WINERY_CATEGORIES)
      const region = strParam(query, 'region')?.toLowerCase()
      const q = strParam(query, 'q')?.toLowerCase()
      const items = getErpDb()
        .wineries.filter(
          (w) =>
            (!status || w.certificationStatus === status) &&
            (!category || w.beverageCategory === category) &&
            (!region || w.geographicRegion.toLowerCase().includes(region)) &&
            (!q || [w.legalName, w.commercialName, w.taxIdNit, profileOf(w).slug].some((v) => v.toLowerCase().includes(q))),
        )
        .sort((a, b) => a.commercialName.localeCompare(b.commercialName, 'es'))
        .map(summary)
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/platform/wineries/:id',
    access: anyStaff,
    handle: ({ params }) => ok(wineryDetail(findWinery(params.id!))),
  },
  {
    method: 'patch',
    path: '/v1/platform/wineries/:id',
    access: WRITERS,
    async handle(ctx) {
      const { reason, ...body } = await parseBody(ctx.request, UpdatePlatformWinerySchema)
      const w = findWinery(ctx.params.id!)
      if (body.taxId && body.taxId !== w.taxIdNit && taxIdTaken(body.taxId, null, w.id)) {
        throw domainError(409, 'ORG_TAX_ID_TAKEN', `Ya hay una bodega o una solicitud abierta con el NIT ${body.taxId}`)
      }
      const before = applyProfile(w, body)
      recordAudit(ctx, {
        action: 'WINERY_UPDATED',
        resource: { type: 'WINERY', id: w.id },
        organizationId: w.id,
        before,
        after: afterOf(w, Object.keys(before)),
        reason,
      })
      return ok(wineryDetail(w))
    },
  },
  {
    method: 'post',
    path: '/v1/platform/wineries/:id/suspend',
    access: WRITERS,
    async handle(ctx) {
      const { reason } = await parseBody(ctx.request, WineryStatusActionSchema)
      return changeStatus(ctx, findWinery(ctx.params.id!), 'SUSPENDED', ['ACTIVE'], 'WINERY_SUSPENDED', reason)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/wineries/:id/reactivate',
    access: WRITERS,
    async handle(ctx) {
      const { reason } = await parseBody(ctx.request, WineryStatusActionSchema)
      return changeStatus(ctx, findWinery(ctx.params.id!), 'ACTIVE', ['SUSPENDED'], 'WINERY_REACTIVATED', reason)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/wineries/:id/revoke',
    access: ADMINS,
    async handle(ctx) {
      const { reason } = await parseBody(ctx.request, WineryStatusActionSchema)
      return changeStatus(ctx, findWinery(ctx.params.id!), 'REVOKED', ['INVITED', 'ACTIVE', 'SUSPENDED'], 'WINERY_REVOKED', reason)
    },
  },
  {
    method: 'post',
    path: '/v1/platform/wineries/:id/transfer-ownership',
    access: ADMINS,
    async handle(ctx) {
      const body = await parseBody(ctx.request, TransferOwnershipSchema)
      const w = findWinery(ctx.params.id!)
      if (w.certificationStatus !== 'ACTIVE' && w.certificationStatus !== 'SUSPENDED') {
        throw domainError(409, 'ORG_INVALID_TRANSITION', `No se transfiere la titularidad de una bodega ${w.certificationStatus}`)
      }
      const owner = w.members?.find((m) => m.memberRole === 'OWNER' && m.isActive)
      if (!owner) throw domainError(409, 'CONFLICT', 'La bodega no tiene un dueño activo')
      if (owner.email.toLowerCase() === body.newOwnerEmail.toLowerCase()) {
        throw domainError(409, 'ORG_ALREADY_MEMBER', 'Esa persona ya es la dueña de la bodega')
      }
      const invitation = createInvitation(ctx, {
        target: wineryTarget(w),
        email: body.newOwnerEmail,
        role: 'OWNER',
        invitedBy: ctx.auth.user,
        viaPlatform: true,
        reason: body.reason,
        ownerInvite: true,
        transfer: { previousOwnerMembershipId: owner.id, keepPreviousOwnerAs: body.keepPreviousOwnerAs },
      })
      recordAudit(ctx, {
        action: 'WINERY_OWNERSHIP_TRANSFER_STARTED',
        resource: { type: 'WINERY', id: w.id },
        organizationId: w.id,
        before: { ownerUserId: owner.userId },
        after: { newOwnerEmail: invitation.email, keepPreviousOwnerAs: body.keepPreviousOwnerAs },
        reason: body.reason,
      })
      return ok({ winery: wineryDetail(w), invitation: toInvitation(invitation, now()) })
    },
  },
]

export const wineryOrganizationRoutes: RouteSpec[] = [
  {
    method: 'get',
    path: '/v1/organizations/current',
    access: orgMember(),
    allowInactiveOrg: ['SUSPENDED'],
    handle: ({ auth }) => ok(wineryDetail(findWinery(auth.organizationId!))),
  },
  {
    method: 'patch',
    path: '/v1/organizations/current',
    access: orgMember(['OWNER']),
    async handle(ctx) {
      const body = await parseBody(ctx.request, UpdateCurrentOrganizationSchema)
      const w = findWinery(ctx.auth.organizationId!)
      const before = applyProfile(w, body)
      recordAudit(ctx, {
        action: 'WINERY_UPDATED',
        resource: { type: 'WINERY', id: w.id },
        organizationId: w.id,
        before,
        after: afterOf(w, Object.keys(before)),
      })
      return ok(wineryDetail(w))
    },
  },
  {
    method: 'get',
    path: '/v1/public/wineries/:slug',
    access: 'public',
    handle({ params }) {
      const w = getErpDb().wineries.find((x) => profileOf(x).slug === params.slug)
      if (!w || w.certificationStatus !== 'ACTIVE') throw notFound(`Bodega "${params.slug}" no encontrada`)
      const d = wineryDetail(w)
      const profile: PublicWineryProfile = {
        slug: d.slug,
        tradeName: d.tradeName,
        region: d.region,
        category: d.category,
        logoUrl: d.logoUrl,
        publicStory: d.publicStory,
        website: d.website,
      }
      return ok(profile)
    },
  },
]

