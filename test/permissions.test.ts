import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ErrorEnvelopeSchema, MeResponseSchema, type Envelope, type Paged, type TerroirResponse } from '../src'
import { DEMO_NEW_PASSWORD, erpFixtures } from '../src/fixtures'
import { advanceMockClock, LOGIN_LOCK_POLICY, mockMailbox } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { API, call, dataOf, login, loginSession } from './helpers'

// Permisos del ERP y sesión como el backend O0-BE-4 (contrato de la Ola 0 §8; guards
// `@OrgType('WINERY') @Roles(...)`, `TenantGuard` y códigos de error de `error-codes.ts`).

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
})
afterAll(() => server.close())

const F = erpFixtures
const W = (name: string) => F.wineries.find((w) => w.commercialName === name)!
const ALTOS = W('Bodega Altos de Calamuchita')
const CINTI = W('Destilería Cinti Viejo')
const altosTerroir = F.terroirs.find((t) => t.wineryId === ALTOS.id)!
const altosHarvest = F.harvestBatches.find((h) => h.wineryId === ALTOS.id)!
const altosTank = F.fermentationTanks.find((t) => t.wineryId === ALTOS.id)!
const REASON = 'Prueba de permisos'

const code = (json: Envelope<unknown>) => ErrorEnvelopeSchema.parse(json).error.code
const harvestBody = {
  terroirId: altosTerroir.id,
  intakeDate: '2026-09-25',
  harvestYear: 2026,
  grossWeightKg: 1200,
  tareWeightKg: 200,
  brixDegrees: 23,
  initialPh: 3.4,
  initialAcidityGl: 6,
}
const logBody = { temperatureCelsius: 22, recordedAt: '2026-09-25T08:00:00Z' }
const tankBody = { harvestBatchId: altosHarvest.id, tankCode: 'TK-PERM', startDate: '2026-09-25' }

/** Contadora activa en Altos (en los fixtures la única contadora está bloqueada): invitada y aceptada. */
async function altosAccountant(): Promise<string> {
  const owner = await login('admin@altos.test')
  const res = await call('/v1/organizations/current/invitations', { token: owner, body: { email: 'contable@altos.test', role: 'ACCOUNTANT' } })
  expect(res.status).toBe(201)
  const invite = mockMailbox.latest({ to: 'contable@altos.test', template: 'INVITATION' })!
  const accepted = await call(`/v1/invitations/${invite.token}/accept`, { body: { fullName: 'Contable Altos', password: DEMO_NEW_PASSWORD } })
  expect(accepted.status).toBe(200)
  return login('contable@altos.test', DEMO_NEW_PASSWORD)
}

/** `sid` del acceso (el refresco es `<sid>.<generación>.<secreto>`). */
function claimsSid(accessToken: string): string {
  return (JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid
}

describe('matriz de roles de bodega (docs-back/05 §3)', () => {
  it('OPERATOR pesa y registra lecturas; no dictamina, no crea cubas ni lee crianza', async () => {
    const op = await login('operario@altos.test')
    expect((await call('/v1/harvest-batches', { token: op, body: harvestBody })).status).toBe(201)
    expect((await call(`/v1/fermentation-tanks/${altosTank.id}/logs`, { token: op, body: logBody })).status).toBe(201)
    expect((await call('/v1/harvest-batches', { token: op })).status).toBe(200)
    expect((await call(`/v1/fermentation-tanks/${altosTank.id}`, { token: op })).status).toBe(200)
    const phyto = await call(`/v1/harvest-batches/${altosHarvest.id}/phyto-status`, { token: op, method: 'PATCH', body: { phytosanitaryStatus: 'APPROVED' } })
    expect(phyto.status).toBe(403)
    expect(code(phyto.json)).toBe('AUTH_INSUFFICIENT_PERMISSIONS')
    expect((await call('/v1/fermentation-tanks', { token: op, body: tankBody })).status).toBe(403)
    // §11 bis: lectura mínima de parcelas (elige la parcela del pesaje), sin alta ni edición.
    expect((await call('/v1/terroirs', { token: op })).status).toBe(200)
    expect((await call(`/v1/terroirs/${altosHarvest.terroirId}`, { token: op })).status).toBe(200)
    expect((await call('/v1/terroirs', { token: op, body: { parcelName: 'X' } })).status).toBe(403)
    expect((await call('/v1/wine-aging', { token: op })).status).toBe(403)
    expect((await call('/v1/bottling', { token: op })).status).toBe(403)
  })

  it('ACCOUNTANT solo lee (parcelas, vendimia, cubas, crianza, embotellado, laboratorio)', async () => {
    const acc = await altosAccountant()
    for (const path of ['/v1/terroirs', '/v1/harvest-batches', '/v1/fermentation-tanks', '/v1/wine-aging', '/v1/production-batches', '/v1/bottling']) {
      expect((await call(path, { token: acc })).status, path).toBe(200)
    }
    expect((await call('/v1/harvest-batches', { token: acc, body: harvestBody })).status).toBe(403)
    expect((await call(`/v1/fermentation-tanks/${altosTank.id}/logs`, { token: acc, body: logBody })).status).toBe(403)
    expect((await call('/v1/terroirs', { token: acc, body: { parcelName: 'X' } })).status).toBe(403)
    expect((await call('/v1/wineries/my', { token: acc, method: 'PATCH', body: { address: 'x' } })).status).toBe(403)
  })

  it('OWNER dictamina; AGRONOMIST registra lecturas pero no lee crianza ni embotellado', async () => {
    const owner = await login('admin@altos.test')
    const phyto = await call(`/v1/harvest-batches/${altosHarvest.id}/phyto-status`, { token: owner, method: 'PATCH', body: { phytosanitaryStatus: 'APPROVED' } })
    expect(phyto.status).toBe(200)
    const agro = await login('agronomo@altos.test')
    expect((await call(`/v1/fermentation-tanks/${altosTank.id}/logs`, { token: agro, body: logBody })).status).toBe(201)
    expect((await call('/v1/wine-aging', { token: agro })).status).toBe(403)
    expect((await call('/v1/bottling', { token: agro })).status).toBe(403)
  })

  it('los roles globales ya no autorizan: el cajero (POS_OPERATOR) no registra lecturas; el consumidor no lee laboratorio', async () => {
    const cashier = await login('cajero.lacava@drinksonchain.test')
    expect((await call(`/v1/fermentation-tanks/${altosTank.id}/logs`, { token: cashier, body: logBody })).status).toBe(403)
    const bottling = F.bottling.find((b) => F.labAnalyses.some((l) => l.bottlingBatchId === b.id))!
    expect((await call(`/v1/lab-analyses/batch/${bottling.id}`, { token: await login('maria@tribu.test') })).status).toBe(403)
  })

  it('una bodega que apunta a otra con wineryId → 404', async () => {
    const enologa = await login('enologa@altos.test')
    expect((await call(`/v1/terroirs?wineryId=${ALTOS.id}`, { token: enologa })).status).toBe(200)
    const other = await call(`/v1/terroirs?wineryId=${CINTI.id}`, { token: enologa })
    expect(other.status).toBe(404)
    expect(code(other.json)).toBe('NOT_FOUND')
  })
})

describe('plataforma sobre una bodega (?wineryId=, OP-07)', () => {
  it('lee todas las bodegas sin wineryId y una con él; escribe solo con wineryId', async () => {
    const admin = (await loginSession('gestor@drinksonchain.test')).tokens.accessToken
    const all = dataOf((await call<Paged<TerroirResponse>>('/v1/terroirs?limit=100', { token: admin })).json)
    expect(new Set(all.items.map((t) => t.wineryId)).size).toBeGreaterThan(1)
    const altos = dataOf((await call<Paged<TerroirResponse>>(`/v1/terroirs?limit=100&wineryId=${ALTOS.id}`, { token: admin })).json)
    expect(altos.items.every((t) => t.wineryId === ALTOS.id)).toBe(true)
    // Detalle de otra bodega con wineryId de Altos → 404.
    const cintiTerroir = F.terroirs.find((t) => t.wineryId === CINTI.id)!
    expect((await call(`/v1/terroirs/${cintiTerroir.id}?wineryId=${ALTOS.id}`, { token: admin })).status).toBe(404)

    const missing = await call('/v1/harvest-batches', { token: admin, body: harvestBody })
    expect(missing.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(missing.json).error.details).toEqual([{ field: 'wineryId', message: expect.any(String) }])
    const badUuid = await call('/v1/harvest-batches?wineryId=altos', { token: admin, body: harvestBody })
    expect(ErrorEnvelopeSchema.parse(badUuid.json).error.details![0]!.field).toBe('wineryId')
    const unknown = await call('/v1/harvest-batches?wineryId=00000000-0000-4000-8000-00000000abcd', { token: admin, body: harvestBody })
    expect(unknown.status).toBe(404)
    expect(code(unknown.json)).toBe('ORG_NOT_FOUND')
    const created = await call<{ wineryId: string }>(`/v1/harvest-batches?wineryId=${ALTOS.id}`, { token: admin, body: harvestBody })
    expect(created.status).toBe(201)
    expect(dataOf(created.json).wineryId).toBe(ALTOS.id)
    expect(dataOf((await call<{ commercialName: string }>(`/v1/wineries/my?wineryId=${CINTI.id}`, { token: admin })).json).commercialName).toBe(CINTI.commercialName)
  })

  it('SUPPORT solo lee', async () => {
    const support = (await loginSession('soporte@drinksonchain.test')).tokens.accessToken
    expect((await call(`/v1/terroirs?wineryId=${ALTOS.id}`, { token: support })).status).toBe(200)
    const write = await call(`/v1/harvest-batches?wineryId=${ALTOS.id}`, { token: support, body: harvestBody })
    expect(write.status).toBe(403)
    expect(code(write.json)).toBe('AUTH_INSUFFICIENT_PERMISSIONS')
    expect((await call('/v1/wineries?status=INVITED', { token: support })).status).toBe(200)
  })
})

describe('equipo de la bodega (SE-01)', () => {
  it('invitar a quien ya es miembro → 409 ORG_ALREADY_MEMBER; el dueño no desbloquea lo que bloqueó la plataforma (403 ORG_BLOCKED_BY_PLATFORM)', async () => {
    const owner = await login('admin@cintiviejo.test')
    const dup = await call('/v1/organizations/current/invitations', { token: owner, body: { email: 'enologa@cintiviejo.test', role: 'ENOLOGIST' } })
    expect(dup.status).toBe(409)
    expect(code(dup.json)).toBe('ORG_ALREADY_MEMBER')
    const veronica = F.users.find((u) => u._mock.key === 'cvj_contable')!
    const membershipId = CINTI.members!.find((m) => m.userId === veronica.id)!.id
    const blocked = await call(`/v1/organizations/current/members/${membershipId}/unblock`, { token: owner, body: {} })
    expect(blocked.status).toBe(403)
    expect(code(blocked.json)).toBe('ORG_BLOCKED_BY_PLATFORM')
    // La plataforma sí puede (con motivo y dentro del límite de colaboradores): test/backoffice-flows.test.ts.
  })
})

describe('sesión: códigos del backend', () => {
  it('acceso ausente o mal formado → 401 AUTH_TOKEN_INVALID', async () => {
    expect(code((await call('/v1/users/me')).json)).toBe('AUTH_TOKEN_INVALID')
    expect(code((await call('/v1/users/me', { token: 'no.es.jwt' })).json)).toBe('AUTH_TOKEN_INVALID')
  })

  it('refresco inventado con la forma correcta → 401 AUTH_REFRESH_INVALID sin revocar la sesión', async () => {
    const session = await loginSession('enologa@altos.test')
    const refresh = claimsSid(session.tokens.accessToken)
    const forged = `${refresh}.0.${'A'.repeat(43)}`
    const res = await call('/v1/auth/refresh', { method: 'POST', headers: { Cookie: `doc_rt=${forged}` } })
    expect(res.status).toBe(401)
    expect(code(res.json)).toBe('AUTH_REFRESH_INVALID')
    expect((await call('/v1/users/me', { token: session.tokens.accessToken })).status).toBe(200)
    // La sesión sigue viva: la renovación con la cookie que guarda MSW funciona.
    expect((await call('/v1/auth/refresh', { method: 'POST' })).status).toBe(200)
  })

  it('sesión sin uso más allá de su duración (7 días el personal) → 401 AUTH_SESSION_EXPIRED', async () => {
    await loginSession('enologa@altos.test')
    advanceMockClock(8 * 86_400_000)
    // Sin cookie explícita: la que guardó MSW al iniciar sesión.
    const res = await call('/v1/auth/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(code(res.json)).toBe('AUTH_SESSION_EXPIRED')
  })

  it('bloqueo progresivo del login: 5 fallos → 429 AUTH_TOO_MANY_ATTEMPTS con Retry-After, sin comprobar la contraseña', async () => {
    const email = 'agronomo@cintiviejo.test'
    for (let i = 1; i < LOGIN_LOCK_POLICY.emailThreshold; i++) {
      expect(code((await call('/v1/auth/login', { body: { email, password: 'mala' } })).json)).toBe('AUTH_INVALID_CREDENTIALS')
    }
    const fifth = await call('/v1/auth/login', { body: { email, password: 'mala' } })
    expect(fifth.status).toBe(429)
    expect(code(fifth.json)).toBe('AUTH_TOO_MANY_ATTEMPTS')
    expect(fifth.headers.get('retry-after')).toBe('60')
    const locked = await call('/v1/auth/login', { body: { email, password: 'demo1234' } })
    expect(locked.status).toBe(429)
    // Otro correo no se ve afectado.
    expect((await call('/v1/auth/login', { body: { email: 'enologa@cintiviejo.test', password: 'demo1234' } })).status).toBe(200)
  })

  it('PATCH /v1/users/me responde { user, memberships, activeOrganizationId } (Ola 1 §11 bis)', async () => {
    const token = await login('sofia@aramayo.test')
    const res = await call('/v1/users/me', { token, method: 'PATCH', body: { fullName: 'Sofía A.', promotionsConsent: true } })
    const me = MeResponseSchema.parse(dataOf(res.json))
    expect(me.user).toMatchObject({ fullName: 'Sofía A.', audience: 'STAFF', promotionsConsent: true })
    expect(me.memberships).toHaveLength(2)
    expect(me.activeOrganizationId).toBe(ALTOS.id)
  })

  it('bloqueo de cuenta completa por su ruta propia; la de usuarios internos solo acepta membresías de plataforma', async () => {
    const admin = (await loginSession('administracion@drinksonchain.test')).tokens.accessToken
    const carlos = F.users.find((u) => u._mock.key === 'carlos')!
    expect((await call(`/v1/platform/users/${carlos.id}/block`, { token: admin, body: { reason: REASON } })).status).toBe(404)
    const token = await login('carlos@tribu.test')
    expect((await call(`/v1/platform/accounts/${carlos.id}/block`, { token: admin, body: { reason: REASON } })).status).toBe(200)
    expect(code((await call('/v1/users/me', { token })).json)).toBe('AUTH_SESSION_REVOKED')
  })
})
