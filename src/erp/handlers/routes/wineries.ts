import {
  BEVERAGE_CATEGORIES,
  CERTIFICATION_STATUSES,
  UpdateWinerySchema,
  type MemberRole,
  type MockUser,
  type WineryMemberItem,
  type WineryResponse,
} from '../../schemas'
import { anyStaff, winery, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick } from '../db'
import { notFound } from '../errors'
import { applyPatch, enumParam, listResult, ok, parseBody, strParam, type RouteSpec } from '../http'

// /v1/wineries*: directorio de la plataforma y perfil de la bodega activa (0.1). La autoinscripción,
// `pending`/`approve`/`reject` y `my/members*` se retiraron al cerrar la Ola 1 (H1, contrato de la
// Ola 1 §11): los sustituyen `/v1/public/winery-applications`, `/v1/platform/*` y
// `/v1/organizations/current/*`.

/** Bodega de la petición: la activa o, para la plataforma, la de `?wineryId=`. */
function myWinery(auth: AuthContext): WineryResponse {
  const w = auth.tenantId ? getErpDb().wineries.find((x) => x.id === auth.tenantId) : undefined
  if (!w) throw notFound('Bodega no encontrada')
  return w
}

/** Añade una membresía de bodega (miembro de la bodega + enlace en el perfil de la persona): aceptar una invitación. */
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

export const wineryRoutes: RouteSpec[] = [
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
]
