import { fakeHash64, fakeStellarAddress } from '../../../shared/uuid'
import { USER_ROLE_FOR_MEMBER } from '../../derive'
import {
  AddMemberSchema,
  ApproveWinerySchema,
  BEVERAGE_CATEGORIES,
  CERTIFICATION_STATUSES,
  CreateMemberSchema,
  CreateWinerySchema,
  RejectWinerySchema,
  UpdateWinerySchema,
  type MemberRole,
  type MockUser,
  type WineryMemberItem,
  type WineryResponse,
} from '../../schemas'
import { anyStaff, anyUser, platform, winery, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick } from '../db'
import { conflict, domainError, notFound } from '../errors'
import { applyPatch, created, enumParam, listResult, ok, parseBody, strParam, type RouteSpec } from '../http'
import { blockOf, setMemberBlocked } from '../../../backoffice/handlers/members'
import { createUser, findUserByEmail } from './auth-users'

// /v1/wineries*

/** Bodega de la petición: la activa o, para la plataforma, la de `?wineryId=`. */
function myWinery(auth: AuthContext): WineryResponse {
  const w = auth.tenantId ? getErpDb().wineries.find((x) => x.id === auth.tenantId) : undefined
  if (!w) throw notFound('Bodega no encontrada')
  return w
}

function findWinery(id: string): WineryResponse {
  const w = getErpDb().wineries.find((x) => x.id === id)
  if (!w) throw notFound(`Bodega con identificador "${id}" no encontrada`)
  return w
}

/** Añade una membresía de bodega (miembro de la bodega + enlace en el perfil de la persona). */
export function addMembership(
  winery: WineryResponse,
  user: MockUser,
  memberRole: MemberRole,
  professionalLicenseNumber: string | null | undefined,
): WineryMemberItem {
  const joinedAt = tick()
  const member: WineryMemberItem = {
    id: newId('member'),
    userId: user.id,
    fullName: user.fullName,
    email: user.email,
    memberRole,
    professionalLicenseNumber: professionalLicenseNumber ?? null,
    isActive: true,
    joinedAt,
  }
  winery.members = [...(winery.members ?? []), member]
  user.wineryMemberships.push({
    wineryId: winery.id,
    wineryName: winery.commercialName,
    memberRole,
    professionalLicenseNumber: professionalLicenseNumber ?? null,
    isActive: true,
    joinedAt,
  })
  return member
}

/** Aprobar o rechazar solo una bodega pendiente (`INVITED`); si no, 409 `WINERY_NOT_PENDING` como el backend. */
function assertPending(winery: WineryResponse, verb: string): void {
  if (winery.certificationStatus !== 'INVITED') {
    throw domainError(409, 'WINERY_NOT_PENDING', `La bodega se encuentra en estado '${winery.certificationStatus}' y no puede ser ${verb}`)
  }
}

export const wineryRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/wineries',
    access: anyUser,
    async handle({ request, auth }) {
      const body = await parseBody(request, CreateWinerySchema)
      const db = getErpDb()
      if (db.wineries.some((w) => w.taxIdNit === body.taxIdNit)) throw conflict('El NIT ya se encuentra registrado')
      const winery: WineryResponse = {
        id: newId('winery'),
        legalName: body.legalName,
        commercialName: body.commercialName,
        beverageCategory: body.beverageCategory,
        taxIdNit: body.taxIdNit,
        senasagSanitaryReg: body.senasagSanitaryReg ?? null,
        geographicRegion: body.geographicRegion,
        countryCode: body.countryCode ?? 'BO',
        address: body.address ?? null,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone ?? null,
        logoUrl: body.logoUrl ?? null,
        stellarPublicKey: null,
        onchainProducerId: null,
        onchainRegisterTxHash: null,
        isExportCertified: false,
        // `INVITED` sustituye a `PENDING` desde la Ola 1 (autoinscripción *retirada* en H1).
        certificationStatus: 'INVITED',
        approvedAt: null,
        createdAt: tick(),
        members: [],
      }
      db.wineries.push(winery)
      // El solicitante queda como OWNER de la bodega. Su rol global no cambia (SE-01): el rol
      // efectivo sale de la membresía al activar esa organización.
      addMembership(winery, auth.user, 'OWNER', null)
      return created(winery)
    },
  },
  {
    method: 'get',
    path: '/v1/wineries',
    access: anyStaff,
    list: 'paged',
    handle({ query }) {
      // `PENDING` (Ola 0) se acepta como alias de `INVITED`.
      const status = query.get('status') === 'PENDING' ? 'INVITED' : enumParam(query, 'status', CERTIFICATION_STATUSES)
      const category = enumParam(query, 'beverageCategory', BEVERAGE_CATEGORIES)
      const search = strParam(query, 'search')?.toLowerCase()
      const items = getErpDb().wineries.filter(
        (w) =>
          (!status || w.certificationStatus === status) &&
          (!category || w.beverageCategory === category) &&
          (!search ||
            [w.legalName, w.commercialName, w.taxIdNit].some((v) => v.toLowerCase().includes(search))),
      )
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/wineries/my',
    access: winery(),
    // Lectura del perfil permitida con la bodega suspendida (contrato de la Ola 1 §4).
    allowInactiveOrg: ['SUSPENDED'],
    handle: ({ auth }) => ok(myWinery(auth)),
  },
  {
    method: 'patch',
    path: '/v1/wineries/my',
    access: winery(['OWNER']),
    async handle({ request, auth }) {
      const winery = myWinery(auth)
      const body = await parseBody(request, UpdateWinerySchema)
      applyPatch(winery, body)
      return ok(winery)
    },
  },
  {
    method: 'post',
    path: '/v1/wineries/my/members',
    access: winery(['OWNER']),
    async handle({ request, auth }) {
      const winery = myWinery(auth)
      const body = await parseBody(request, AddMemberSchema)
      const user = getErpDb().users.find((u) => u.id === body.userId)
      if (!user) throw notFound('El usuario no existe')
      // Añade o reactiva una membresía de esta bodega; nunca toca roles globales (SE-01).
      const existing = winery.members?.find((m) => m.userId === user.id)
      if (existing?.isActive) throw domainError(409, 'ORG_ALREADY_MEMBER', 'La persona ya es miembro activo de la bodega')
      if (existing) {
        // Lo que bloqueó la plataforma solo lo levanta la plataforma (como el backend).
        if (auth.organizationType !== 'PLATFORM' && blockOf(existing.id)?.by === 'PLATFORM') {
          throw domainError(403, 'ORG_BLOCKED_BY_PLATFORM', 'Este bloqueo lo hizo el equipo de Drinks on Chain: solo la plataforma puede levantarlo')
        }
        setMemberBlocked(winery, existing, null)
        existing.memberRole = body.memberRole
        existing.professionalLicenseNumber = body.professionalLicenseNumber ?? existing.professionalLicenseNumber ?? null
        const link = user.wineryMemberships.find((m) => m.wineryId === winery.id)
        if (link) Object.assign(link, { isActive: true, memberRole: body.memberRole, professionalLicenseNumber: existing.professionalLicenseNumber })
        return created(existing)
      }
      return created(addMembership(winery, user, body.memberRole, body.professionalLicenseNumber))
    },
  },
  {
    method: 'get',
    path: '/v1/wineries/my/members',
    access: winery(),
    list: 'paged',
    handle: ({ auth, query }) => listResult((myWinery(auth).members ?? []).filter((m) => m.isActive), query),
  },
  {
    method: 'post',
    path: '/v1/wineries/my/members/create',
    access: winery(['OWNER']),
    async handle({ request, auth }) {
      const winery = myWinery(auth)
      const body = await parseBody(request, CreateMemberSchema)
      if (findUserByEmail(body.email)) throw conflict('El correo electrónico ya se encuentra registrado')
      const user = createUser({
        email: body.email,
        password: body.password,
        fullName: body.fullName,
        phoneNumber: body.phoneNumber,
        userRole: USER_ROLE_FOR_MEMBER[body.memberRole],
        wineryId: winery.id,
      })
      return created(addMembership(winery, user, body.memberRole, body.professionalLicenseNumber))
    },
  },
  {
    method: 'get',
    path: '/v1/wineries/pending',
    access: anyStaff,
    list: 'paged',
    handle: ({ query }) => listResult(getErpDb().wineries.filter((w) => w.certificationStatus === 'INVITED'), query),
  },
  {
    method: 'post',
    path: '/v1/wineries/:id/approve',
    access: platform(['ADMIN', 'OPERATIONS']),
    async handle({ request, params }) {
      const winery = findWinery(params.id!)
      await parseBody(request, ApproveWinerySchema)
      assertPending(winery, 'aprobada nuevamente')
      winery.certificationStatus = 'ACTIVE'
      winery.approvedAt = tick()
      winery.stellarPublicKey ??= fakeStellarAddress(`winery-wallet:${winery.id}`)
      winery.onchainProducerId ??= `PROD_${winery.countryCode}_${winery.taxIdNit}`
      winery.onchainRegisterTxHash ??= fakeHash64(`register:${winery.id}`)
      return ok(winery)
    },
  },
  {
    method: 'post',
    path: '/v1/wineries/:id/reject',
    access: platform(['ADMIN', 'OPERATIONS']),
    async handle({ request, params }) {
      const winery = findWinery(params.id!)
      await parseBody(request, RejectWinerySchema)
      assertPending(winery, 'rechazada')
      // El enum no tiene REJECTED: los mocks usan REVOKED (pendiente de confirmar, CONTRATO.md).
      winery.certificationStatus = 'REVOKED'
      return ok(winery)
    },
  },
]
