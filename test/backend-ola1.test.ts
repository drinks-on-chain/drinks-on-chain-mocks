import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AccountDetailSchema,
  BottlingBatchDetailSchema,
  ErrorEnvelopeSchema,
  InvitationSchema,
  MemberSchema,
  PlatformUserSchema,
  type Envelope,
  type LoginResponse,
} from '../src'
import { PLATFORM_ORGANIZATION } from '../src/erp/catalog'
import { erpFixtures as F } from '../src/fixtures'
import { mockMailbox } from '../src/handlers'
import { advanceMockClock, getErpDb, resetErpDb, setupMockServer } from '../src/node'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf, login, loginSession } from './helpers'

// Diferencias con el backend real de la Ola 1 completa (mocks 0.4): NIT, códigos de error,
// equipo, cuentas, invitaciones, segundo factor, bitácora y altas con `null`.

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
})
afterAll(() => server.close())

const W = (key: string) => F.wineries.find((w) => w.id === uid(`winery:${key}`))!
const member = (userKey: string, wineryKey: string) => W(wineryKey).members!.find((m) => m.userId === uid(`user:${userKey}`))!.id
const staff = (key: string) => `mock.access.${key}`
const REASON = 'Motivo de la prueba'
const errorOf = (json: Envelope<unknown>) => ErrorEnvelopeSchema.parse(json).error
const audit = (action: string) => [...getErpDb().backoffice.audit].reverse().find((e) => e.action === action)

const application = (taxId: string, contactEmail = 'contacto@nueva.test') => ({
  legalName: 'Nueva Bodega S.R.L.',
  tradeName: 'Bodega Nueva',
  taxId,
  category: 'WINERY',
  region: 'Valle Central de Tarija',
  contactName: 'Persona de contacto',
  contactEmail,
  captchaToken: 'ok',
  website: '',
})

describe('NIT y verificación de solicitudes (backend: tax-id.ts y winery-applications)', () => {
  it('una bodega REVOKED también ocupa su NIT: 202 silencioso y aviso de duplicado', async () => {
    const revoked = W('valle')
    expect(revoked.certificationStatus).toBe('REVOKED')
    const before = getErpDb().backoffice.applications.length
    const res = await call<{ id: string }>('/v1/public/winery-applications', { body: application(revoked.taxIdNit) })
    expect(res.status).toBe(202)
    expect(getErpDb().backoffice.applications).toHaveLength(before)
    expect(audit('WINERY_APPLICATION_DUPLICATE_TAX_ID')?.after).toMatchObject({ taxId: revoked.taxIdNit })
    // El alta directa con ese NIT → 409 ORG_TAX_ID_TAKEN en taxId
    const direct = await call('/v1/platform/wineries', {
      token: staff('operaciones'),
      body: { legalName: 'Otra S.R.L.', tradeName: 'Otra', taxId: revoked.taxIdNit, category: 'WINERY', region: 'Tarija', contactEmail: 'a@b.test', ownerEmail: 'duena@nueva.test', ownerFullName: 'Dueña' },
    })
    expect(errorOf(direct.json)).toMatchObject({ code: 'ORG_TAX_ID_TAKEN', details: [{ field: 'taxId' }] })
  })

  it('reenviar la misma solicitud sin verificar la actualiza y manda un enlace nuevo (el anterior deja de valer)', async () => {
    const first = dataOf((await call<{ id: string }>('/v1/public/winery-applications', { body: application('7123000001') })).json)
    const oldToken = mockMailbox.latest({ to: 'contacto@nueva.test', template: 'APPLICATION_VERIFY' })!.token!
    const again = dataOf((await call<{ id: string }>('/v1/public/winery-applications', { body: { ...application('7123000001'), tradeName: 'Bodega Nueva 2' } })).json)
    expect(again.id).toBe(first.id)
    const newToken = mockMailbox.latest({ to: 'contacto@nueva.test', template: 'APPLICATION_VERIFY' })!.token!
    expect(newToken).not.toBe(oldToken)
    expect(audit('WINERY_APPLICATION_SUBMITTED')?.after).toMatchObject({ resubmitted: true, tradeName: 'Bodega Nueva 2' })
    const stale = await call('/v1/public/winery-applications/verify', { body: { token: oldToken } })
    expect(errorOf(stale.json)).toMatchObject({ code: 'APPLICATION_TOKEN_INVALID', details: [{ field: 'token' }] })
    expect((await call('/v1/public/winery-applications/verify', { body: { token: newToken } })).status).toBe(204)
    // Ya usado → 422
    expect(errorOf((await call('/v1/public/winery-applications/verify', { body: { token: newToken } })).json).code).toBe('APPLICATION_TOKEN_INVALID')
  })

  it('el enlace caduca a las 72 h y una solicitud sin verificar caducada no ocupa el NIT', async () => {
    dataOf((await call('/v1/public/winery-applications', { body: application('7123000002', 'uno@nueva.test') })).json)
    const token = mockMailbox.latest({ to: 'uno@nueva.test', template: 'APPLICATION_VERIFY' })!.token!
    // Otra persona con el mismo NIT mientras el enlace vale: duplicado silencioso
    const dup = dataOf((await call<{ id: string }>('/v1/public/winery-applications', { body: application('7123000002', 'otra@nueva.test') })).json)
    expect(getErpDb().backoffice.applications.some((a) => a.id === dup.id)).toBe(false)
    advanceMockClock(73 * 3_600_000)
    expect(errorOf((await call('/v1/public/winery-applications/verify', { body: { token } })).json).code).toBe('APPLICATION_TOKEN_INVALID')
    const fresh = dataOf((await call<{ id: string }>('/v1/public/winery-applications', { body: application('7123000002', 'otra@nueva.test') })).json)
    expect(getErpDb().backoffice.applications.some((a) => a.id === fresh.id)).toBe(true)
  })

  it('token desconocido → 422 APPLICATION_TOKEN_INVALID (no 404)', async () => {
    expect(errorOf((await call('/v1/public/winery-applications/verify', { body: { token: 'no-existe' } })).json).code).toBe('APPLICATION_TOKEN_INVALID')
  })
})

describe('códigos 404 del backend', () => {
  it('bodega inexistente → ORG_NOT_FOUND; solicitud inexistente o miembro de otra organización → NOT_FOUND', async () => {
    const unknown = uid('winery:no-existe')
    expect(errorOf((await call(`/v1/platform/wineries/${unknown}`, { token: staff('soporte') })).json).code).toBe('ORG_NOT_FOUND')
    expect(errorOf((await call(`/v1/platform/wineries/${unknown}/suspend`, { token: staff('operaciones'), body: { reason: REASON } })).json).code).toBe('ORG_NOT_FOUND')
    expect(errorOf((await call(`/v1/platform/organizations/${unknown}/members`, { token: staff('soporte') })).json).code).toBe('ORG_NOT_FOUND')
    expect(errorOf((await call(`/v1/platform/winery-applications/${uid('application:no-existe')}`, { token: staff('soporte') })).json).code).toBe('NOT_FOUND')
    // Un miembro de Cinti Viejo pedido en Altos
    const other = await call(`/v1/platform/organizations/${W('altos').id}/members/${member('cvj_operario', 'cintiviejo')}/block`, {
      token: staff('soporte'),
      body: { reason: REASON },
    })
    expect(errorOf(other.json).code).toBe('NOT_FOUND')
    expect(errorOf((await call(`/v1/platform/accounts/${uid('user:no-existe')}`, { token: staff('soporte') })).json).code).toBe('USER_NOT_FOUND')
  })
})

describe('equipo (TeamService del backend)', () => {
  it('cambiar el rol revoca las sesiones de esa persona con la bodega; el mismo rol no cambia nada', async () => {
    const owner = await login('admin@altos.test')
    const mario = member('altos_operario', 'altos')
    const marioSession = await login('operario@altos.test')
    expect((await call('/v1/harvest-batches', { token: marioSession })).status).toBe(200)
    const audits = getErpDb().backoffice.audit.length
    expect((await call(`/v1/organizations/current/members/${mario}`, { token: owner, method: 'PATCH', body: { role: 'OPERATOR' } })).status).toBe(200)
    expect(getErpDb().backoffice.audit.length).toBe(audits) // sin cambios, sin bitácora
    expect((await call('/v1/harvest-batches', { token: marioSession })).status).toBe(200)
    expect((await call(`/v1/organizations/current/members/${mario}`, { token: owner, method: 'PATCH', body: { role: 'ACCOUNTANT' } })).status).toBe(200)
    expect(errorOf((await call('/v1/harvest-batches', { token: marioSession })).json).code).toBe('AUTH_SESSION_REVOKED')
  })

  it('lastLoginAt solo para el dueño; accountStatus solo en las rutas de plataforma', async () => {
    const own = dataOf((await call<{ items: unknown[] }>('/v1/organizations/current/members', { token: await login('admin@altos.test') })).json).items
    const ownMembers = own.map((m) => MemberSchema.parse(m))
    expect(ownMembers.some((m) => m.lastLoginAt !== null)).toBe(true)
    expect(ownMembers.every((m) => m.accountStatus === undefined && !('accountStatus' in (m as object)))).toBe(true)
    const basic = dataOf((await call<{ items: unknown[] }>('/v1/organizations/current/members', { token: await login('enologa@altos.test') })).json).items
    expect(basic.map((m) => MemberSchema.parse(m)).every((m) => m.lastLoginAt === null && m.status === 'ACTIVE')).toBe(true)
    const blockedOnly = await call<{ items: unknown[]; total: number }>('/v1/organizations/current/members?status=BLOCKED', { token: await login('enologa@altos.test') })
    expect(dataOf(blockedOnly.json).total).toBe(0)
    const platform = dataOf((await call<{ items: unknown[] }>(`/v1/platform/organizations/${W('altos').id}/members`, { token: staff('soporte') })).json).items
    expect(platform.map((m) => MemberSchema.parse(m)).every((m) => m.accountStatus === 'ACTIVE' && m.accountBlockedReason === null)).toBe(true)
  })

  it('la plataforma tampoco se modifica a sí misma en una bodega', async () => {
    // Ana (superusuaria) como miembro de Altos: tampoco se bloquea a sí misma desde el back office.
    const ana = F.users.find((u) => u._mock.key === 'admin')!
    const altos = getErpDb().wineries.find((w) => w.id === W('altos').id)!
    altos.members!.push({ ...altos.members![0]!, id: uid('member:ana-altos'), userId: ana.id, memberRole: 'OPERATOR', fullName: ana.fullName, email: ana.email })
    const res = await call(`/v1/platform/organizations/${altos.id}/members/${uid('member:ana-altos')}/block`, { token: staff('admin'), body: { reason: REASON } })
    expect(errorOf(res.json).code).toBe('ORG_CANNOT_MODIFY_SELF')
  })
})

describe('usuarios internos, cuentas e invitaciones de una bodega (ampliación §11 bis)', () => {
  it('PlatformUser lleva el estado de la cuenta; GET /v1/platform/accounts/{userId} con sus membresías', async () => {
    const users = dataOf((await call<{ items: unknown[] }>('/v1/platform/users', { token: staff('bo_admin') })).json).items.map((u) => PlatformUserSchema.parse(u))
    expect(users.filter((u) => u.status !== 'INVITED').every((u) => u.accountStatus === 'ACTIVE')).toBe(true)
    const invited = users.filter((u) => u.status === 'INVITED')
    expect(invited.length).toBeGreaterThan(0)
    for (const u of invited) {
      if (u.userId === null) expect(u).toMatchObject({ accountStatus: null, fullName: u.email })
    }
    const sofia = uid('user:sofia')
    expect((await call(`/v1/platform/accounts/${sofia}/block`, { token: staff('bo_admin'), body: { reason: 'Cuenta comprometida' } })).status).toBe(200)
    const detail = AccountDetailSchema.parse(dataOf((await call(`/v1/platform/accounts/${sofia}`, { token: staff('soporte') })).json))
    expect(detail).toMatchObject({ userId: sofia, status: 'BLOCKED', blockedReason: 'Cuenta comprometida' })
    expect(detail.blockedAt).not.toBeNull()
    expect(detail.memberships.map((m) => m.organizationName).sort()).toEqual(['Bodega Altos de Calamuchita', 'Casa Uriondo'])
    const members = dataOf((await call<{ items: unknown[] }>(`/v1/platform/organizations/${W('altos').id}/members`, { token: staff('soporte') })).json).items
    expect(members.map((m) => MemberSchema.parse(m)).find((m) => m.userId === sofia)).toMatchObject({ accountStatus: 'BLOCKED', accountBlockedReason: 'Cuenta comprometida' })
    // El superusuario no se bloquea (tampoco su cuenta)
    const ana = F.users.find((u) => u._mock.key === 'admin')!
    expect(errorOf((await call(`/v1/platform/accounts/${ana.id}/block`, { token: staff('bo_admin'), body: { reason: REASON } })).json).code).toBe('PLATFORM_SUPERADMIN_PROTECTED')
  })

  it('GET /v1/platform/organizations/{id}/invitations: invitaciones de una bodega; la de plataforma → 404', async () => {
    const page = dataOf((await call<{ items: unknown[] }>(`/v1/platform/organizations/${W('altos').id}/invitations?status=PENDING`, { token: staff('soporte') })).json)
    const items = page.items.map((i) => InvitationSchema.parse(i))
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.organizationId === W('altos').id && i.status === 'PENDING')).toBe(true)
    expect(errorOf((await call(`/v1/platform/organizations/${PLATFORM_ORGANIZATION.id}/invitations`, { token: staff('soporte') })).json).code).toBe('ORG_NOT_FOUND')
    expect((await call(`/v1/platform/organizations/${W('altos').id}/invitations`, { token: await login('admin@altos.test') })).status).toBe(403)
  })

  it('bloquear la membresía de plataforma solo cierra las sesiones con la plataforma', async () => {
    const valeria = await loginSession('operaciones@drinksonchain.test')
    const membershipId = uid(`membership:platform:${uid('user:operaciones')}`)
    expect((await call(`/v1/platform/users/${membershipId}/block`, { token: staff('bo_admin'), body: { reason: REASON } })).status).toBe(200)
    expect(errorOf((await call('/v1/platform/dashboard', { token: valeria.tokens.accessToken })).json).code).toBe('AUTH_SESSION_REVOKED')
  })
})

describe('segundo factor: códigos del backend', () => {
  async function challenge(email: string) {
    const data = dataOf((await call<LoginResponse>('/v1/auth/login', { body: { email, password: 'demo1234' } })).json)
    if (!('mfa' in data)) throw new Error('sin reto')
    return data.mfa.mfaToken
  }

  it('AUTH_MFA_NOT_ENROLLED, AUTH_MFA_ALREADY_ENROLLED y AUTH_MFA_ENROLLMENT_NOT_STARTED en lugar de CONFLICT', async () => {
    const pending = await challenge('analista@drinksonchain.test')
    expect(errorOf((await call('/v1/auth/mfa/verify', { body: { mfaToken: pending, code: '123456' } })).json).code).toBe('AUTH_MFA_NOT_ENROLLED')
    expect(errorOf((await call('/v1/auth/mfa/enroll/confirm', { body: { mfaToken: pending, code: '123456' } })).json).code).toBe('AUTH_MFA_ENROLLMENT_NOT_STARTED')
    const enrolled = await challenge('gestor@drinksonchain.test')
    expect(errorOf((await call('/v1/auth/mfa/enroll', { body: { mfaToken: enrolled } })).json).code).toBe('AUTH_MFA_ALREADY_ENROLLED')
    const wrong = await call('/v1/auth/mfa/verify', { body: { mfaToken: enrolled, code: '000001' } })
    expect(errorOf(wrong.json)).toMatchObject({ code: 'AUTH_MFA_INVALID_CODE', details: null })
  })

  it('aceptar una invitación de plataforma devuelve el reto TOTP', async () => {
    const res = await call<LoginResponse>('/v1/invitations/demo-invitacion-soporte/accept', { body: { fullName: 'Soporte Nuevo', password: 'vendimia-2026' } })
    const data = dataOf(res.json)
    expect('mfa' in data && data.mfa.required).toBe(true)
  })
})

describe('bitácora y altas del ERP como el backend', () => {
  it('tipos de recurso en snake_case y acciones del backend', async () => {
    const token = await login('agronomo@altos.test')
    const body = { parcelName: 'Cuartel snake_case', surfaceHectares: 1, altitudeMasl: 1800, rawMaterialType: 'uva', varietyName: 'Malbec', cadastreCode: null, soilType: null }
    // `null` en un opcional del alta cuenta como omitido (class-validator del backend)
    const created = await call<{ id: string; cadastreCode: string | null }>('/v1/terroirs', { token, body })
    expect(created.status).toBe(201)
    expect(dataOf(created.json).cadastreCode).toBeNull()
    expect(audit('TERROIR_CREATED')?.resource).toEqual({ type: 'terroir', id: dataOf(created.json).id })
    const types = new Set(getErpDb().backoffice.audit.map((e) => e.resource.type))
    for (const t of types) expect(t).toMatch(/^[a-z_]+$/)
    expect(types).toContain('winery_application')
    expect(types).toContain('wine_aging_batch')
  })
})

describe('relaciones del ERP como los include del backend', () => {
  it('listas y detalles con sus relaciones; lecturas con la persona y tratamientos con el miembro', async () => {
    const token = await login('enologa@cintiviejo.test')
    const harvests = dataOf((await call<{ items: Array<Record<string, unknown>> }>('/v1/harvest-batches', { token })).json).items
    expect(harvests.every((h) => (h.terroir as { id?: string } | undefined)?.id === h.terroirId)).toBe(true)
    const tanks = dataOf((await call<{ items: Array<Record<string, unknown>> }>('/v1/fermentation-tanks', { token })).json).items
    expect(tanks.every((t) => (t.harvestBatch as { id?: string } | undefined)?.id === t.harvestBatchId && !('logs' in t))).toBe(true)
    const tank = F.fermentationTanks.find((t) => t.wineryId === W('cintiviejo').id && F.fermentationLogs.some((l) => l.fermentationTankId === t.id))!
    const detail = dataOf((await call<{ logs: Array<Record<string, unknown>>; treatments: Array<Record<string, unknown>> }>(`/v1/fermentation-tanks/${tank.id}`, { token })).json)
    expect(detail.logs.length).toBeGreaterThan(0)
    expect(detail.logs.every((l) => typeof l.recordedByUserId === 'string' && !('recordedByMemberId' in l))).toBe(true)
    expect(detail.treatments.every((t) => typeof t.authorizedByMemberId === 'string' && t.authorizedByMemberId !== '')).toBe(true)
    const bottling = F.bottling.find((b) => b.wineryId === W('cintiviejo').id && b.productionBatchId)!
    const full = BottlingBatchDetailSchema.parse(dataOf((await call(`/v1/bottling/${bottling.id}`, { token })).json))
    expect(full.wineAgingBatch).toBeNull()
    expect(full.productionBatch?.fermentationTank?.harvestBatch?.terroir?.id).toBeTruthy()
    expect(full.labAnalysis === null || full.labAnalysis?.bottlingBatchId === bottling.id).toBe(true)
    const list = dataOf((await call<{ items: Array<Record<string, unknown>> }>('/v1/bottling', { token })).json).items
    expect(list.every((b) => 'labAnalysis' in b && !('productionBatch' in b))).toBe(true)
  })

  it('un tratamiento lo autoriza un miembro activo; la plataforma solo lee la trazabilidad (Ola 2, S-25) → 403', async () => {
    const tank = F.fermentationTanks.find((t) => t.wineryId === W('altos').id)!
    const body = { treatmentType: 'SO2_ADDITION', additiveName: 'Metabisulfito', dosageAppliedGPerHl: 30, regulatoryAuthCode: 'SENASAG-1', appliedAt: '2026-09-25' }
    const res = await call(`/v1/fermentation-tanks/${tank.id}/treatments?wineryId=${W('altos').id}`, { token: staff('operaciones'), body })
    expect(res.status).toBe(403)
    const logBody = { temperatureCelsius: 20, recordedAt: '2026-09-25T08:00:00Z' }
    const asStaff = await call(`/v1/fermentation-tanks/${tank.id}/logs?wineryId=${W('altos').id}`, { token: staff('operaciones'), body: logBody })
    expect(asStaff.status).toBe(403)
    expect(asStaff.json).toMatchObject({ error: { code: 'TRC_PLATFORM_READ_ONLY' } })
    const treatment = await call<{ authorizedByMemberId: string }>(`/v1/fermentation-tanks/${tank.id}/treatments`, { token: 'mock.access.altos_enologa', body })
    expect(dataOf(treatment.json).authorizedByMemberId).toBe(uid('member:altos_enologa'))
    const log = await call<{ recordedByUserId: string }>(`/v1/fermentation-tanks/${tank.id}/logs`, { token: 'mock.access.altos_operario', body: logBody })
    expect(dataOf(log.json).recordedByUserId).toBe(uid('user:altos_operario'))
  })
})
