import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AuditEventSchema,
  ErrorEnvelopeSchema,
  InvitationSchema,
  MemberSchema,
  SessionResponseSchema,
  WineryDetailSchema,
  type AuditEvent,
  type Envelope,
  type Invitation,
  type LoginResponse,
  type SessionResponse,
  type WineryDetail,
} from '../src'
import { PLATFORM_ORGANIZATION } from '../src/erp/catalog'
import { DEMO_NEW_PASSWORD, DEMO_TOTP_SECRET, erpFixtures as F, generateTotp, MOCK_TOTP_BYPASS_CODE } from '../src/fixtures'
import { mockMailbox, resetScenario, setScenario } from '../src/handlers'
import { advanceMockClock, getErpDb, resetErpDb, setupMockServer } from '../src/node'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf, login, loginSession, loginWithRefresh } from './helpers'

// Recorridos de la Ola 1 contra los handlers (plan/contratos/o1-backoffice-y-bodegas.md).

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
  resetScenario()
})
afterAll(() => server.close())

const W = (key: string) => F.wineries.find((w) => w.id === uid(`winery:${key}`))!
const ALTOS = W('altos')
const CINTI = W('cintiviejo')
const URIONDO = W('uriondo')
const member = (userKey: string, wineryKey: string) => W(wineryKey).members!.find((m) => m.userId === uid(`user:${userKey}`))!.id
const staticToken = (key: string) => `mock.access.${key}`
const REASON = 'Motivo de la prueba'
const BO = { 'X-Client-App': 'BACKOFFICE' }
const ERP = { 'X-Client-App': 'ERP' }

function errorOf(json: Envelope<unknown>) {
  return ErrorEnvelopeSchema.parse(json).error
}

function lastAudit(action: string): AuditEvent {
  const e = [...getErpDb().backoffice.audit].reverse().find((x) => x.action === action)
  if (!e) throw new Error(`Sin evento ${action}`)
  return AuditEventSchema.parse(e)
}

describe('alta de una bodega por solicitud (camino A), de punta a punta', () => {
  it('solicitud pública → verificar → tomar → aprobar → invitación → aceptar con cuenta nueva → bodega ACTIVE con prefijo', async () => {
    // 1. Formulario público de /unirse
    const created = await call<{ id: string; status: string }>('/v1/public/winery-applications', {
      headers: { 'X-Client-App': 'PUBLIC' },
      body: {
        legalName: 'Bodega Cepas del Sur S.R.L.',
        tradeName: 'Bodega Cepas del Sur',
        taxId: '7300112233',
        category: 'WINERY',
        region: 'Valle Central de Tarija · San Lorenzo',
        contactName: 'Julia Soto',
        contactEmail: 'julia@cepasdelsur.test',
        contactPhone: '+59172001122',
        message: 'Queremos sumarnos a la red',
        captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
        website: '',
      },
    })
    expect(created.status).toBe(202)
    const { id } = dataOf(created.json)
    // 2. Verificar el correo (enlace del buzón simulado)
    const verifyMail = mockMailbox.latest({ to: 'julia@cepasdelsur.test', template: 'APPLICATION_VERIFY' })!
    expect(verifyMail.link).toBe(`http://localhost:3000/unirse/verificar?token=${verifyMail.token}`)
    expect((await call('/v1/public/winery-applications/verify', { body: { token: verifyMail.token } })).status).toBe(204)
    expect((await call('/v1/public/winery-applications/verify', { body: { token: verifyMail.token } })).status).toBe(422)
    expect(mockMailbox.latest({ template: 'APPLICATION_NEW_FOR_OPERATIONS' })).not.toBeNull()
    // 3. Operaciones la ve en la bandeja (sin notas), la toma y la aprueba
    const ops = await login('operaciones@drinksonchain.test')
    const inbox = dataOf((await call<{ items: Array<{ id: string; status: string }> }>('/v1/platform/winery-applications?status=RECEIVED', { token: ops })).json)
    expect(inbox.items.find((a) => a.id === id)).toMatchObject({ status: 'RECEIVED' })
    expect(inbox.items[0]).not.toHaveProperty('notes')
    expect((await call(`/v1/platform/winery-applications/${id}/approve`, { token: ops, body: {} })).status).toBe(409)
    expect(dataOf((await call(`/v1/platform/winery-applications/${id}/take`, { token: ops, body: {} })).json)).toMatchObject({
      status: 'IN_REVIEW',
      assignee: { fullName: 'Valeria Méndez' },
    })
    const approved = dataOf((await call<{ winery: WineryDetail; invitation: Invitation }>(`/v1/platform/winery-applications/${id}/approve`, { token: ops, body: {}, headers: BO })).json)
    expect(approved.winery).toMatchObject({ status: 'INVITED', lotPrefix: null, owner: { userId: null, fullName: 'Julia Soto', email: 'julia@cepasdelsur.test' } })
    expect(approved.invitation).toMatchObject({ role: 'OWNER', status: 'PENDING', organizationType: 'WINERY', invitedBy: { viaPlatform: true } })
    // 4. La dueña abre el enlace del correo (lleva al ERP) y crea su cuenta
    const invite = mockMailbox.latest({ to: 'julia@cepasdelsur.test', template: 'INVITATION' })!
    expect(invite.link).toBe(`http://localhost:3002/invitacion/${encodeURIComponent(invite.token!)}`)
    const preview = dataOf((await call(`/v1/invitations/${invite.token}`)).json)
    expect(preview).toMatchObject({ organizationName: 'Bodega Cepas del Sur', role: 'OWNER', accountExists: false, status: 'PENDING' })
    const weak = await call(`/v1/invitations/${invite.token}/accept`, { body: { fullName: 'Julia Soto', password: 'demo1234' } })
    expect(weak.status).toBe(422)
    expect(errorOf(weak.json)).toMatchObject({ code: 'AUTH_WEAK_PASSWORD', details: [{ field: 'password', message: 'Debe tener al menos 10 caracteres' }] })
    const accepted = await call<SessionResponse>(`/v1/invitations/${invite.token}/accept`, { body: { fullName: 'Julia Soto', password: DEMO_NEW_PASSWORD }, headers: ERP })
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('set-cookie')).toMatch(/^doc_rt=/)
    const session = SessionResponseSchema.parse(dataOf(accepted.json))
    expect(session.activeOrganizationId).toBe(approved.winery.id)
    expect(session.memberships).toEqual([expect.objectContaining({ organizationId: approved.winery.id, role: 'OWNER' })])
    // 5. La bodega queda ACTIVE con prefijo de lote y el ERP funciona
    const detail = WineryDetailSchema.parse(dataOf((await call(`/v1/platform/wineries/${approved.winery.id}`, { token: ops })).json))
    expect(detail).toMatchObject({ status: 'ACTIVE', lotPrefix: 'CSU', membersCount: 1, owner: { fullName: 'Julia Soto' } })
    expect(detail.statusHistory.map((h) => h.status)).toEqual(['INVITED', 'ACTIVE'])
    expect((await call('/v1/terroirs', { token: session.tokens.accessToken })).status).toBe(200)
    expect((await call(`/v1/invitations/${invite.token}/accept`, { body: { fullName: 'Otra', password: DEMO_NEW_PASSWORD } })).status).toBe(409)
    expect(lastAudit('WINERY_ACTIVATED')).toMatchObject({ organizationId: approved.winery.id, source: { app: 'ERP' }, after: { lotPrefix: 'CSU' } })
    expect(lastAudit('WINERY_APPLICATION_APPROVED')).toMatchObject({ source: { app: 'BACKOFFICE' }, actor: { fullName: 'Valeria Méndez', viaPlatform: true } })
  })

  it('campo trampa relleno: 202 silencioso sin crear nada; NIT existente: 202 y aviso a operaciones', async () => {
    const before = getErpDb().backoffice.applications.length
    const base = {
      legalName: 'Spam S.R.L.',
      tradeName: 'Spam',
      taxId: '7999999999',
      category: 'OTHER',
      region: 'Cualquiera',
      contactName: 'Bot',
      contactEmail: 'bot@spam.test',
      captchaToken: 'ok',
    }
    expect((await call('/v1/public/winery-applications', { body: { ...base, website: 'http://spam' } })).status).toBe(202)
    expect((await call('/v1/public/winery-applications', { body: { ...base, taxId: ALTOS.taxIdNit } })).status).toBe(202)
    expect(getErpDb().backoffice.applications.length).toBe(before)
    expect(mockMailbox.latest({ template: 'APPLICATION_DUPLICATE_FOR_OPERATIONS' })!.subject).toContain(ALTOS.taxIdNit)
    const captcha = await call('/v1/public/winery-applications', { body: { ...base, captchaToken: 'fail' } })
    expect(errorOf(captcha.json)).toMatchObject({ code: 'CAPTCHA_INVALID', details: [{ field: 'captchaToken' }] })
  })

  it('transiciones inválidas → 409 APPLICATION_INVALID_TRANSITION; reunión y rechazo con motivo', async () => {
    const ops = await login('operaciones@drinksonchain.test')
    const angostura = uid('application:angostura')
    expect(errorOf((await call(`/v1/platform/winery-applications/${angostura}/take`, { token: ops, body: {} })).json).code).toBe('APPLICATION_INVALID_TRANSITION')
    expect(dataOf((await call(`/v1/platform/winery-applications/${angostura}/meeting-done`, { token: ops, body: { notes: 'Hecha' } })).json)).toMatchObject({ status: 'IN_REVIEW' })
    const noReason = await call(`/v1/platform/winery-applications/${angostura}/reject`, { token: ops, body: {} })
    expect(errorOf(noReason.json)).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'reason', message: 'Campo obligatorio' }] })
    const rejected = dataOf((await call(`/v1/platform/winery-applications/${angostura}/reject`, { token: ops, body: { reason: 'Sin viñedo propio' } })).json)
    expect(rejected).toMatchObject({ status: 'REJECTED', decision: { reason: 'Sin viñedo propio', by: 'Valeria Méndez' } })
    expect(mockMailbox.latest({ to: 'marcelo@laangostura.test', template: 'APPLICATION_REJECTED' })!.text).toContain('Sin viñedo propio')
    // Soporte solo lee
    const support = await login('soporte@drinksonchain.test')
    expect((await call(`/v1/platform/winery-applications/${angostura}`, { token: support })).status).toBe(200)
    expect((await call(`/v1/platform/winery-applications/${uid('application:andina')}/take`, { token: support, body: {} })).status).toBe(403)
  })
})

describe('alta directa, suspensión y bodega no activa en el ERP', () => {
  it('alta directa (camino B) → invitación al dueño → aceptar', async () => {
    const ops = await login('operaciones@drinksonchain.test')
    const res = await call<{ winery: WineryDetail; invitation: Invitation }>('/v1/platform/wineries', {
      token: ops,
      body: {
        legalName: 'Singani Alto S.A.',
        tradeName: 'Destilería Singani Alto',
        taxId: '7400223344',
        category: 'DISTILLERY',
        region: 'Valle de Cinti · Camargo',
        contactEmail: 'hola@singanialto.test',
        ownerEmail: 'dueno@singanialto.test',
        ownerFullName: 'Óscar Rueda',
      },
    })
    expect(res.status).toBe(201)
    const { winery, invitation } = dataOf(res.json)
    expect(winery).toMatchObject({ status: 'INVITED', slug: 'destileria-singani-alto', statusHistory: [{ status: 'INVITED', by: 'Valeria Méndez', reason: 'Alta directa' }] })
    const token = mockMailbox.latest({ to: 'dueno@singanialto.test' })!.token!
    expect(InvitationSchema.parse(invitation).email).toBe('dueno@singanialto.test')
    expect((await call(`/v1/invitations/${token}/accept`, { body: { fullName: 'Óscar Rueda', password: DEMO_NEW_PASSWORD } })).status).toBe(200)
    expect(dataOf((await call<WineryDetail>(`/v1/platform/wineries/${winery.id}`, { token: ops })).json)).toMatchObject({ status: 'ACTIVE', lotPrefix: 'SAL' })
    const dup = await call('/v1/platform/wineries', { token: ops, body: { legalName: 'Otra S.R.L.', tradeName: 'Otra', taxId: ALTOS.taxIdNit, category: 'WINERY', region: 'Tarija', contactEmail: 'a@b.test', ownerEmail: 'c@d.test', ownerFullName: 'C' } })
    expect(errorOf(dup.json).code).toBe('ORG_TAX_ID_TAKEN')
  })

  it('suspender: revoca las sesiones de la bodega y el ERP responde 403 ORG_NOT_ACTIVE; reactivar lo devuelve', async () => {
    const owner = (await loginSession('admin@altos.test')).tokens.accessToken
    expect((await call('/v1/terroirs', { token: owner })).status).toBe(200)
    const ops = await login('operaciones@drinksonchain.test')
    const suspended = dataOf((await call<WineryDetail>(`/v1/platform/wineries/${ALTOS.id}/suspend`, { token: ops, body: { reason: 'Registro vencido' } })).json)
    expect(suspended.status).toBe('SUSPENDED')
    expect(mockMailbox.latest({ to: 'admin@altos.test', template: 'WINERY_STATUS_CHANGED' })!.text).toContain('Registro vencido')
    // La sesión con esa organización activa se revocó
    expect(errorOf((await call('/v1/terroirs', { token: owner })).json).code).toBe('AUTH_SESSION_REVOKED')
    // Al volver a entrar, el ERP explica que la bodega no está activa
    const again = (await loginSession('admin@altos.test')).tokens.accessToken
    const blocked = await call('/v1/terroirs', { token: again })
    expect(blocked.status).toBe(403)
    expect(errorOf(blocked.json)).toMatchObject({ code: 'ORG_NOT_ACTIVE', details: [{ field: null, message: 'SUSPENDED' }] })
    expect((await call('/v1/organizations/current', { token: again })).status).toBe(200)
    expect((await call('/v1/organizations/current/audit', { token: again })).status).toBe(200)
    expect((await call('/v1/organizations/current/members', { token: again })).status).toBe(403)
    expect(errorOf((await call(`/v1/platform/wineries/${ALTOS.id}/suspend`, { token: ops, body: { reason: 'Otra vez' } })).json).code).toBe('ORG_INVALID_TRANSITION')
    expect(dataOf((await call<WineryDetail>(`/v1/platform/wineries/${ALTOS.id}/reactivate`, { token: ops, body: { reason: 'Registro renovado' } })).json).status).toBe('ACTIVE')
    expect((await call('/v1/terroirs', { token: again })).status).toBe(200)
    // Revocar es solo de administración
    expect((await call(`/v1/platform/wineries/${ALTOS.id}/revoke`, { token: ops, body: { reason: REASON } })).status).toBe(403)
  })

  it('bodega invitada (Viñedos del Guadalquivir): el ERP responde ORG_NOT_ACTIVE con INVITED; reenviar y aceptar con la cuenta existente la activa', async () => {
    const { session: elenaSession, refresh: elenaRefresh } = await loginWithRefresh('gerencia@guadalquivir.test')
    const elena = elenaSession.tokens.accessToken
    expect(errorOf((await call('/v1/terroirs', { token: elena })).json)).toMatchObject({ code: 'ORG_NOT_ACTIVE', details: [{ message: 'INVITED' }] })
    expect((await call('/v1/organizations/current', { token: elena })).status).toBe(403)
    // La invitación de dueño caducó: la reenvía operaciones
    const ops = await login('operaciones@drinksonchain.test')
    const inv = uid('invitation:guadalquivir-owner')
    expect((await call('/v1/invitations/demo-invitacion-guadalquivir')).json).toMatchObject({ data: { status: 'EXPIRED', accountExists: true } })
    expect(errorOf((await call('/v1/invitations/demo-invitacion-guadalquivir/accept', { token: elena, body: {} })).json).code).toBe('INVITATION_EXPIRED')
    expect(dataOf((await call<Invitation>(`/v1/invitations/${inv}/resend`, { token: ops, body: {} })).json).status).toBe('PENDING')
    expect(errorOf((await call('/v1/invitations/demo-invitacion-guadalquivir')).json).code).toBe('INVITATION_NOT_FOUND')
    const token = mockMailbox.latest({ to: 'gerencia@guadalquivir.test', template: 'INVITATION' })!.token!
    expect(errorOf((await call(`/v1/invitations/${token}/accept`, { token: await login('admin@altos.test'), body: {} })).json).code).toBe('INVITATION_EMAIL_MISMATCH')
    // Cuenta existente: 401 AUTH_LOGIN_REQUIRED sin sesión; con el acceso, además el refresco de esa sesión (cookie doc_rt)
    expect(errorOf((await call(`/v1/invitations/${token}/accept`, { body: {} })).json).code).toBe('AUTH_LOGIN_REQUIRED')
    expect(errorOf((await call(`/v1/invitations/${token}/accept`, { token: elena, body: {} })).json).code).toBe('AUTH_REFRESH_INVALID')
    const cookie = { Cookie: `doc_rt=${elenaRefresh}` }
    const accepted = SessionResponseSchema.parse(dataOf((await call(`/v1/invitations/${token}/accept`, { token: elena, body: {}, headers: cookie })).json))
    expect((await call('/v1/terroirs', { token: accepted.tokens.accessToken })).status).toBe(200)
    expect(dataOf((await call<WineryDetail>(`/v1/platform/wineries/${W('guadalquivir').id}`, { token: ops })).json)).toMatchObject({ status: 'ACTIVE', lotPrefix: 'VGQ' })
  })

  it('invitación de otra app: un token emitido por los mocks se reconoce aunque el estado local no lo tenga', async () => {
    const ops = await login('operaciones@drinksonchain.test')
    const res = await call<{ winery: WineryDetail }>('/v1/platform/wineries', {
      token: ops,
      body: { legalName: 'Portátil S.R.L.', tradeName: 'Bodega Portátil', taxId: '7500334455', category: 'WINERY', region: 'Tarija', contactEmail: 'p@portatil.test', ownerEmail: 'duena@portatil.test', ownerFullName: 'Paula Paz' },
    })
    const wineryId = dataOf(res.json).winery.id
    const token = mockMailbox.latest({ to: 'duena@portatil.test' })!.token!
    resetErpDb() // otra app: su propio estado, sin esa bodega ni esa invitación
    expect(getErpDb().wineries.some((w) => w.id === wineryId)).toBe(false)
    expect(dataOf((await call(`/v1/invitations/${token}`)).json)).toMatchObject({ organizationName: 'Bodega Portátil', role: 'OWNER' })
    const session = SessionResponseSchema.parse(dataOf((await call(`/v1/invitations/${token}/accept`, { body: { fullName: 'Paula Paz', password: DEMO_NEW_PASSWORD } })).json))
    expect(session.activeOrganizationId).toBe(wineryId)
    expect(getErpDb().wineries.find((w) => w.id === wineryId)!.certificationStatus).toBe('ACTIVE')
  })

  it('transferir la titularidad: al aceptar, la dueña anterior pasa a enóloga', async () => {
    const admin = await login('administracion@drinksonchain.test')
    const res = await call(`/v1/platform/wineries/${ALTOS.id}/transfer-ownership`, {
      token: admin,
      body: { newOwnerEmail: 'enologa@altos.test', reason: 'Venta de participaciones', keepPreviousOwnerAs: 'ENOLOGIST' },
    })
    expect(res.status).toBe(200)
    const token = mockMailbox.latest({ to: 'enologa@altos.test', template: 'INVITATION' })!.token!
    const carla = await login('enologa@altos.test')
    expect((await call(`/v1/invitations/${token}/accept`, { token: carla, body: {} })).status).toBe(200)
    const members = dataOf((await call<{ items: Array<{ email: string; role: string; status: string }> }>(`/v1/platform/organizations/${ALTOS.id}/members`, { token: admin })).json).items
    expect(members.find((m) => m.email === 'enologa@altos.test')).toMatchObject({ role: 'OWNER', status: 'ACTIVE' })
    expect(members.find((m) => m.email === 'admin@altos.test')).toMatchObject({ role: 'ENOLOGIST', status: 'ACTIVE' })
    expect(lastAudit('WINERY_OWNERSHIP_TRANSFERRED').organizationId).toBe(ALTOS.id)
  })
})

describe('equipo de la bodega (dueño y back office)', () => {
  it('invitar: rol OWNER reservado, ya miembro, invitación pendiente y límite de colaboradores', async () => {
    const owner = await login('admin@altos.test')
    const inv = (body: unknown, token = owner) => call('/v1/organizations/current/invitations', { token, body })
    expect(errorOf((await inv({ email: 'x@altos.test', role: 'OWNER' })).json).code).toBe('ORG_OWNER_ROLE_RESERVED')
    expect(errorOf((await inv({ email: 'enologa@altos.test', role: 'OPERATOR' })).json).code).toBe('ORG_ALREADY_MEMBER')
    expect(errorOf((await inv({ email: 'enologo.junior@altos.test', role: 'OPERATOR' })).json).code).toBe('INVITATION_ALREADY_PENDING')
    const bad = await inv({ email: 'no-es-correo', role: 'OPERATOR' })
    expect(errorOf(bad.json)).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'email', message: 'El correo no es válido' }] })
    // Cinti Viejo: límite 6 (5 activos + 1 invitación pendiente)
    const rosa = await login('admin@cintiviejo.test')
    const limit = await inv({ email: 'nuevo@cintiviejo.test', role: 'OPERATOR' }, rosa)
    expect(limit.status).toBe(422)
    expect(errorOf(limit.json)).toMatchObject({ code: 'ORG_MEMBER_LIMIT_REACHED', details: [{ field: 'email' }] })
    // Anular la pendiente libera un lugar
    expect((await call(`/v1/invitations/${uid('invitation:cintiviejo-operario')}/revoke`, { token: rosa, body: {} })).status).toBe(200)
    expect((await inv({ email: 'nuevo@cintiviejo.test', role: 'OPERATOR' }, rosa)).status).toBe(201)
    // Otra bodega no ve esa invitación
    expect((await call(`/v1/invitations/${uid('invitation:cintiviejo-operario')}/resend`, { token: owner, body: {} })).status).toBe(404)
  })

  it('rol y bloqueo: no a sí mismo, bloqueo revoca la sesión, el dueño no desbloquea lo que bloqueó la plataforma', async () => {
    const owner = await login('admin@altos.test')
    const self = await call(`/v1/organizations/current/members/${member('altos_admin', 'altos')}`, { token: owner, method: 'PATCH', body: { role: 'ENOLOGIST' } })
    expect(errorOf(self.json).code).toBe('ORG_CANNOT_MODIFY_SELF')
    const mario = member('altos_operario', 'altos')
    expect(MemberSchema.parse(dataOf((await call(`/v1/organizations/current/members/${mario}`, { token: owner, method: 'PATCH', body: { role: 'ACCOUNTANT' } })).json)).role).toBe('ACCOUNTANT')
    const marioSession = await login('operario@altos.test')
    expect((await call('/v1/fermentation-tanks', { token: marioSession })).status).toBe(200)
    expect(dataOf((await call(`/v1/organizations/current/members/${mario}/block`, { token: owner, body: { reason: 'Vacaciones' } })).json)).toMatchObject({ status: 'BLOCKED', blockedBy: 'OWNER', blockedReason: 'Vacaciones' })
    expect(errorOf((await call('/v1/fermentation-tanks', { token: marioSession })).json).code).toBe('AUTH_SESSION_REVOKED')
    expect(dataOf((await call(`/v1/organizations/current/members/${mario}/unblock`, { token: owner, body: {} })).json)).toMatchObject({ status: 'ACTIVE', blockedBy: null })
    // Cinti Viejo: la contadora la bloqueó la plataforma
    const rosa = await login('admin@cintiviejo.test')
    const contable = member('cvj_contable', 'cintiviejo')
    expect(errorOf((await call(`/v1/organizations/current/members/${contable}/unblock`, { token: rosa, body: {} })).json).code).toBe('ORG_BLOCKED_BY_PLATFORM')
    const support = await login('soporte@drinksonchain.test')
    const noReason = await call(`/v1/platform/organizations/${CINTI.id}/members/${contable}/unblock`, { token: support, body: {} })
    expect(errorOf(noReason.json)).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'reason' }] })
    // Desbloquear respeta el límite de colaboradores (Cinti Viejo: 6 de 6 con la invitación pendiente)
    const full = await call(`/v1/platform/organizations/${CINTI.id}/members/${contable}/unblock`, { token: support, body: { reason: 'Confirmado con la dueña' } })
    expect(errorOf(full.json).code).toBe('ORG_MEMBER_LIMIT_REACHED')
    const pending = uid('invitation:cintiviejo-operario')
    expect((await call(`/v1/invitations/${pending}/revoke`, { token: support, body: { reason: 'Libera un lugar del equipo' } })).status).toBe(200)
    expect(dataOf((await call(`/v1/platform/organizations/${CINTI.id}/members/${contable}/unblock`, { token: support, body: { reason: 'Confirmado con la dueña' }, headers: BO })).json)).toMatchObject({ status: 'ACTIVE' })
    expect(mockMailbox.latest({ to: 'admin@cintiviejo.test', template: 'TEAM_CHANGED_BY_PLATFORM' })!.text).toContain('Confirmado con la dueña')
    expect(lastAudit('MEMBER_UNBLOCKED')).toMatchObject({ reason: 'Confirmado con la dueña', source: { app: 'BACKOFFICE' }, actor: { viaPlatform: true } })
    // Los demás roles leen nombres y roles de los activos
    const carla = await login('enologa@altos.test')
    const seen = dataOf((await call<{ items: Array<{ status: string }> }>('/v1/organizations/current/members', { token: carla })).json).items
    expect(seen.every((m) => m.status === 'ACTIVE')).toBe(true)
    expect((await call(`/v1/organizations/current/members/${mario}/block`, { token: carla, body: {} })).status).toBe(403)
  })
})

describe('usuarios internos y segundo factor (TOTP)', () => {
  it('login del personal: reto TOTP; 5 códigos malos → 429; el atajo 000000; códigos de recuperación de un solo uso', async () => {
    const first = dataOf((await call<LoginResponse>('/v1/auth/login', { body: { email: 'gestor@drinksonchain.test', password: 'demo1234' } })).json)
    expect(first).toMatchObject({ mfa: { required: true, enrolled: true } })
    expect(first).not.toHaveProperty('tokens')
    const mfaToken = (first as { mfa: { mfaToken: string } }).mfa.mfaToken
    for (let i = 0; i < 4; i++) {
      const bad = await call('/v1/auth/mfa/verify', { body: { mfaToken, code: '123456' } })
      expect(errorOf(bad.json).code).toBe('AUTH_MFA_INVALID_CODE')
    }
    const locked = await call('/v1/auth/mfa/verify', { body: { mfaToken, code: '123456' } })
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBe('300')
    expect(mockMailbox.latest({ to: 'gestor@drinksonchain.test', template: 'MFA_FAILED_ATTEMPTS' })).not.toBeNull()
    expect(errorOf((await call('/v1/auth/mfa/verify', { body: { mfaToken, code: generateTotp(DEMO_TOTP_SECRET) } })).json).code).toBe('AUTH_MFA_TOKEN_INVALID')

    const again = dataOf((await call<{ mfa: { mfaToken: string } }>('/v1/auth/login', { body: { email: 'gestor@drinksonchain.test', password: 'demo1234' } })).json)
    const session = SessionResponseSchema.parse(dataOf((await call('/v1/auth/mfa/verify', { body: { mfaToken: again.mfa.mfaToken, code: MOCK_TOTP_BYPASS_CODE } })).json))
    expect(session.activeOrganizationId).toBe(PLATFORM_ORGANIZATION.id)
    expect((await call('/v1/platform/dashboard', { token: session.tokens.accessToken })).status).toBe(200)

    const recovery = getErpDb().backoffice.mfa.find((m) => m.userId === uid('user:admin'))!.recoveryCodes[0]!
    const third = dataOf((await call<{ mfa: { mfaToken: string } }>('/v1/auth/login', { body: { email: 'gestor@drinksonchain.test', password: 'demo1234' } })).json)
    expect((await call('/v1/auth/mfa/verify', { body: { mfaToken: third.mfa.mfaToken, code: recovery } })).status).toBe(200)
    const fourth = dataOf((await call<{ mfa: { mfaToken: string } }>('/v1/auth/login', { body: { email: 'gestor@drinksonchain.test', password: 'demo1234' } })).json)
    expect((await call('/v1/auth/mfa/verify', { body: { mfaToken: fourth.mfa.mfaToken, code: recovery } })).status).toBe(401)
    // El reto caduca a los 5 minutos del reloj de los mocks
    advanceMockClock(5 * 60_000)
    expect(errorOf((await call('/v1/auth/mfa/verify', { body: { mfaToken: fourth.mfa.mfaToken, code: MOCK_TOTP_BYPASS_CODE } })).json).code).toBe('AUTH_MFA_TOKEN_INVALID')
  })

  it('inscripción: enroll → confirm con el primer código → sesión + 10 códigos de recuperación', async () => {
    const first = dataOf((await call<{ mfa: { mfaToken: string; enrolled: boolean } }>('/v1/auth/login', { body: { email: 'analista@drinksonchain.test', password: 'demo1234' } })).json)
    expect(first.mfa.enrolled).toBe(false)
    expect((await call('/v1/auth/mfa/verify', { body: { mfaToken: first.mfa.mfaToken, code: '000000' } })).status).toBe(409)
    const enroll = dataOf((await call<{ secret: string; otpauthUrl: string }>('/v1/auth/mfa/enroll', { body: { mfaToken: first.mfa.mfaToken } })).json)
    expect(enroll.secret).toBe(DEMO_TOTP_SECRET)
    expect(enroll.otpauthUrl).toContain('analista%40drinksonchain.test')
    const confirmed = dataOf((await call<SessionResponse & { recoveryCodes: string[] }>('/v1/auth/mfa/enroll/confirm', { body: { mfaToken: first.mfa.mfaToken, code: generateTotp(enroll.secret) } })).json)
    expect(confirmed.recoveryCodes).toHaveLength(10)
    expect(confirmed.activeOrganizationId).toBe(PLATFORM_ORGANIZATION.id)
    const users = dataOf((await call<{ items: Array<{ email: string; mfaEnabled: boolean }> }>('/v1/platform/users', { token: await login('administracion@drinksonchain.test') })).json).items
    expect(users.find((u) => u.email === 'analista@drinksonchain.test')!.mfaEnabled).toBe(true)
  })

  it('usuarios internos: invitar, aceptar (con TOTP), cambiar rol, bloquear; el superusuario está protegido', async () => {
    const admin = await login('administracion@drinksonchain.test')
    expect((await call('/v1/platform/users', { token: await login('operaciones@drinksonchain.test') })).status).toBe(403)
    const bad = await call('/v1/platform/users', { token: admin, body: { email: 'x@drinksonchain.test', role: 'SUPERADMIN' } })
    expect(errorOf(bad.json).details![0]!.field).toBe('role')
    expect((await call('/v1/platform/users', { token: admin, body: { email: 'nuevo.soporte@drinksonchain.test', role: 'SUPPORT' } })).status).toBe(201)
    const list = dataOf((await call<{ items: Array<{ email: string; status: string; membershipId: string | null }> }>('/v1/platform/users?status=INVITED', { token: admin })).json).items
    expect(list.map((u) => u.email)).toContain('nuevo.soporte@drinksonchain.test')
    const mail = mockMailbox.latest({ to: 'nuevo.soporte@drinksonchain.test' })!
    expect(mail.link).toMatch(/^http:\/\/localhost:3003\/invitacion\//)
    const accepted = dataOf((await call<LoginResponse>(`/v1/invitations/${mail.token}/accept`, { body: { fullName: 'Nuevo Soporte', password: DEMO_NEW_PASSWORD } })).json)
    expect(accepted).toMatchObject({ mfa: { required: true, enrolled: false } })
    const session = await loginSession('nuevo.soporte@drinksonchain.test', DEMO_NEW_PASSWORD)
    expect(session.memberships[0]).toMatchObject({ organizationType: 'PLATFORM', role: 'SUPPORT' })

    const pabloMembership = uid(`membership:platform:${uid('user:soporte')}`)
    expect(dataOf((await call<{ role: string }>(`/v1/platform/users/${pabloMembership}`, { token: admin, method: 'PATCH', body: { role: 'OPERATIONS', reason: REASON } })).json).role).toBe('OPERATIONS')
    const pablo = await login('soporte@drinksonchain.test')
    expect(dataOf((await call<{ status: string }>(`/v1/platform/users/${pabloMembership}/block`, { token: admin, body: { reason: REASON } })).json).status).toBe('BLOCKED')
    expect(errorOf((await call('/v1/platform/dashboard', { token: pablo })).json).code).toBe('AUTH_SESSION_REVOKED')
    const anaMembership = uid(`membership:platform:${uid('user:admin')}`)
    expect(errorOf((await call(`/v1/platform/users/${anaMembership}/block`, { token: admin, body: { reason: REASON } })).json).code).toBe('PLATFORM_SUPERADMIN_PROTECTED')
    expect(errorOf((await call(`/v1/platform/users/${anaMembership}`, { token: admin, method: 'PATCH', body: { role: 'SUPPORT', reason: REASON } })).json).code).toBe('PLATFORM_SUPERADMIN_PROTECTED')
    // Cuenta completa: ruta propia con el id de persona (§11 bis); /platform/users/{id} solo acepta membresías de plataforma
    const maria = uid('user:maria')
    expect(errorOf((await call(`/v1/platform/users/${maria}/block`, { token: admin, body: { reason: 'Fraude' } })).json).code).toBe('NOT_FOUND')
    expect((await call(`/v1/platform/accounts/${maria}/block`, { token: await login('operaciones@drinksonchain.test'), body: { reason: 'Fraude' } })).status).toBe(403)
    expect(dataOf((await call(`/v1/platform/accounts/${maria}/block`, { token: admin, body: { reason: 'Fraude' } })).json)).toMatchObject({ status: 'BLOCKED', blockedReason: 'Fraude' })
    const blockedLogin = await call('/v1/auth/login', { body: { email: 'maria@tribu.test', password: 'demo1234' } })
    expect(blockedLogin.status).toBe(401)
    expect(errorOf(blockedLogin.json).code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(errorOf((await call(`/v1/platform/accounts/${anaMembership}/block`, { token: admin, body: { reason: REASON } })).json).code).toBe('USER_NOT_FOUND')
    expect(dataOf((await call(`/v1/platform/accounts/${maria}/unblock`, { token: admin, body: { reason: REASON } })).json)).toMatchObject({ status: 'ACTIVE' })
    expect((await call('/v1/auth/login', { body: { email: 'maria@tribu.test', password: 'demo1234' } })).status).toBe(200)
    // Restablecer el TOTP obliga a reinscribirlo
    const valeria = uid(`membership:platform:${uid('user:operaciones')}`)
    expect(dataOf((await call<{ mfaEnabled: boolean }>(`/v1/platform/users/${valeria}/reset-mfa`, { token: admin, body: { reason: 'Cambió de teléfono' } })).json).mfaEnabled).toBe(false)
    const relogin = dataOf((await call<{ mfa: { enrolled: boolean } }>('/v1/auth/login', { body: { email: 'operaciones@drinksonchain.test', password: 'demo1234' } })).json)
    expect(relogin.mfa.enrolled).toBe(false)
    expect(mockMailbox.latest({ to: 'operaciones@drinksonchain.test', template: 'MFA_RESET' })).not.toBeNull()
  })

  it('cambiar a la organización de plataforma sin haber pasado el TOTP → 403 AUTH_MFA_REQUIRED', async () => {
    const carla = await loginSession('enologa@altos.test')
    const admin = await login('administracion@drinksonchain.test')
    await call('/v1/platform/users', { token: admin, body: { email: 'enologa@altos.test', role: 'SUPPORT' } })
    const token = mockMailbox.latest({ to: 'enologa@altos.test' })!.token!
    const accepted = dataOf((await call<LoginResponse>(`/v1/invitations/${token}/accept`, { token: carla.tokens.accessToken, body: {} })).json)
    expect(accepted).toMatchObject({ mfa: { required: true, enrolled: false } })
    const sw = await call('/v1/auth/switch-organization', { token: carla.tokens.accessToken, body: { organizationId: PLATFORM_ORGANIZATION.id } })
    expect(errorOf(sw.json).code).toBe('AUTH_MFA_REQUIRED')
  })
})

describe('cuenta: recuperación y cambio de contraseña', () => {
  it('forgot → enlace del buzón → reset (un solo uso, revoca sesiones); la contraseña vieja deja de valer', async () => {
    const old = await login('admin@altos.test')
    expect((await call('/v1/auth/forgot-password', { body: { email: 'nadie@x.test', captchaToken: 'ok' } })).status).toBe(202)
    expect((await call('/v1/auth/forgot-password', { body: { email: 'admin@altos.test', captchaToken: 'ok' }, headers: ERP })).status).toBe(202)
    const mail = mockMailbox.latest({ to: 'admin@altos.test', template: 'PASSWORD_RESET' })!
    expect(mail.link).toBe(`http://localhost:3002/restablecer-contrasena?token=${mail.token}`)
    expect(errorOf((await call('/v1/auth/reset-password', { body: { token: mail.token, password: '1234567890' } })).json).code).toBe('AUTH_WEAK_PASSWORD')
    expect((await call('/v1/auth/reset-password', { body: { token: mail.token, password: DEMO_NEW_PASSWORD } })).status).toBe(204)
    expect(errorOf((await call('/v1/auth/reset-password', { body: { token: mail.token, password: DEMO_NEW_PASSWORD } })).json)).toMatchObject({
      code: 'AUTH_RESET_TOKEN_INVALID',
      details: [{ field: 'token' }],
    })
    expect(errorOf((await call('/v1/terroirs', { token: old })).json).code).toBe('AUTH_SESSION_REVOKED')
    expect((await call('/v1/auth/login', { body: { email: 'admin@altos.test', password: 'demo1234' } })).status).toBe(401)
    expect((await call('/v1/auth/login', { body: { email: 'admin@altos.test', password: DEMO_NEW_PASSWORD } })).status).toBe(200)
  })

  it('el enlace de recuperación caduca a los 60 minutos del reloj de los mocks', async () => {
    await call('/v1/auth/forgot-password', { body: { email: 'admin@altos.test', captchaToken: 'ok' } })
    const token = mockMailbox.latest({ to: 'admin@altos.test' })!.token!
    advanceMockClock(61 * 60_000)
    expect(errorOf((await call('/v1/auth/reset-password', { body: { token, password: DEMO_NEW_PASSWORD } })).json).code).toBe('AUTH_RESET_TOKEN_INVALID')
  })

  it('cambiar la contraseña exige la actual y revoca las demás sesiones; preferencias de perfil', async () => {
    const a = await loginSession('enologa@altos.test')
    const b = await loginSession('enologa@altos.test')
    const wrong = await call('/v1/users/me/password', { token: a.tokens.accessToken, body: { currentPassword: 'x', newPassword: DEMO_NEW_PASSWORD } })
    expect(errorOf(wrong.json)).toMatchObject({ code: 'AUTH_INVALID_CURRENT_PASSWORD', details: [{ field: 'currentPassword' }] })
    expect((await call('/v1/users/me/password', { token: a.tokens.accessToken, body: { currentPassword: 'demo1234', newPassword: DEMO_NEW_PASSWORD } })).status).toBe(204)
    expect((await call('/v1/users/me', { token: a.tokens.accessToken })).status).toBe(200)
    expect(errorOf((await call('/v1/users/me', { token: b.tokens.accessToken })).json).code).toBe('AUTH_SESSION_REVOKED')
    const patched = await call('/v1/users/me', { token: a.tokens.accessToken, method: 'PATCH', body: { notificationPrefs: { lotProgress: false }, promotionsConsent: true } })
    expect(patched.status).toBe(200)
    expect(dataOf((await call<{ user: Record<string, unknown> }>('/v1/users/me', { token: a.tokens.accessToken })).json).user).toMatchObject({
      notificationPrefs: { lotProgress: false, redemptionReminders: true },
      promotionsConsent: true,
    })
  })
})

describe('configuración en dos niveles', () => {
  it('tipos, límites, nivel, mínimo legal y excepción legal (solo ADMIN, con motivo)', async () => {
    const admin = await login('administracion@drinksonchain.test')
    const put = (url: string, body: unknown, token = admin) => call(url, { token, method: 'PUT', body })
    expect(errorOf((await put('/v1/platform/settings/canje.ventanaDias', { value: 'mucho', reason: REASON })).json)).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'value', message: 'Debe ser un número' }] })
    expect(errorOf((await put('/v1/platform/settings/canje.ventanaDias', { value: 0, reason: REASON })).json).details![0]!.message).toBe('Debe ser mayor o igual que 1')
    expect(errorOf((await put('/v1/platform/settings/canje.ventanaDias', { value: 40 })).json).details![0]!.field).toBe('reason')
    expect(errorOf((await put('/v1/platform/settings/no.existe', { value: 1, reason: REASON })).json).code).toBe('SETTING_NOT_FOUND')
    expect(errorOf((await put('/v1/platform/settings/trazabilidad.singani.reposoMinimoDias', { value: 90, reason: REASON })).json).code).toBe('SETTING_BELOW_LEGAL_MINIMUM')
    expect(errorOf((await put('/v1/platform/settings/trazabilidad.excepcionMinimoLegal', { value: true, reason: REASON })).json).code).toBe('SETTING_LEVEL_NOT_ALLOWED')
    expect(errorOf((await put('/v1/platform/settings/compra.minutosReserva/overrides', { wineryIds: [ALTOS.id], value: 10, reason: REASON })).json).code).toBe('SETTING_LEVEL_NOT_ALLOWED')
    expect((await put('/v1/platform/settings/canje.ventanaDias', { value: 40, reason: REASON }, await login('operaciones@drinksonchain.test'))).status).toBe(403)
    const def = dataOf((await put('/v1/platform/settings/canje.ventanaDias', { value: 40, reason: REASON })).json)
    expect(def).toMatchObject({ key: 'canje.ventanaDias', globalValue: 40, default: 30, updatedBy: 'Jorge Salinas' })
    // Ajuste por bodega bajo el mínimo legal: solo con excepción
    const reposo = '/v1/platform/settings/trazabilidad.singani.reposoMinimoDias/overrides'
    expect(errorOf((await put(reposo, { wineryIds: [CINTI.id], value: 120, reason: REASON })).json).code).toBe('SETTING_BELOW_LEGAL_MINIMUM')
    expect(dataOf((await put(reposo, { wineryIds: [CINTI.id], value: 120, reason: 'Ensayo autorizado', legalException: true })).json)).toEqual({ updated: 1 })
    const overrides = dataOf((await call<{ items: Array<{ wineryId: string; legalException: boolean }> }>(reposo, { token: admin })).json).items
    expect(overrides).toEqual([expect.objectContaining({ wineryId: CINTI.id, legalException: true, value: 120 })])
    expect(errorOf((await put(reposo, { wineryIds: ['no-existe'], value: 200, reason: REASON })).json).details![0]!.field).toBe('wineryIds.0')
    // Masivo y volver al estándar
    expect(dataOf((await put('/v1/platform/settings/puntos.maxPorBodega/overrides', { wineryIds: 'ALL', value: 5, reason: REASON })).json)).toEqual({ updated: 5 })
    expect(dataOf((await call('/v1/platform/settings/puntos.maxPorBodega/overrides/reset', { token: admin, body: { wineryIds: [ALTOS.id], reason: REASON } })).json)).toEqual({ reset: 1 })
    // Valor efectivo para la bodega (solo lectura)
    const effective = dataOf((await call<Array<{ key: string; value: unknown; source: string }>>('/v1/organizations/current/settings', { token: await login('enologa@cintiviejo.test') })).json)
    expect(effective.find((s) => s.key === 'trazabilidad.singani.reposoMinimoDias')).toMatchObject({ value: 120, source: 'WINERY' })
    expect(effective.find((s) => s.key === 'canje.ventanaDias')).toMatchObject({ value: 40, source: 'GLOBAL' })
    expect(effective.find((s) => s.key === 'equipo.maxColaboradoresPorBodega')).toMatchObject({ value: 6, source: 'WINERY' })
    const history = dataOf((await call<{ items: Array<{ scope: string; before: unknown; after: unknown }> }>('/v1/platform/settings/canje.ventanaDias/history', { token: admin })).json).items
    expect(history[0]).toMatchObject({ scope: 'GLOBAL', before: 30, after: 40, reason: REASON })
  })
})

describe('bitácora', () => {
  it('registra cada acción con la app de origen, se consulta con filtros, se exporta y se verifica', async () => {
    const before = getErpDb().backoffice.audit.length
    const ops = await login('operaciones@drinksonchain.test')
    await call(`/v1/platform/wineries/${URIONDO.id}/reactivate`, { token: ops, body: { reason: 'Registro renovado' }, headers: { ...BO, 'X-Correlation-ID': 'corr-1' } })
    const events = getErpDb().backoffice.audit.slice(before)
    expect(events.map((e) => e.action)).toEqual(['AUTH_LOGIN_SUCCEEDED', 'WINERY_REACTIVATED'])
    expect(events[1]).toMatchObject({
      source: { app: 'BACKOFFICE' },
      correlationId: 'corr-1',
      reason: 'Registro renovado',
      organizationId: URIONDO.id,
      before: { status: 'SUSPENDED' },
      after: { status: 'ACTIVE' },
      prevHash: events[0]!.hash,
    })
    // Las escrituras del ERP también dejan rastro
    const enologa = await login('enologa@altos.test')
    await call('/v1/fermentation-tanks', { token: enologa, headers: ERP, body: { harvestBatchId: F.harvestBatches.find((h) => h.wineryId === ALTOS.id)!.id, tankCode: 'TK-B1', startDate: '2026-09-25' } })
    expect(lastAudit('FERMENTATION_TANK_CREATED')).toMatchObject({ source: { app: 'ERP' }, organizationId: ALTOS.id, actor: { role: 'ENOLOGIST' } })

    const support = await login('soporte@drinksonchain.test')
    const page = dataOf((await call<{ items: AuditEvent[]; total: number }>(`/v1/platform/audit?organizationId=${URIONDO.id}&action=WINERY_REACTIVATED`, { token: support })).json)
    expect(page.total).toBe(1)
    const all = dataOf((await call<{ items: AuditEvent[] }>('/v1/platform/audit?limit=5', { token: support })).json).items
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => b - a))
    const csv = await fetch(`${API}/v1/platform/audit/export?from=2026-09-25&action=WINERY_REACTIVATED`, { headers: { Authorization: `Bearer ${support}` } })
    const lines = (await csv.text()).trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('Registro renovado')
    expect((await call('/v1/platform/audit/verify', { token: support })).status).toBe(403)
    const admin = await login('administracion@drinksonchain.test')
    expect(dataOf((await call('/v1/platform/audit/verify', { token: admin })).json)).toMatchObject({ valid: true, firstBrokenSeq: null })
    const victim = getErpDb().backoffice.audit[99]!
    victim.reason = 'alterado'
    expect(dataOf((await call('/v1/platform/audit/verify', { token: admin })).json)).toMatchObject({ valid: false, firstBrokenSeq: victim.seq })
  })

  it('el dueño ve solo lo de su bodega, incluido lo que hizo la plataforma; los demás roles no', async () => {
    const owner = await login('admin@cintiviejo.test')
    const events = dataOf((await call<{ items: AuditEvent[] }>('/v1/organizations/current/audit?limit=100', { token: owner })).json).items
    expect(events.length).toBeGreaterThan(10)
    expect(events.every((e) => e.organizationId === CINTI.id)).toBe(true)
    expect(events.some((e) => e.actor.viaPlatform)).toBe(true)
    expect((await call('/v1/organizations/current/audit', { token: await login('enologa@cintiviejo.test') })).status).toBe(403)
  })

  it('tablero: contadores, alertas y actividad reciente', async () => {
    const dash = dataOf((await call<Record<string, unknown>>('/v1/platform/dashboard', { token: await login('soporte@drinksonchain.test') })).json)
    expect(dash).toMatchObject({
      applications: { unverified: 1, received: 3, inReview: 1, meetingScheduled: 1 },
      wineries: { invited: 2, active: 2, suspended: 1 },
      invitations: { pending: 4, expiringIn24h: 1 },
      team: { blockedMembers: 2 },
    })
    expect((dash.recentAudit as unknown[]).length).toBe(5)
  })
})

describe('escenarios en los dominios de la Ola 1', () => {
  it('empty, error y offline', async () => {
    const support = await login('soporte@drinksonchain.test')
    setScenario('empty')
    expect(dataOf((await call('/v1/platform/wineries', { token: support })).json)).toMatchObject({ items: [], total: 0 })
    setScenario('error')
    expect(errorOf((await call('/v1/platform/dashboard', { token: support })).json).code).toBe('INTERNAL_ERROR')
    setScenario('offline')
    await expect(call('/v1/platform/dashboard', { token: support })).rejects.toThrow()
  })
})

describe('ERP: lo que cambió con la Ola 1 y el backend O0-BE-2', () => {
  it('una cuba pasa una sola vez a crianza → 409 FERMENTATION_TANK_ALREADY_TRANSFERRED', async () => {
    const aging = F.wineAging.find((a) => a.wineryId === ALTOS.id)!
    const res = await call('/v1/wine-aging', { token: staticToken('altos_enologa'), body: { fermentationTankId: aging.fermentationTankId, containerType: 'Barrica', plannedMonths: 6, volumeLiters: 100 } })
    expect(errorOf(res.json).code).toBe('FERMENTATION_TANK_ALREADY_TRANSFERRED')
  })

  it('balance de masa (422 TRC_MASS_BALANCE_EXCEEDED desde la Ola 2) y fuente del embotellado sin crianza ni destilación → 422 VALIDATION_ERROR', async () => {
    // Destilación abierta de «Singani El Molino 2026» (5.800 L de entrada): cortes mayores que la entrada.
    const open = F.productionBatches.find((p) => p.wineryId === CINTI.id && !p.processEndDate)!
    const mass = await call(`/v1/production-batches/${open.id}/close`, {
      token: staticToken('cvj_enologa'),
      body: { processEndDate: '2026-09-25', cuts: { headsLiters: 400, heartLiters: 5000, tailsLiters: 600 }, heartAbvPercent: 60 },
    })
    expect(mass.status).toBe(422)
    expect(errorOf(mass.json)).toMatchObject({ code: 'TRC_MASS_BALANCE_EXCEEDED', details: [{ field: 'cuts', expected: 5800, actual: 6000, meta: { inputLiters: 5800, outputLiters: 6000 } }] })
    const noSource = await call(`/v1/lots/${open.lotId}/bottling`, {
      token: staticToken('cvj_enologa'),
      body: { sources: [{ liters: 10 }], finalAlcoholAbv: 40, totalBottlesPackaged: 10, packagingFormatCl: 75, bottlingDate: '2026-09-25' },
    })
    expect(noSource.status).toBe(422)
    expect(errorOf(noSource.json)).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'sources.0.wineAgingBatchId' }] })
  })

  it('Idempotency-Key en los POST de alta: repetición, otro cuerpo y clave inválida', async () => {
    const token = staticToken('altos_agronomo')
    const key = '6f2d2a55-3f0e-4c2e-9d6b-2d7a2b1e9c01'
    const body = { parcelName: 'Cuartel 9', surfaceHectares: 1.2, altitudeMasl: 1900, rawMaterialType: 'uva', varietyName: 'Tannat' }
    const first = await call<{ id: string }>('/v1/terroirs', { token, body, headers: { 'Idempotency-Key': key } })
    const second = await call<{ id: string }>('/v1/terroirs', { token, body, headers: { 'Idempotency-Key': key } })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers.get('idempotent-replayed')).toBe('true')
    expect(dataOf(second.json).id).toBe(dataOf(first.json).id)
    expect(getErpDb().terroirs.filter((t) => t.parcelName === 'Cuartel 9')).toHaveLength(1)
    const other = await call('/v1/terroirs', { token, body: { ...body, parcelName: 'Otro' }, headers: { 'Idempotency-Key': key } })
    expect(errorOf(other.json).code).toBe('IDEMPOTENCY_KEY_REUSED')
    const invalid = await call('/v1/terroirs', { token, body, headers: { 'Idempotency-Key': 'no-uuid' } })
    expect(errorOf(invalid.json)).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID', details: [{ field: 'Idempotency-Key' }] })
  })

  it('mensajes de validación en español', async () => {
    const res = await call('/v1/auth/login', { body: { email: 'no-es-correo' } })
    expect(errorOf(res.json).details).toEqual([
      { field: 'email', message: 'El correo no es válido' },
      { field: 'password', message: 'Campo obligatorio' },
    ])
  })
})
