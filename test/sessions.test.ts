import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AccessTokenClaimsSchema,
  ErrorEnvelopeSchema,
  MeResponseSchema,
  SessionResponseSchema,
  type Envelope,
  type LoginResponse,
  type SessionResponse,
} from '../src'
import { DEMO_TOTP_SECRET, generateTotp } from '../src/fixtures'
import { PLATFORM_ORGANIZATION } from '../src/erp/catalog'
import { erpFixtures } from '../src/fixtures'
import { expireAccessTokens } from '../src/handlers'
import { getErpDb, resetErpDb, setupMockServer } from '../src/node'
import { API } from './helpers'

// Sesión del contrato de la Ola 0 §4–§5: membresías, organización activa, cookie de renovación
// rotativa con detección de reutilización, cierre de sesión y rutas `/api/v1/*` (P-1).

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
})
afterAll(() => server.close())

const W = (name: string) => erpFixtures.wineries.find((w) => w.commercialName === name)!
const ALTOS = W('Bodega Altos de Calamuchita')
const CINTI = W('Destilería Cinti Viejo')
const URIONDO = W('Casa Uriondo')

interface RawOptions {
  method?: string
  token?: string | null
  body?: unknown
  cookie?: string
  headers?: Record<string, string>
  origin?: string
}

async function raw<T = unknown>(path: string, opts: RawOptions = {}) {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.cookie !== undefined) headers.Cookie = opts.cookie
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(`${opts.origin ?? API}${path}`, { method: opts.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body })
  const text = await res.text()
  const json = (text ? JSON.parse(text) : null) as Envelope<T> | null
  return { status: res.status, headers: res.headers, json }
}

function data<T>(json: Envelope<T> | null): T {
  if (!json?.success) throw new Error(`Error: ${JSON.stringify(json)}`)
  return json.data
}

function errorCode(json: Envelope<unknown> | null): string {
  return ErrorEnvelopeSchema.parse(json).error.code
}

/** Valor de la cookie doc_rt de un Set-Cookie. */
function cookieValue(headers: Headers): string {
  const match = /doc_rt=([^;]*)/.exec(headers.get('set-cookie') ?? '')
  return match?.[1] ?? ''
}

async function login(email: string) {
  const res = await raw<LoginResponse>('/v1/auth/login', { body: { email, password: 'demo1234' } })
  expect(res.status).toBe(200)
  const first = data(res.json)
  if (!('mfa' in first)) return { session: SessionResponseSchema.parse(first), headers: res.headers }
  // Personal de plataforma: segundo factor con el TOTP de demo (contrato de la Ola 1 §1).
  const verified = await raw<SessionResponse>('/v1/auth/mfa/verify', { body: { mfaToken: first.mfa.mfaToken, code: generateTotp(DEMO_TOTP_SECRET) } })
  expect(verified.status).toBe(200)
  return { session: SessionResponseSchema.parse(data(verified.json)), headers: verified.headers }
}

function claimsOf(accessToken: string) {
  const payload = accessToken.split('.')[1]!
  return AccessTokenClaimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
}

describe('login y membresías', () => {
  it('la respuesta trae membresías, organización activa, audiencia y un acceso de 15 min', async () => {
    const { session, headers } = await login('enologa@altos.test')
    expect(session.user).toMatchObject({ audience: 'STAFF', userRole: 'ENOLOGIST', wineryId: ALTOS.id, memberRole: 'ENOLOGIST' })
    expect(session.memberships).toEqual([
      expect.objectContaining({ organizationId: ALTOS.id, organizationType: 'WINERY', role: 'ENOLOGIST', status: 'ACTIVE' }),
    ])
    expect(session.activeOrganizationId).toBe(ALTOS.id)
    expect(session.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 })
    const claims = claimsOf(session.tokens.accessToken)
    expect(claims).toMatchObject({ aud: 'STAFF', org: ALTOS.id, orgType: 'WINERY', role: 'ENOLOGIST', email: 'enologa@altos.test' })
    expect(claims.exp - claims.iat).toBe(900)
    // Cookie de renovación: HttpOnly, SameSite=Lax, Path=/, 7 días para personal, Secure en HTTPS.
    const setCookie = headers.get('set-cookie')!
    expect(setCookie).toContain(`doc_rt=${session.tokens.refreshToken}`)
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800/)
  })

  it('plataforma antes que bodega; el consumidor no tiene membresías (30 días de renovación, sin Secure en http)', async () => {
    const admin = await login('gestor@drinksonchain.test')
    expect(admin.session.activeOrganizationId).toBe(PLATFORM_ORGANIZATION.id)
    expect(admin.session.memberships[0]).toMatchObject({ organizationType: 'PLATFORM', role: 'SUPERADMIN' })
    expect(admin.session.user).toMatchObject({ wineryId: null, memberRole: null })

    const res = await raw<SessionResponse>('/api/v1/auth/login', { origin: 'http://localhost:3002', body: { email: 'maria@tribu.test', password: 'demo1234' } })
    const maria = SessionResponseSchema.parse(data(res.json))
    expect(maria).toMatchObject({ memberships: [], activeOrganizationId: null, user: { audience: 'CONSUMER' } })
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/)
  })

  it('una persona con varias membresías (Sofía: enóloga en Altos y dueña en Casa Uriondo)', async () => {
    const { session } = await login('sofia@aramayo.test')
    expect(session.memberships.map((m) => [m.organizationName, m.role, m.organizationStatus])).toEqual([
      ['Bodega Altos de Calamuchita', 'ENOLOGIST', 'ACTIVE'],
      ['Casa Uriondo', 'OWNER', 'SUSPENDED'],
    ])
    expect(session.activeOrganizationId).toBe(ALTOS.id)
  })

  it('GET /v1/users/me devuelve la persona, las membresías y la organización activa del token', async () => {
    const { session } = await login('ines@salazar.test')
    const me = MeResponseSchema.parse(data((await raw('/v1/users/me', { token: session.tokens.accessToken })).json))
    expect(me.activeOrganizationId).toBe(CINTI.id)
    expect(me.memberships.map((m) => m.status)).toEqual(['ACTIVE', 'BLOCKED'])
    expect(me.user.audience).toBe('STAFF')
  })
})

describe('renovación rotativa', () => {
  it('rota con la cookie (sin cuerpo) y detecta la reutilización', async () => {
    const { session } = await login('admin@cintiviejo.test')
    const first = session.tokens.refreshToken

    const renewed = await raw<SessionResponse>('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${first}` })
    expect(renewed.status).toBe(200)
    const second = SessionResponseSchema.parse(data(renewed.json))
    expect(second.tokens.refreshToken).not.toBe(first)
    expect(cookieValue(renewed.headers)).toBe(second.tokens.refreshToken)
    expect(claimsOf(second.tokens.accessToken).sid).toBe(claimsOf(session.tokens.accessToken).sid)

    // Reutilizar el refresco ya rotado revoca toda la familia.
    const reused = await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${first}` })
    expect(reused.status).toBe(401)
    expect(errorCode(reused.json)).toBe('AUTH_REFRESH_REUSED')
    const after = await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${second.tokens.refreshToken}` })
    expect(errorCode(after.json)).toBe('AUTH_SESSION_REVOKED')
    const me = await raw('/v1/users/me', { token: second.tokens.accessToken })
    expect(me.status).toBe(401)
    expect(errorCode(me.json)).toBe('AUTH_SESSION_REVOKED')
  })

  it('acepta el refresco en el cuerpo (compatibilidad con 0.1, retirada en H1)', async () => {
    const { session } = await login('agronomo@altos.test')
    const res = await raw('/v1/auth/refresh', { body: { refreshToken: session.tokens.refreshToken }, cookie: '' })
    expect(res.status).toBe(200)
  })

  it('usa la cookie que guarda MSW aunque la app no la envíe explícitamente', async () => {
    await login('agronomo@cintiviejo.test')
    const res = await raw<SessionResponse>('/v1/auth/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(SessionResponseSchema.parse(data(res.json)).user.email).toBe('agronomo@cintiviejo.test')
  })

  it('expireAccessTokens() simula el paso de 15 min: el acceso caduca y la renovación lo repone', async () => {
    const { session } = await login('enologa@cintiviejo.test')
    expireAccessTokens()
    const expired = await raw('/v1/terroirs', { token: session.tokens.accessToken })
    expect(expired.status).toBe(401)
    expect(errorCode(expired.json)).toBe('UNAUTHORIZED')
    const renewed = SessionResponseSchema.parse(
      data((await raw<SessionResponse>('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${session.tokens.refreshToken}` })).json),
    )
    expect((await raw('/v1/terroirs', { token: renewed.tokens.accessToken })).status).toBe(200)
  })

  it('el token estático mock.access.<clave> sigue funcionando', async () => {
    const res = await raw('/v1/wineries/my', { token: 'mock.access.cvj_admin' })
    expect(data(res.json)).toMatchObject({ id: CINTI.id })
  })
})

describe('cambio de organización', () => {
  it('cambia la organización activa, los roles efectivos y la recuerda en el siguiente login', async () => {
    const { session } = await login('sofia@aramayo.test')
    const asEnologist = session.tokens.accessToken
    expect((await raw('/v1/wineries/my', { token: asEnologist, method: 'PATCH', body: { address: 'x' } })).status).toBe(403)

    const res = await raw<SessionResponse>('/v1/auth/switch-organization', { token: asEnologist, body: { organizationId: URIONDO.id } })
    expect(res.status).toBe(200)
    const switched = SessionResponseSchema.parse(data(res.json))
    expect(switched.activeOrganizationId).toBe(URIONDO.id)
    expect(switched.user).toMatchObject({ wineryId: URIONDO.id, memberRole: 'OWNER' })
    expect(claimsOf(switched.tokens.accessToken)).toMatchObject({ org: URIONDO.id, role: 'OWNER', sid: claimsOf(asEnologist).sid })

    const asOwner = switched.tokens.accessToken
    // Casa Uriondo está suspendida (Ola 1 §4): se lee el perfil, pero no se escribe en el ERP.
    expect(data((await raw('/v1/wineries/my', { token: asOwner })).json)).toMatchObject({ id: URIONDO.id })
    const patch = await raw('/v1/wineries/my', { token: asOwner, method: 'PATCH', body: { address: 'Plaza 1' } })
    expect(patch.status).toBe(403)
    expect(ErrorEnvelopeSchema.parse(patch.json).error).toMatchObject({ code: 'ORG_NOT_ACTIVE', details: [{ field: null, message: 'SUSPENDED' }] })

    const again = await login('sofia@aramayo.test')
    expect(again.session.activeOrganizationId).toBe(URIONDO.id)
  })

  it('sin membresía → 404 ORG_NOT_FOUND; membresía bloqueada → 403', async () => {
    const { session } = await login('ines@salazar.test')
    const none = await raw('/v1/auth/switch-organization', { token: session.tokens.accessToken, body: { organizationId: URIONDO.id } })
    expect(none.status).toBe(404)
    expect(errorCode(none.json)).toBe('ORG_NOT_FOUND')
    const blocked = await raw('/v1/auth/switch-organization', { token: session.tokens.accessToken, body: { organizationId: ALTOS.id } })
    expect(blocked.status).toBe(403)
  })

  it('POST /wineries/my/members reactiva una membresía bloqueada sin tocar el rol global (SE-01)', async () => {
    const owner = (await login('admin@altos.test')).session.tokens.accessToken
    const ines = erpFixtures.users.find((u) => u._mock.key === 'ines')!
    const res = await raw('/v1/wineries/my/members', { token: owner, body: { userId: ines.id, memberRole: 'OPERATOR' } })
    expect(res.status).toBe(201)
    expect(getErpDb().users.find((u) => u.id === ines.id)!.userRole).toBe('AGRONOMIST')
    const { session } = await login('ines@salazar.test')
    const switched = await raw('/v1/auth/switch-organization', { token: session.tokens.accessToken, body: { organizationId: ALTOS.id } })
    expect(switched.status).toBe(200)
  })

  it('bloquear la membresía activa revoca la sesión en la siguiente petición (IAM-13)', async () => {
    const { session } = await login('operario@cintiviejo.test')
    const member = getErpDb().wineries.find((w) => w.id === CINTI.id)!.members!.find((m) => m.email === 'operario@cintiviejo.test')!
    const user = getErpDb().users.find((u) => u.email === 'operario@cintiviejo.test')!
    member.isActive = false
    user.wineryMemberships[0]!.isActive = false
    const res = await raw('/v1/fermentation-tanks', { token: session.tokens.accessToken })
    expect(res.status).toBe(401)
    expect(errorCode(res.json)).toBe('AUTH_SESSION_REVOKED')
  })
})

describe('cierre de sesión', () => {
  it('logout revoca la sesión actual y borra la cookie', async () => {
    const { session } = await login('enologa@altos.test')
    const out = await raw('/v1/auth/logout', { method: 'POST', token: session.tokens.accessToken })
    expect(out.status).toBe(204)
    expect(out.json).toBeNull()
    expect(out.headers.get('set-cookie')).toMatch(/^doc_rt=; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0$/)
    expect(errorCode((await raw('/v1/users/me', { token: session.tokens.accessToken })).json)).toBe('AUTH_SESSION_REVOKED')
    const refresh = await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${session.tokens.refreshToken}` })
    expect(errorCode(refresh.json)).toBe('AUTH_SESSION_REVOKED')
  })

  it('logout con el acceso caducado identifica la sesión por la cookie', async () => {
    const { session } = await login('enologa@altos.test')
    expireAccessTokens()
    const out = await raw('/v1/auth/logout', { method: 'POST', cookie: `doc_rt=${session.tokens.refreshToken}` })
    expect(out.status).toBe(204)
    expect(errorCode((await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${session.tokens.refreshToken}` })).json)).toBe(
      'AUTH_SESSION_REVOKED',
    )
  })

  it('logout-all revoca todas las sesiones de la persona', async () => {
    const a = (await login('admin@altos.test')).session
    const b = (await login('admin@altos.test')).session
    expect((await raw('/v1/auth/logout-all', { method: 'POST', token: b.tokens.accessToken })).status).toBe(204)
    for (const s of [a, b]) expect(errorCode((await raw('/v1/users/me', { token: s.tokens.accessToken })).json)).toBe('AUTH_SESSION_REVOKED')
  })
})

describe('rutas independientes de la base (P-1) y cabeceras', () => {
  it('responde en /api/v1/* de cualquier origen con el path /v1/* en el envoltorio', async () => {
    const token = (await login('agronomo@altos.test')).session.tokens.accessToken
    const res = await raw('/api/v1/terroirs?limit=2', { origin: 'http://localhost:3002', token })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ success: true, path: '/v1/terroirs?limit=2', data: { total: 5, limit: 2 } })
    const missing = await raw('/api/v1/nope', { origin: 'https://erp-preview.vercel.app' })
    expect(missing.status).toBe(404)
    expect(missing.json).toMatchObject({ path: '/v1/nope', error: { code: 'NOT_FOUND' } })
  })

  it('devuelve X-Correlation-ID (el de la petición o uno nuevo)', async () => {
    const echoed = await raw('/v1/health', { headers: { 'X-Correlation-ID': 'abc-123' } })
    expect(echoed.headers.get('x-correlation-id')).toBe('abc-123')
    expect((await raw('/v1/health')).headers.get('x-correlation-id')).toMatch(/^mock-\d+$/)
    expect((await raw('/v1/users/me')).headers.get('x-correlation-id')).toMatch(/^mock-\d+$/)
  })
})
