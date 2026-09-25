import { fakeStellarAddress } from '../../../shared/uuid'
import { buildAuthResponse } from '../../derive'
import {
  LoginSchema,
  RefreshTokenSchema,
  SignupSchema,
  UpdateUserSchema,
  type AuthTokens,
  type MockUser,
  type UserProfileResponse,
  type WalletResponse,
} from '../../schemas'
import { anyUser, findUserByKey, REFRESH_TOKEN_PREFIX } from '../auth-context'
import { getErpDb, newId, nextSeq, tick } from '../db'
import { conflict, notFound, unauthorized } from '../errors'
import { applyPatch, created, ok, parseBody, type RouteSpec } from '../http'

// /v1/auth/* y /v1/users/me*

/** Perfil sin los metadatos `_mock`. */
export function toProfile(user: MockUser): UserProfileResponse {
  const profile: Partial<MockUser> = { ...user }
  delete profile._mock
  return profile as UserProfileResponse
}

export function findUserByEmail(email: string): MockUser | undefined {
  const needle = email.trim().toLowerCase()
  return getErpDb().users.find((u) => u.email.toLowerCase() === needle)
}

/** Crea usuario + billetera custodial (signup y alta de miembros). */
export function createUser(input: {
  email: string
  password: string
  fullName: string
  userRole: MockUser['userRole']
  phoneNumber?: string | null
  preferredLocale?: string | null
  wineryId?: string | null
}): MockUser {
  const db = getErpDb()
  const at = tick()
  const key = `user_${nextSeq('user-key')}`
  const id = newId('user')
  const wallet: WalletResponse = {
    id: newId('wallet'),
    userId: id,
    wineryId: input.wineryId ?? null,
    stellarPublicAddress: fakeStellarAddress(`user-wallet:${id}`),
    walletType: 'CUSTODIAL',
    walletPurpose: input.wineryId ? 'PRODUCER_SIGNING' : 'CONSUMER_NFT',
    isPrimary: true,
    createdAt: at,
  }
  const user: MockUser = {
    id,
    email: input.email.trim().toLowerCase(),
    fullName: input.fullName,
    userRole: input.userRole,
    phoneNumber: input.phoneNumber ?? null,
    preferredLocale: input.preferredLocale ?? 'es',
    isActive: true,
    lastLoginAt: null,
    createdAt: at,
    wineryMemberships: [],
    primaryWallet: wallet,
    _mock: { key, password: input.password },
  }
  db.wallets.push(wallet)
  db.users.push(user)
  return user
}

export const authUserRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/auth/signup',
    access: 'public',
    async handle({ request }) {
      const body = await parseBody(request, SignupSchema)
      if (findUserByEmail(body.email)) throw conflict('El correo electrónico ya existe')
      const user = createUser({ ...body, userRole: body.userRole ?? 'CONSUMER' })
      return created(buildAuthResponse(user))
    },
  },
  {
    method: 'post',
    path: '/v1/auth/login',
    access: 'public',
    async handle({ request }) {
      const body = await parseBody(request, LoginSchema)
      const user = findUserByEmail(body.email)
      if (!user || !user.isActive || user._mock.password !== body.password) {
        throw unauthorized('Credenciales inválidas')
      }
      return ok(buildAuthResponse(user))
    },
  },
  {
    method: 'post',
    path: '/v1/auth/refresh',
    access: 'public',
    async handle({ request }) {
      const body = await parseBody(request, RefreshTokenSchema)
      const token = body.refreshToken
      const user = token.startsWith(REFRESH_TOKEN_PREFIX) ? findUserByKey(token.slice(REFRESH_TOKEN_PREFIX.length)) : undefined
      if (!user) throw unauthorized('Token de actualización inválido o expirado')
      const tokens: AuthTokens = buildAuthResponse(user).tokens
      return ok(tokens)
    },
  },
  {
    method: 'get',
    path: '/v1/users/me',
    access: anyUser,
    handle: ({ auth }) => ok(toProfile(auth.user)),
  },
  {
    method: 'patch',
    path: '/v1/users/me',
    access: anyUser,
    async handle({ request, auth }) {
      const body = await parseBody(request, UpdateUserSchema)
      applyPatch(auth.user, body)
      return ok(toProfile(auth.user))
    },
  },
  {
    method: 'get',
    path: '/v1/users/me/wallet',
    access: anyUser,
    handle({ auth }) {
      const wallet = getErpDb().wallets.find((w) => w.userId === auth.user.id && w.isPrimary)
      if (!wallet) throw notFound('Billetera no encontrada')
      return ok(wallet)
    },
  },
]
