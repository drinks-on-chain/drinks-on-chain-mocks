import { fakeHash64, fakeStellarAddress } from '../../../shared/uuid'
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
  type UserRole,
  type WineryMemberItem,
  type WineryResponse,
} from '../../schemas'
import { anyUser, members, roles, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick } from '../db'
import { conflict, notFound } from '../errors'
import { applyPatch, created, enumParam, listResult, ok, parseBody, strParam, type RouteSpec } from '../http'
import { createUser, findUserByEmail } from './auth-users'

// /v1/wineries*

function myWinery(auth: AuthContext): WineryResponse {
  const w = auth.wineryId ? getErpDb().wineries.find((x) => x.id === auth.wineryId) : undefined
  if (!w) throw notFound('Bodega no encontrada')
  return w
}

function findWinery(id: string): WineryResponse {
  const w = getErpDb().wineries.find((x) => x.id === id)
  if (!w) throw notFound(`Bodega con identificador "${id}" no encontrada`)
  return w
}

/** `userRole` que recibe un miembro creado desde la bodega (los operarios son ENOLOGIST, como en los fixtures). */
const USER_ROLE_FOR_MEMBER: Record<MemberRole, UserRole> = {
  OWNER: 'WINERY_ADMIN',
  ENOLOGIST: 'ENOLOGIST',
  AGRONOMIST: 'AGRONOMIST',
  OPERATOR: 'ENOLOGIST',
  ACCOUNTANT: 'ENOLOGIST',
}

function addMembership(
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
        certificationStatus: 'PENDING',
        approvedAt: null,
        createdAt: tick(),
        members: [],
      }
      db.wineries.push(winery)
      // El solicitante queda como OWNER / WINERY_ADMIN (catálogo del backend).
      addMembership(winery, auth.user, 'OWNER', null)
      if (auth.user.userRole === 'CONSUMER') auth.user.userRole = 'WINERY_ADMIN'
      return created(winery)
    },
  },
  {
    method: 'get',
    path: '/v1/wineries',
    access: roles(['PLATFORM_ADMIN']),
    list: 'paged',
    handle({ query }) {
      const status = enumParam(query, 'status', CERTIFICATION_STATUSES)
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
    access: members,
    handle: ({ auth }) => ok(myWinery(auth)),
  },
  {
    method: 'patch',
    path: '/v1/wineries/my',
    access: roles(['WINERY_ADMIN', 'PLATFORM_ADMIN']),
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
    access: roles(['WINERY_ADMIN', 'PLATFORM_ADMIN']),
    async handle({ request, auth }) {
      const winery = myWinery(auth)
      const body = await parseBody(request, AddMemberSchema)
      const user = getErpDb().users.find((u) => u.id === body.userId)
      if (!user) throw notFound('El usuario no existe')
      if (winery.members?.some((m) => m.userId === user.id)) throw conflict('El usuario ya es miembro de la bodega')
      return created(addMembership(winery, user, body.memberRole, body.professionalLicenseNumber))
    },
  },
  {
    method: 'get',
    path: '/v1/wineries/my/members',
    access: members,
    list: 'array',
    handle: ({ auth }) => ok((myWinery(auth).members ?? []).filter((m) => m.isActive)),
  },
  {
    method: 'post',
    path: '/v1/wineries/my/members/create',
    access: roles(['WINERY_ADMIN', 'PLATFORM_ADMIN']),
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
    access: roles(['PLATFORM_ADMIN']),
    list: 'array',
    handle: () => ok(getErpDb().wineries.filter((w) => w.certificationStatus === 'PENDING')),
  },
  {
    method: 'post',
    path: '/v1/wineries/:id/approve',
    access: roles(['PLATFORM_ADMIN']),
    async handle({ request, params }) {
      const winery = findWinery(params.id!)
      await parseBody(request, ApproveWinerySchema)
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
    access: roles(['PLATFORM_ADMIN']),
    async handle({ request, params }) {
      const winery = findWinery(params.id!)
      await parseBody(request, RejectWinerySchema)
      // El enum no tiene REJECTED: los mocks usan REVOKED (pendiente de confirmar, CONTRATO.md).
      winery.certificationStatus = 'REVOKED'
      return ok(winery)
    },
  },
]
