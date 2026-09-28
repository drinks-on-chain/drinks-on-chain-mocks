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
import { expireAccessTokens, expireRefreshGrace } from '../src/handlers'
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
  if (!('mfa' in first)) return { session: SessionResponseSchema.parse(first), headers: res.headers, refresh: cookieValue(res.headers) }
  // Personal de plataforma: segundo factor con el TOTP de demo (contrato de la Ola 1 §1).
  const verified = await raw<SessionResponse>('/v1/auth/mfa/verify', { body: { mfaToken: first.mfa.mfaToken, code: generateTotp(DEMO_TOTP_SECRET) } })
  expect(verified.status).toBe(200)
  return { session: SessionResponseSchema.parse(data(verified.json)), headers: verified.headers, refresh: cookieValue(verified.headers) }
}

function claimsOf(accessToken: string) {
  const payload = accessToken.split('.')[1]!
  return AccessTokenClaimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
}

describe('login y membresías', () => {
  it('la respuesta trae membresías, organización activa, audiencia y un acceso de 15 min', async () => {
    const { session, headers, refresh } = await login('enologa@altos.test')
    expect(session.user).toMatchObject({ audience: 'STAFF' })
    // Retirados en H1: el rol y la bodega van en las membresías; el refresco, solo en la cookie.
    for (const legacy of ['userRole', 'wineryId', 'memberRole']) expect(session.user).not.toHaveProperty(legacy)
    expect(session.tokens).not.toHaveProperty('refreshToken')
    expect(session.memberships).toEqual([
      expect.objectContaining({ organizationId: ALTOS.id, organizationType: 'WINERY', role: 'ENOLOGIST', status: 'ACTIVE' }),
    ])
    expect(session.activeOrganizationId).toBe(ALTOS.id)
    expect(session.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 })
    const claims = claimsOf(session.tokens.accessToken)
    expect(claims).toMatchObject({ aud: 'STAFF', org: ALTOS.id, orgType: 'WINERY', role: 'ENOLOGIST' })
    for (const legacy of ['email', 'userRole', 'wineryId', 'memberRole']) expect(claims).not.toHaveProperty(legacy)
    expect(claims.exp - claims.iat).toBe(900)
    // Cookie de renovación: HttpOnly, SameSite=Lax, Path=/, 7 días para personal, Secure en HTTPS.
    const setCookie = headers.get('set-cookie')!
    expect(refresh).toMatch(/^[0-9a-f-]{36}\.0\.[A-Za-z0-9_-]{43}$/)
    expect(setCookie).toContain(`doc_rt=${refresh}`)
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800/)
  })

  it('plataforma antes que bodega; el consumidor no tiene membresías (30 días de renovación, sin Secure en http)', async () => {
    const admin = await login('gestor@drinksonchain.test')
    expect(admin.session.activeOrganizationId).toBe(PLATFORM_ORGANIZATION.id)
    expect(admin.session.memberships[0]).toMatchObject({ organizationType: 'PLATFORM', role: 'SUPERADMIN' })

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
    const { session, refresh: first } = await login('admin@cintiviejo.test')

    const renewed = await raw<SessionResponse>('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${first}` })
    expect(renewed.status).toBe(200)
    const second = SessionResponseSchema.parse(data(renewed.json))
    const secondRefresh = cookieValue(renewed.headers)
    expect(secondRefresh).not.toBe(first)
    expect(claimsOf(second.tokens.accessToken).sid).toBe(claimsOf(session.tokens.accessToken).sid)

    // Dentro de la gracia (20 s) el anterior devuelve el mismo par (dos pestañas a la vez).
    const graced = await raw<SessionResponse>('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${first}` })
    expect(graced.status).toBe(200)
    expect(SessionResponseSchema.parse(data(graced.json)).tokens).toEqual(second.tokens)
    expect(cookieValue(graced.headers)).toBe(secondRefresh)

    // Fuera de la gracia, reutilizar el refresco ya rotado revoca toda la familia.
    expireRefreshGrace()
    const reused = await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${first}` })
    expect(reused.status).toBe(401)
    expect(errorCode(reused.json)).toBe('AUTH_REFRESH_REUSED')
    const after = await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${secondRefresh}` })
    expect(errorCode(after.json)).toBe('AUTH_SESSION_REVOKED')
    const me = await raw('/v1/users/me', { token: second.tokens.accessToken })
    expect(me.status).toBe(401)
    expect(errorCode(me.json)).toBe('AUTH_SESSION_REVOKED')
  })

  it('el refresco en el cuerpo ya no se lee (retirado en H1): manda la cookie', async () => {
    const { refresh } = await login('agronomo@altos.test')
    const other = await login('enologa@cintiviejo.test')
    // Cookie de otra sesión y el refresco de la primera en el cuerpo: renueva la de la cookie.
    const res = await raw<SessionResponse>('/v1/auth/refresh', { body: { refreshToken: refresh }, cookie: `doc_rt=${other.refresh}` })
    expect(res.status).toBe(200)
    expect(SessionResponseSchema.parse(data(res.json)).user.email).toBe('enologa@cintiviejo.test')
  })

  it('usa la cookie que guarda MSW aunque la app no la envíe explícitamente', async () => {
    await login('agronomo@cintiviejo.test')
    const res = await raw<SessionResponse>('/v1/auth/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(SessionResponseSchema.parse(data(res.json)).user.email).toBe('agronomo@cintiviejo.test')
  })

  it('expireAccessTokens() simula el paso de 15 min: el acceso caduca y la renovación lo repone', async () => {
    const { session, refresh } = await login('enologa@cintiviejo.test')
    expireAccessTokens()
    const expired = await raw('/v1/terroirs', { token: session.tokens.accessToken })
    expect(expired.status).toBe(401)
    expect(errorCode(expired.json)).toBe('AUTH_TOKEN_EXPIRED')
    const renewed = SessionResponseSchema.parse(
      data((await raw<SessionResponse>('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${refresh}` })).json),
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

  it('sin membresía → 404 ORG_NOT_FOUND; membresía bloqueada → 403 ORG_MEMBERSHIP_BLOCKED; revocada → 403 ORG_REVOKED', async () => {
    const { session } = await login('ines@salazar.test')
    const none = await raw('/v1/auth/switch-organization', { token: session.tokens.accessToken, body: { organizationId: URIONDO.id } })
    expect(none.status).toBe(404)
    expect(errorCode(none.json)).toBe('ORG_NOT_FOUND')
    const blocked = await raw('/v1/auth/switch-organization', { token: session.tokens.accessToken, body: { organizationId: ALTOS.id } })
    expect(blocked.status).toBe(403)
    expect(errorCode(blocked.json)).toBe('ORG_MEMBERSHIP_BLOCKED')
    // Hugo es dueño de Bodega Valle Escondido (REVOKED): su única membresía no es utilizable.
    const hugo = await login('hugo@valleescondido.test')
    const valle = erpFixtures.wineries.find((w) => w.certificationStatus === 'REVOKED')!
    const revoked = await raw('/v1/auth/switch-organization', { token: hugo.session.tokens.accessToken, body: { organizationId: valle.id } })
    expect(revoked.status).toBe(403)
    expect(errorCode(revoked.json)).toBe('ORG_REVOKED')
  })

  it('exige el refresco de la misma sesión en la cookie y lo rota (contrato de la Ola 0 §8)', async () => {
    const { session: a, refresh: aRefresh } = await login('sofia@aramayo.test')
    const { session: b, refresh: bRefresh } = await login('admin@altos.test')
    // Sin cookie propia: el último refresco guardado es el de otra sesión → 401 AUTH_REFRESH_INVALID.
    const noRefresh = await raw('/v1/auth/switch-organization', { token: a.tokens.accessToken, cookie: '', body: { organizationId: URIONDO.id } })
    expect(noRefresh.status).toBe(401)
    expect(errorCode(noRefresh.json)).toBe('AUTH_REFRESH_INVALID')
    // El refresco de otra sesión en la cookie tampoco vale (y no revoca nada).
    const foreign = await raw('/v1/auth/switch-organization', {
      token: a.tokens.accessToken,
      cookie: `doc_rt=${bRefresh}`,
      body: { organizationId: URIONDO.id },
    })
    expect(errorCode(foreign.json)).toBe('AUTH_REFRESH_INVALID')
    expect((await raw('/v1/users/me', { token: b.tokens.accessToken })).status).toBe(200)
    // El refresco en el cuerpo ya no se acepta (retirado en H1): 422 como el backend.
    const inBody = await raw('/v1/auth/switch-organization', {
      token: a.tokens.accessToken,
      cookie: `doc_rt=${aRefresh}`,
      body: { organizationId: URIONDO.id, refreshToken: aRefresh },
    })
    expect(inBody.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(inBody.json).error.details).toEqual([expect.objectContaining({ field: 'refreshToken' })])
    // Con la cookie de la sesión: cambia y lo rota.
    const ok = await raw<SessionResponse>('/v1/auth/switch-organization', {
      token: a.tokens.accessToken,
      cookie: `doc_rt=${aRefresh}`,
      body: { organizationId: URIONDO.id },
    })
    expect(ok.status).toBe(200)
    const switched = SessionResponseSchema.parse(data(ok.json))
    const switchedRefresh = cookieValue(ok.headers)
    expect(switchedRefresh).not.toBe(aRefresh)
    const back = await raw('/v1/auth/switch-organization', {
      token: switched.tokens.accessToken,
      cookie: `doc_rt=${switchedRefresh}`,
      body: { organizationId: ALTOS.id },
    })
    expect(back.status).toBe(200)
    // El refresco inicial, ya dos veces rotado → reutilización: revoca la sesión.
    const reused = await raw('/v1/auth/refresh', { cookie: `doc_rt=${aRefresh}`, method: 'POST' })
    expect(errorCode(reused.json)).toBe('AUTH_REFRESH_REUSED')
  })

  it('las rutas de 0.1 retiradas en H1 ya no existen (my/members, autoinscripción, pending/approve/reject)', async () => {
    const owner = (await login('admin@altos.test')).session.tokens.accessToken
    const retired: [string, string][] = [
      ['POST', '/v1/wineries'],
      ['GET', '/v1/wineries/pending'],
      ['POST', `/v1/wineries/${ALTOS.id}/approve`],
      ['POST', `/v1/wineries/${ALTOS.id}/reject`],
      ['GET', '/v1/wineries/my/members'],
      ['POST', '/v1/wineries/my/members'],
      ['POST', '/v1/wineries/my/members/create'],
    ]
    for (const [method, path] of retired) {
      const res = await raw(path, { method, token: owner, body: method === 'POST' ? {} : undefined })
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 })
    }
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
    const { session, refresh } = await login('enologa@altos.test')
    const out = await raw('/v1/auth/logout', { method: 'POST', token: session.tokens.accessToken })
    expect(out.status).toBe(204)
    expect(out.json).toBeNull()
    expect(out.headers.get('set-cookie')).toMatch(/^doc_rt=; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=0$/)
    expect(errorCode((await raw('/v1/users/me', { token: session.tokens.accessToken })).json)).toBe('AUTH_SESSION_REVOKED')
    const renewed = await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${refresh}` })
    expect(errorCode(renewed.json)).toBe('AUTH_SESSION_REVOKED')
  })

  it('logout con el acceso caducado identifica la sesión por la cookie', async () => {
    const { refresh } = await login('enologa@altos.test')
    expireAccessTokens()
    const out = await raw('/v1/auth/logout', { method: 'POST', cookie: `doc_rt=${refresh}` })
    expect(out.status).toBe(204)
    expect(errorCode((await raw('/v1/auth/refresh', { method: 'POST', cookie: `doc_rt=${refresh}` })).json)).toBe(
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
