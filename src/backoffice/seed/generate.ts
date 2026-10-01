import { PLATFORM_ORGANIZATION } from '../../erp/catalog'
import type { ErpFixtureSet } from '../../erp/seed/generate'
import type { MembershipRole, MockUser, WineryResponse } from '../../erp/schemas'
import { day, isoAt } from '../../shared/dates'
import { sha256Hex } from '../../shared/crypto'
import { DEMO_TOTP_SECRET } from '../../shared/totp'
import { uid } from '../../shared/uuid'
import {
  applicationVerifyMail,
  DEFAULT_APP_URLS,
  invitationMail,
  renderEmail,
  simpleMail,
  type MailDraft,
} from '../mail'
import {
  buildWineryDetail,
  chainAuditEvent,
  effectiveInvitationStatus,
  type AuditInput,
  type MemberBlock,
  type StaffMfa,
  type StoredApplication,
  type StoredInvitation,
  type StoredOverride,
  type StoredSetting,
  type StoredSettingHistory,
  type WineryProfile,
} from '../model'
import type { ApplicationNote, AuditEvent, ClientApp, DashboardAlert, MockEmail, WaitlistEntry, WineryDetail, WineryStatusChange } from '../schemas'
import { SETTINGS_CATALOG } from '../settings-catalog'
import { generateWaitlistFixtures } from './waitlist'

// Generador determinista de los fixtures de la Ola 1 (`fixtures/backoffice/*.json`). Solo en
// TypeScript: la referencia de Python cubre el ERP; estos datos se validan con las pruebas de
// test/backoffice-*.test.ts. Parte de los fixtures del ERP (mismas bodegas, personas y fechas) y
// narra en la bitácora encadenada los hechos de ambos. Reloj de referencia: 2026-09-25 12:00 UTC.

export const REFERENCE_NOW = '2026-09-25T12:00:00Z'

/** Nombre de archivo → contenido. */
export interface BackofficeFixtureSet {
  'applications.json': StoredApplication[]
  'invitations.json': StoredInvitation[]
  'winery-profiles.json': WineryProfile[]
  'winery-details.json': WineryDetail[]
  'member-blocks.json': MemberBlock[]
  'staff-mfa.json': StaffMfa[]
  'settings.json': StoredSetting[]
  'setting-overrides.json': StoredOverride[]
  'setting-history.json': StoredSettingHistory[]
  'alerts.json': DashboardAlert[]
  'audit.json': AuditEvent[]
  'mailbox.json': MockEmail[]
  /** Lista de espera (contrato O1b), más recientes primero. */
  'waitlist.json': WaitlistEntry[]
}
export type BackofficeFixtureName = keyof BackofficeFixtureSet

/** `YYYY-MM-DDTHH:MM:00Z`. */
const at = (y: number, m: number, d: number, h = 12, min = 0) => isoAt(day(y, m, d), h, min)
const addHours = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** 10 códigos de recuperación deterministas (`XXXX-XXXX`). */
export function recoveryCodesFor(seed: string): string[] {
  return Array.from({ length: 10 }, (_, i) => {
    const h = sha256Hex(`recovery:${seed}:${i}`).slice(0, 8).toUpperCase()
    return `${h.slice(0, 4)}-${h.slice(4)}`
  })
}

/** Historia pública de las bodegas de la red (la misma del sitio de bodegas). */
const PUBLIC_STORIES: Record<string, string> = {
  altos:
    'Bodega familiar en las lomas de Santa Ana, con viñedos en Santa Ana la Nueva y Calamuchita. Registra cada lote en el ERP desde la vendimia.',
  cintiviejo:
    'Destilería del cañón de Cinti, con parrales de Moscatel de Alejandría en Camargo y Palca Grande. Singani de Denominación de Origen y un vino patrimonial de cepas criollas.',
  guadalquivir:
    'Viñedos junto al río en el Valle de la Concepción y La Angostura. Está preparando su ingreso a la red: sus lotes aún no se registran en el ERP.',
  uriondo:
    'Destilería de referencia del distrito de Colón. Aparece en el mapa por contexto histórico; no tiene relación comercial con la red.',
}

const SLUGS: Record<string, string> = {
  altos: 'altos-de-calamuchita',
  cintiviejo: 'destileria-cinti-viejo',
  guadalquivir: 'vinedos-del-guadalquivir',
  uriondo: 'casa-uriondo',
  padcaya: 'sol-de-padcaya',
  valle: 'valle-escondido',
}

export function generateBackofficeFixtures(erp: ErpFixtureSet): BackofficeFixtureSet {
  const wineries = erp['wineries.json']
  const users = erp['users.json']
  const U = (key: string): MockUser => {
    const u = users.find((x) => x._mock.key === key)
    if (!u) throw new Error(`Usuario de los fixtures desconocido: ${key}`)
    return u
  }
  const W = (key: string): WineryResponse => {
    const w = wineries.find((x) => x.id === uid(`winery:${key}`))
    if (!w) throw new Error(`Bodega de los fixtures desconocida: ${key}`)
    return w
  }
  const memberId = (userKey: string, wineryKey: string) =>
    W(wineryKey).members!.find((m) => m.userId === U(userKey).id)!.id
  const platformMembershipId = (userKey: string) => uid(`membership:platform:${U(userKey).id}`)

  // ---------------------------------------------------------------------------
  // Bitácora: se acumulan los hechos y al final se ordenan y encadenan.
  // ---------------------------------------------------------------------------
  type Pending = AuditInput & { order: number }
  const facts: Pending[] = []
  const IP: Record<ClientApp, string | null> = {
    BACKOFFICE: '203.0.113.10',
    ERP: '198.51.100.24',
    PUBLIC: '192.0.2.77',
    MARKETPLACE: null,
    POS: null,
    API: null,
    WORKER: null,
  }
  const system = { userId: null, fullName: null, role: null, organizationId: null, viaPlatform: false }
  const staff = (key: string) => {
    const u = U(key)
    return { userId: u.id, fullName: u.fullName, role: u._mock.platformRole ?? 'SUPERADMIN', organizationId: PLATFORM_ORGANIZATION.id, viaPlatform: true }
  }
  const member = (key: string, wineryKey: string, role: MembershipRole) => {
    const u = U(key)
    return { userId: u.id, fullName: u.fullName, role, organizationId: W(wineryKey).id, viaPlatform: false }
  }
  const publicActor = system
  function fact(
    occurredAt: string,
    actor: AuditInput['actor'],
    app: ClientApp,
    action: string,
    resource: AuditInput['resource'],
    organizationId: string | null,
    extra: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; reason?: string | null } = {},
  ) {
    facts.push({
      occurredAt,
      actor,
      source: { app, ip: IP[app], deviceId: null },
      action,
      resource,
      organizationId,
      before: extra.before ?? null,
      after: extra.after ?? null,
      reason: extra.reason ?? null,
      correlationId: null,
      order: facts.length,
    })
  }

  const mails: Array<{ at: string; draft: MailDraft }> = []

  // ---------------------------------------------------------------------------
  // Personal de plataforma y segundo factor
  // ---------------------------------------------------------------------------
  const staffKeys = ['admin', 'bo_admin', 'operaciones', 'soporte', 'analista']
  const staffMfa: StaffMfa[] = staffKeys.map((key) => {
    const enrolled = key !== 'analista'
    const u = U(key)
    return {
      userId: u.id,
      enrolled,
      secret: enrolled ? DEMO_TOTP_SECRET : null,
      enrolledAt: enrolled ? addHours(u.createdAt, 0.25) : null,
      recoveryCodes: enrolled ? recoveryCodesFor(key) : [],
    }
  })
  fact(U('admin').createdAt, system, 'WORKER', 'PLATFORM_SUPERADMIN_SEEDED', { type: 'user', id: U('admin').id }, PLATFORM_ORGANIZATION.id, {
    after: { email: U('admin').email, role: 'SUPERADMIN' },
  })
  for (const key of ['bo_admin', 'operaciones', 'soporte']) {
    const u = U(key)
    fact(u.createdAt, staff(key), 'BACKOFFICE', 'MEMBER_JOINED', { type: 'membership', id: platformMembershipId(key) }, PLATFORM_ORGANIZATION.id, {
      after: { role: u._mock.platformRole ?? null },
    })
  }
  for (const m of staffMfa.filter((x) => x.enrolled)) {
    const key = users.find((u) => u.id === m.userId)!._mock.key
    fact(m.enrolledAt!, staff(key), 'BACKOFFICE', 'MFA_ENROLLED', { type: 'user', id: m.userId }, PLATFORM_ORGANIZATION.id)
  }
  for (const key of ['admin', 'soporte', 'bo_admin', 'operaciones']) {
    fact(U(key).lastLoginAt!, staff(key), 'BACKOFFICE', 'AUTH_LOGIN_SUCCEEDED', { type: 'user', id: U(key).id }, PLATFORM_ORGANIZATION.id, {
      after: { mfa: true },
    })
  }

  // ---------------------------------------------------------------------------
  // Invitaciones
  // ---------------------------------------------------------------------------
  const invitations: StoredInvitation[] = []
  function invite(p: {
    key: string
    token: string
    email: string
    wineryKey: string | null
    role: MembershipRole
    byKey: string
    viaPlatform: boolean
    createdAt: string
    inviteeName?: string | null
    acceptedAt?: string | null
    revokedAt?: string | null
    reason?: string | null
  }): StoredInvitation {
    const org = p.wineryKey ? W(p.wineryKey) : null
    const by = U(p.byKey)
    const createdAt = p.createdAt
    const expiresAt = addHours(createdAt, 72)
    const inv: StoredInvitation = {
      id: uid(`invitation:${p.key}`),
      email: p.email,
      organizationId: org?.id ?? PLATFORM_ORGANIZATION.id,
      organizationType: org ? 'WINERY' : 'PLATFORM',
      organizationName: org?.commercialName ?? PLATFORM_ORGANIZATION.name,
      role: p.role,
      status: p.acceptedAt ? 'ACCEPTED' : p.revokedAt ? 'REVOKED' : 'PENDING',
      expiresAt,
      createdAt,
      invitedBy: { userId: by.id, fullName: by.fullName, viaPlatform: p.viaPlatform },
      _mock: {
        token: p.token,
        inviteeName: p.inviteeName ?? null,
        transfer: null,
        acceptedAt: p.acceptedAt ?? null,
        revokedAt: p.revokedAt ?? null,
      },
    }
    inv.status = effectiveInvitationStatus(inv, REFERENCE_NOW)
    invitations.push(inv)
    const actor = org && !p.viaPlatform ? member(p.byKey, p.wineryKey!, 'OWNER') : staff(p.byKey)
    const app: ClientApp = org && !p.viaPlatform ? 'ERP' : 'BACKOFFICE'
    fact(createdAt, actor, app, 'INVITATION_CREATED', { type: 'invitation', id: inv.id }, inv.organizationId, {
      after: { email: inv.email, role: inv.role, expiresAt },
      reason: p.reason ?? null,
    })
    mails.push({
      at: createdAt,
      draft: invitationMail({
        to: inv.email,
        token: inv._mock.token,
        organizationName: inv.organizationName,
        organizationType: inv.organizationType,
        role: inv.role,
        invitedByName: by.fullName,
        expiresAt,
      }),
    })
    if (inv.status === 'EXPIRED') {
      fact(expiresAt, system, 'WORKER', 'INVITATION_EXPIRED', { type: 'invitation', id: inv.id }, inv.organizationId)
    }
    if (p.revokedAt) {
      fact(p.revokedAt, actor, app, 'INVITATION_REVOKED', { type: 'invitation', id: inv.id }, inv.organizationId, {
        before: { status: 'PENDING' },
        after: { status: 'REVOKED' },
      })
    }
    return inv
  }

  // INV-1 · Camila (operaciones) aceptó; aún no inscribió el TOTP.
  const invCamila = invite({
    key: 'analista',
    token: 'demo-invitacion-analista',
    email: U('analista').email,
    wineryKey: null,
    role: 'OPERATIONS',
    byKey: 'bo_admin',
    viaPlatform: true,
    createdAt: at(2026, 9, 20, 10),
    acceptedAt: at(2026, 9, 22, 9),
    reason: 'Refuerzo de operaciones para la temporada de altas',
  })
  fact(at(2026, 9, 22, 9), staff('analista'), 'BACKOFFICE', 'INVITATION_ACCEPTED', { type: 'invitation', id: invCamila.id }, PLATFORM_ORGANIZATION.id)
  fact(at(2026, 9, 22, 9), staff('analista'), 'BACKOFFICE', 'MEMBER_JOINED', { type: 'membership', id: platformMembershipId('analista') }, PLATFORM_ORGANIZATION.id, {
    after: { role: 'OPERATIONS' },
  })
  // INV-2 · usuario interno pendiente.
  invite({
    key: 'soporte2',
    token: 'demo-invitacion-soporte',
    email: 'soporte2@drinksonchain.test',
    wineryKey: null,
    role: 'SUPPORT',
    byKey: 'bo_admin',
    viaPlatform: true,
    createdAt: at(2026, 9, 24, 10),
  })

  // ---------------------------------------------------------------------------
  // Solicitudes de alta
  // ---------------------------------------------------------------------------
  const applications: StoredApplication[] = []
  const valeria = U('operaciones')
  interface AppSpec {
    key: string
    legalName: string
    tradeName: string
    taxId: string
    category: StoredApplication['category']
    region: string
    contactName: string
    contactEmail: string
    contactPhone: string | null
    message: string | null
    createdAt: string
    verifiedAt?: string
    takenAt?: string
    notes?: Array<[string, string]>
    meeting?: { scheduledOn: string; scheduledAt: string; channel: 'CALL' | 'VIDEO' | 'IN_PERSON'; notes: string | null; doneAt?: string; doneNotes?: string }
    decision?: { at: string; kind: 'APPROVED' | 'REJECTED'; reason: string | null; wineryKey?: string }
    verifyToken?: string
  }
  function application(s: AppSpec): StoredApplication {
    const id = uid(`application:${s.key}`)
    const notes: ApplicationNote[] = []
    let status: StoredApplication['status'] = 'UNVERIFIED'
    let updatedAt = s.createdAt
    fact(s.createdAt, publicActor, 'PUBLIC', 'WINERY_APPLICATION_SUBMITTED', { type: 'winery_application', id }, null, {
      after: { tradeName: s.tradeName, taxId: s.taxId, contactEmail: s.contactEmail },
    })
    if (s.verifiedAt) {
      status = 'RECEIVED'
      updatedAt = s.verifiedAt
      fact(s.verifiedAt, publicActor, 'PUBLIC', 'WINERY_APPLICATION_VERIFIED', { type: 'winery_application', id }, null, {
        before: { status: 'UNVERIFIED' },
        after: { status: 'RECEIVED' },
      })
    } else {
      mails.push({ at: s.createdAt, draft: applicationVerifyMail({ to: s.contactEmail, token: s.verifyToken!, tradeName: s.tradeName }) })
    }
    if (s.takenAt) {
      status = 'IN_REVIEW'
      updatedAt = s.takenAt
      fact(s.takenAt, staff('operaciones'), 'BACKOFFICE', 'WINERY_APPLICATION_TAKEN', { type: 'winery_application', id }, null, {
        before: { status: 'RECEIVED', assigneeId: null },
        after: { status: 'IN_REVIEW', assigneeId: valeria.id },
      })
    }
    for (const [noteAt, text] of s.notes ?? []) {
      const note: ApplicationNote = { id: uid(`note:${s.key}:${notes.length + 1}`), text, by: valeria.fullName, at: noteAt }
      notes.push(note)
      updatedAt = noteAt > updatedAt ? noteAt : updatedAt
      fact(noteAt, staff('operaciones'), 'BACKOFFICE', 'WINERY_APPLICATION_NOTE_ADDED', { type: 'winery_application', id }, null, {
        after: { noteId: note.id },
      })
    }
    let meeting: StoredApplication['meeting'] = null
    if (s.meeting) {
      status = 'MEETING_SCHEDULED'
      updatedAt = s.meeting.scheduledOn
      meeting = { scheduledAt: s.meeting.scheduledAt, channel: s.meeting.channel, notes: s.meeting.notes }
      fact(s.meeting.scheduledOn, staff('operaciones'), 'BACKOFFICE', 'WINERY_APPLICATION_MEETING_SCHEDULED', { type: 'winery_application', id }, null, {
        before: { status: 'IN_REVIEW' },
        after: { status: 'MEETING_SCHEDULED', scheduledAt: s.meeting.scheduledAt, channel: s.meeting.channel },
      })
      if (s.meeting.doneAt) {
        status = 'IN_REVIEW'
        updatedAt = s.meeting.doneAt
        meeting = { ...meeting, notes: s.meeting.doneNotes ?? meeting.notes }
        notes.push({ id: uid(`note:${s.key}:${notes.length + 1}`), text: s.meeting.doneNotes!, by: valeria.fullName, at: s.meeting.doneAt })
        fact(s.meeting.doneAt, staff('operaciones'), 'BACKOFFICE', 'WINERY_APPLICATION_MEETING_DONE', { type: 'winery_application', id }, null, {
          before: { status: 'MEETING_SCHEDULED' },
          after: { status: 'IN_REVIEW' },
        })
      }
    }
    let decision: StoredApplication['decision'] = null
    let wineryId: string | null = null
    if (s.decision) {
      status = s.decision.kind
      updatedAt = s.decision.at
      decision = { by: valeria.fullName, at: s.decision.at, reason: s.decision.reason }
      wineryId = s.decision.wineryKey ? W(s.decision.wineryKey).id : null
      fact(
        s.decision.at,
        staff('operaciones'),
        'BACKOFFICE',
        s.decision.kind === 'APPROVED' ? 'WINERY_APPLICATION_APPROVED' : 'WINERY_APPLICATION_REJECTED',
        { type: 'winery_application', id },
        wineryId,
        { before: { status: 'IN_REVIEW' }, after: { status: s.decision.kind, wineryId }, reason: s.decision.reason },
      )
      mails.push({
        at: s.decision.at,
        draft:
          s.decision.kind === 'APPROVED'
            ? simpleMail(s.contactEmail, 'APPLICATION_APPROVED', `${s.tradeName} fue aprobada en Drinks on Chain`, [
                `La solicitud de ${s.tradeName} fue aprobada.`,
                'La persona titular recibirá una invitación para activar la cuenta de la bodega.',
              ])
            : simpleMail(s.contactEmail, 'APPLICATION_REJECTED', `Sobre la solicitud de ${s.tradeName}`, [
                `Revisamos la solicitud de ${s.tradeName} y por ahora no podemos aprobarla.`,
                `Motivo: ${s.decision.reason ?? ''}`,
              ]),
      })
    }
    const app: StoredApplication = {
      id,
      status,
      createdAt: s.createdAt,
      updatedAt,
      legalName: s.legalName,
      tradeName: s.tradeName,
      taxId: s.taxId,
      category: s.category,
      region: s.region,
      contactName: s.contactName,
      contactEmail: s.contactEmail,
      contactPhone: s.contactPhone,
      message: s.message,
      assignee: s.takenAt ? { userId: valeria.id, fullName: valeria.fullName } : null,
      meeting,
      decision,
      wineryId,
      notes,
      _mock: { verifyToken: s.verifiedAt ? null : (s.verifyToken ?? null) },
    }
    applications.push(app)
    return app
  }

  application({
    key: 'alto-camargo',
    legalName: 'Viñas del Alto Camargo S.R.L.',
    tradeName: 'Viñas del Alto Camargo',
    taxId: '7011002233',
    category: 'WINERY',
    region: 'Valle de Cinti · Camargo',
    contactName: 'Rodrigo Aguilar',
    contactEmail: 'rodrigo@altocamargo.test',
    contactPhone: '+59172110022',
    message: 'Somos cuatro familias con parrales en Camargo y queremos registrar nuestros lotes.',
    createdAt: at(2026, 9, 25, 8, 40),
    verifyToken: 'demo-verificacion-alto-camargo',
  })
  application({
    key: 'andina',
    legalName: 'Cervecería Andina de Altura S.R.L.',
    tradeName: 'Cervecería Andina de Altura',
    taxId: '7022113344',
    category: 'BREWERY',
    region: 'Valle Central de Tarija · Cercado',
    contactName: 'Lucía Gareca',
    contactEmail: 'lucia@andinadealtura.test',
    contactPhone: '+59172113344',
    message: 'Cerveza artesanal con cebada de altura; nos interesa el pasaporte público.',
    createdAt: at(2026, 9, 23, 15, 10),
    verifiedAt: at(2026, 9, 23, 15, 25),
  })
  application({
    key: 'rio-pilaya',
    legalName: 'Destilería Río Pilaya Ltda.',
    tradeName: 'Destilería Río Pilaya',
    taxId: '7033224455',
    category: 'DISTILLERY',
    region: 'Valle de Cinti · Villa Abecia',
    contactName: 'Ernesto Cruz',
    contactEmail: 'ernesto@riopilaya.test',
    contactPhone: null,
    message: null,
    createdAt: at(2026, 9, 24, 10, 5),
    verifiedAt: at(2026, 9, 24, 10, 20),
  })
  application({
    key: 'chocloca',
    legalName: 'Vinos Artesanales Chocloca S.R.L.',
    tradeName: 'Vinos Artesanales Chocloca',
    taxId: '7099887711',
    category: 'WINERY',
    region: 'Valle Central de Tarija · Chocloca',
    contactName: 'Ana María Tolaba',
    contactEmail: 'anamaria@chocloca.test',
    contactPhone: '+59172998877',
    message: 'Elaboramos vino patero y un moscatel; queremos formalizar la trazabilidad.',
    createdAt: at(2026, 9, 25, 7, 15),
    verifiedAt: at(2026, 9, 25, 7, 20),
  })
  application({
    key: 'tierra-cintis',
    legalName: 'Tierra de Cintis S.A.',
    tradeName: 'Bodega Tierra de Cintis',
    taxId: '7044335566',
    category: 'WINERY',
    region: 'Valle de Cinti · Camargo',
    contactName: 'Patricia Llanos',
    contactEmail: 'patricia@tierradecintis.test',
    contactPhone: '+59172335566',
    message: 'Bodega con 12 ha de viñedo propio y una destilería en construcción.',
    createdAt: at(2026, 9, 15, 11),
    verifiedAt: at(2026, 9, 15, 11, 10),
    takenAt: at(2026, 9, 16, 9),
    notes: [
      [at(2026, 9, 16, 9, 30), 'Pedí copia del registro SENASAG y del padrón de viñedos.'],
      [at(2026, 9, 22, 16), 'Enviaron el registro SENASAG; falta el padrón de la parcela de Palca Grande.'],
    ],
  })
  application({
    key: 'angostura',
    legalName: 'Viñedos La Angostura S.R.L.',
    tradeName: 'Viñedos La Angostura',
    taxId: '7055446677',
    category: 'WINERY',
    region: 'Valle Central de Tarija · La Angostura',
    contactName: 'Marcelo Vidaurre',
    contactEmail: 'marcelo@laangostura.test',
    contactPhone: '+59172446677',
    message: 'Queremos entender cómo funciona la preventa antes de sumarnos.',
    createdAt: at(2026, 9, 10, 17),
    verifiedAt: at(2026, 9, 10, 17, 5),
    takenAt: at(2026, 9, 11, 9),
    notes: [[at(2026, 9, 11, 9, 20), 'Primera llamada: interés en la preventa; proponen una reunión con el socio enólogo.']],
    meeting: { scheduledOn: at(2026, 9, 19, 10), scheduledAt: at(2026, 9, 29, 15), channel: 'VIDEO', notes: 'Con Marcelo y su enólogo; revisar el flujo de preventa.' },
  })
  application({
    key: 'guadalquivir',
    legalName: 'Viñedos del Guadalquivir S.R.L.',
    tradeName: 'Viñedos del Guadalquivir',
    taxId: '3011223344',
    category: 'WINERY',
    region: 'Valle Central de Tarija · Concepción',
    contactName: 'Elena Vaca',
    contactEmail: 'gerencia@guadalquivir.test',
    contactPhone: '+59171223344',
    message: 'Queremos registrar la próxima vendimia de Syrah en la red.',
    createdAt: at(2026, 9, 8, 10),
    verifiedAt: at(2026, 9, 8, 10, 10),
    takenAt: at(2026, 9, 9, 9),
    meeting: {
      scheduledOn: at(2026, 9, 9, 9, 30),
      scheduledAt: at(2026, 9, 12, 15),
      channel: 'IN_PERSON',
      notes: 'Visita a la finca El Rancho.',
      doneAt: at(2026, 9, 12, 18),
      doneNotes: 'Visitamos la finca: parcela de Syrah a 1.790 msnm, bodega en obras. Recomiendo aprobar.',
    },
    decision: { at: at(2026, 9, 18, 9), kind: 'APPROVED', reason: null, wineryKey: 'guadalquivir' },
  })
  application({
    key: 'padcaya',
    legalName: 'Sol de Padcaya S.R.L.',
    tradeName: 'Bodega Sol de Padcaya',
    taxId: '5044332211',
    category: 'WINERY',
    region: 'Valle Central de Tarija · Padcaya',
    contactName: 'Gabriela Ríos',
    contactEmail: 'duena@soldepadcaya.test',
    contactPhone: '+59172554433',
    message: 'Bodega joven en Padcaya; primera vendimia registrada en 2026.',
    createdAt: at(2026, 9, 20, 12),
    verifiedAt: at(2026, 9, 20, 12, 5),
    takenAt: at(2026, 9, 21, 9),
    notes: [[at(2026, 9, 23, 11), 'Documentación completa. Aprobar y dar de alta con Gabriela como dueña.']],
    decision: { at: at(2026, 9, 24, 9), kind: 'APPROVED', reason: 'Documentación completa', wineryKey: 'padcaya' },
  })
  application({
    key: 'chaco',
    legalName: 'Licores del Chaco S.R.L.',
    tradeName: 'Licores del Chaco',
    taxId: '7066557788',
    category: 'OTHER',
    region: 'Chaco · Villa Montes',
    contactName: 'Iván Suárez',
    contactEmail: 'ivan@licoresdelchaco.test',
    contactPhone: '+59172557788',
    message: 'Distribuimos licores en el Chaco y queremos vender en el Marketplace.',
    createdAt: at(2026, 9, 5, 14),
    verifiedAt: at(2026, 9, 5, 14, 3),
    takenAt: at(2026, 9, 6, 9),
    decision: {
      at: at(2026, 9, 8, 11),
      kind: 'REJECTED',
      reason: 'No elabora a partir de materia prima propia: distribuye licores de terceros.',
    },
  })

  // ---------------------------------------------------------------------------
  // Bodegas: perfil de la Ola 1 e historial de estado
  // ---------------------------------------------------------------------------
  const SYSTEM = 'Sistema'
  const history: Record<string, WineryStatusChange[]> = {
    altos: [
      { status: 'INVITED', at: W('altos').createdAt, by: SYSTEM, reason: 'Alta anterior a la Ola 1' },
      { status: 'ACTIVE', at: W('altos').approvedAt!, by: SYSTEM, reason: null },
    ],
    cintiviejo: [
      { status: 'INVITED', at: W('cintiviejo').createdAt, by: SYSTEM, reason: 'Alta anterior a la Ola 1' },
      { status: 'ACTIVE', at: W('cintiviejo').approvedAt!, by: SYSTEM, reason: null },
    ],
    guadalquivir: [{ status: 'INVITED', at: at(2026, 9, 18, 9), by: valeria.fullName, reason: 'Solicitud aprobada' }],
    uriondo: [
      { status: 'INVITED', at: W('uriondo').createdAt, by: SYSTEM, reason: 'Alta anterior a la Ola 1' },
      { status: 'ACTIVE', at: W('uriondo').approvedAt!, by: SYSTEM, reason: null },
      {
        status: 'SUSPENDED',
        at: at(2026, 8, 20, 10),
        by: U('bo_admin').fullName,
        reason: 'Registro SENASAG vencido; se reactiva al presentar la renovación.',
      },
    ],
    padcaya: [{ status: 'INVITED', at: at(2026, 9, 24, 9), by: valeria.fullName, reason: 'Documentación completa' }],
    valle: [
      { status: 'INVITED', at: W('valle').createdAt, by: SYSTEM, reason: 'Alta anterior a la Ola 1' },
      { status: 'ACTIVE', at: W('valle').approvedAt!, by: U('valle_admin').fullName, reason: null },
      { status: 'REVOKED', at: at(2026, 8, 14, 10), by: U('admin').fullName, reason: 'Cierre de la bodega solicitado por su titular.' },
    ],
  }
  const LOT_PREFIX: Record<string, string | null> = { altos: 'ALT', cintiviejo: 'CVJ', guadalquivir: null, uriondo: 'CUR', padcaya: null, valle: 'VES' }
  const WEBSITES: Record<string, string | null> = { altos: 'https://altos.test', cintiviejo: 'https://cintiviejo.test' }
  const wineryKeys = ['altos', 'cintiviejo', 'guadalquivir', 'uriondo', 'padcaya', 'valle']
  const profiles: WineryProfile[] = wineryKeys.map((key) => {
    const hist = history[key]!
    return {
      wineryId: W(key).id,
      slug: SLUGS[key]!,
      lotPrefix: LOT_PREFIX[key] ?? null,
      publicStory: PUBLIC_STORIES[key] ?? null,
      website: WEBSITES[key] ?? null,
      activatedAt: hist.find((h) => h.status === 'ACTIVE')?.at ?? null,
      statusHistory: hist,
    }
  })
  const ACTION_BY_STATUS = { INVITED: 'WINERY_CREATED', ACTIVE: 'WINERY_ACTIVATED', SUSPENDED: 'WINERY_SUSPENDED', REVOKED: 'WINERY_REVOKED' } as const
  const actorForHistory = (by: string) => {
    const person = users.find((u) => u.fullName === by)
    if (!person) return { actor: system, app: 'API' as ClientApp }
    if (person._mock.platformRole) return { actor: staff(person._mock.key), app: 'BACKOFFICE' as ClientApp }
    return { actor: { userId: person.id, fullName: person.fullName, role: 'OWNER', organizationId: null, viaPlatform: false }, app: 'ERP' as ClientApp }
  }
  for (const key of wineryKeys) {
    let previous: string | null = null
    for (const h of history[key]!) {
      const { actor, app } = actorForHistory(h.by)
      fact(h.at, actor.userId && !actor.viaPlatform ? { ...actor, organizationId: W(key).id } : actor, app, ACTION_BY_STATUS[h.status], { type: 'winery', id: W(key).id }, W(key).id, {
        before: previous ? { status: previous } : null,
        after: { status: h.status, ...(h.status === 'ACTIVE' && LOT_PREFIX[key] ? { lotPrefix: LOT_PREFIX[key] } : {}) },
        reason: h.reason,
      })
      previous = h.status
    }
  }

  // Invitaciones de dueño y de colaboradores.
  const invGuadalquivir = invite({
    key: 'guadalquivir-owner',
    token: 'demo-invitacion-guadalquivir',
    email: 'gerencia@guadalquivir.test',
    wineryKey: 'guadalquivir',
    role: 'OWNER',
    byKey: 'operaciones',
    viaPlatform: true,
    createdAt: at(2026, 9, 18, 9),
    inviteeName: 'Elena Vaca',
    reason: 'Solicitud aprobada',
  })
  invite({
    key: 'padcaya-owner',
    token: 'demo-invitacion-padcaya',
    email: 'duena@soldepadcaya.test',
    wineryKey: 'padcaya',
    role: 'OWNER',
    byKey: 'operaciones',
    viaPlatform: true,
    createdAt: at(2026, 9, 24, 9),
    inviteeName: 'Gabriela Ríos',
    reason: 'Documentación completa',
  })
  invite({
    key: 'altos-enologo',
    token: 'demo-invitacion-altos-enologo',
    email: 'enologo.junior@altos.test',
    wineryKey: 'altos',
    role: 'ENOLOGIST',
    byKey: 'altos_admin',
    viaPlatform: false,
    createdAt: at(2026, 9, 23, 11),
  })
  invite({
    key: 'altos-practicante',
    token: 'demo-invitacion-altos-practicante',
    email: 'practicante@altos.test',
    wineryKey: 'altos',
    role: 'AGRONOMIST',
    byKey: 'altos_admin',
    viaPlatform: false,
    createdAt: at(2026, 9, 10, 10),
    revokedAt: at(2026, 9, 11, 9),
  })
  const invContable = invite({
    key: 'cintiviejo-contable',
    token: 'demo-invitacion-cintiviejo-contable',
    email: 'contabilidad@cintiviejo.test',
    wineryKey: 'cintiviejo',
    role: 'ACCOUNTANT',
    byKey: 'cvj_admin',
    viaPlatform: false,
    createdAt: at(2026, 5, 18, 10),
    acceptedAt: W('cintiviejo').members!.find((m) => m.userId === U('cvj_contable').id)!.joinedAt,
  })
  fact(invContable._mock.acceptedAt!, member('cvj_contable', 'cintiviejo', 'ACCOUNTANT'), 'ERP', 'INVITATION_ACCEPTED', { type: 'invitation', id: invContable.id }, W('cintiviejo').id)
  invite({
    key: 'cintiviejo-operario',
    token: 'demo-invitacion-cintiviejo-operario',
    email: 'bodeguero@cintiviejo.test',
    wineryKey: 'cintiviejo',
    role: 'OPERATOR',
    byKey: 'soporte',
    viaPlatform: true,
    createdAt: at(2026, 9, 25, 9),
    reason: 'Pedido de la dueña por el canal de soporte',
  })
  void invGuadalquivir

  // Miembros de bodega: alta de cada membresía.
  for (const w of wineries) {
    const wineryKey = wineryKeys.find((k) => W(k).id === w.id)!
    for (const m of w.members ?? []) {
      const key = users.find((u) => u.id === m.userId)!._mock.key
      fact(m.joinedAt, member(key, wineryKey, m.memberRole), 'ERP', 'MEMBER_JOINED', { type: 'membership', id: m.id }, w.id, {
        after: { role: m.memberRole },
      })
    }
  }

  // Bloqueos (dueño y plataforma).
  const blocks: MemberBlock[] = [
    {
      membershipId: memberId('ines', 'altos'),
      organizationId: W('altos').id,
      by: 'OWNER',
      reason: 'Terminó su contrato de temporada.',
      at: at(2026, 6, 30, 10),
    },
    {
      membershipId: memberId('cvj_contable', 'cintiviejo'),
      organizationId: W('cintiviejo').id,
      by: 'PLATFORM',
      reason: 'Acceso compartido detectado; pendiente de confirmar con la dueña.',
      at: at(2026, 9, 12, 15),
    },
  ]
  fact(blocks[0]!.at, member('altos_admin', 'altos', 'OWNER'), 'ERP', 'MEMBER_BLOCKED', { type: 'membership', id: blocks[0]!.membershipId }, W('altos').id, {
    before: { status: 'ACTIVE' },
    after: { status: 'BLOCKED', blockedBy: 'OWNER' },
    reason: blocks[0]!.reason,
  })
  fact(blocks[1]!.at, staff('soporte'), 'BACKOFFICE', 'MEMBER_BLOCKED', { type: 'membership', id: blocks[1]!.membershipId }, W('cintiviejo').id, {
    before: { status: 'ACTIVE' },
    after: { status: 'BLOCKED', blockedBy: 'PLATFORM' },
    reason: blocks[1]!.reason,
  })
  mails.push({
    at: blocks[1]!.at,
    draft: simpleMail(U('cvj_admin').email, 'TEAM_CHANGED_BY_PLATFORM', 'Cambio en el equipo de Destilería Cinti Viejo', [
      `El equipo de Drinks on Chain bloqueó a ${U('cvj_contable').fullName} en Destilería Cinti Viejo.`,
      `Motivo: ${blocks[1]!.reason}`,
    ]),
  })

  // ---------------------------------------------------------------------------
  // Configuración: estándar, ajustes por bodega (con una excepción legal) e historial
  // ---------------------------------------------------------------------------
  const jorge = U('bo_admin').fullName
  const INSTALLED = at(2026, 1, 5, 0)
  const settings: StoredSetting[] = SETTINGS_CATALOG.map((s) => ({ key: s.key, value: s.default, updatedAt: INSTALLED, updatedBy: null }))
  const overrides: StoredOverride[] = []
  const settingHistory: StoredSettingHistory[] = []
  function override(key: string, wineryKey: string, value: unknown, updatedAt: string, reason: string, legalException = false) {
    const wineryId = W(wineryKey).id
    overrides.push({ key, wineryId, value, legalException, reason, updatedAt, updatedBy: jorge })
    const before = SETTINGS_CATALOG.find((s) => s.key === key)!.default
    settingHistory.push({ key, at: updatedAt, by: jorge, scope: wineryId, before, after: value, reason, legalException })
    fact(updatedAt, staff('bo_admin'), 'BACKOFFICE', 'SETTING_OVERRIDE_SET', { type: 'setting', id: key }, wineryId, {
      before: { value: null },
      after: { value, legalException },
      reason,
    })
  }
  function changeGlobal(key: string, before: unknown, after: unknown, updatedAt: string, reason: string) {
    const stored = settings.find((s) => s.key === key)!
    Object.assign(stored, { value: after, updatedAt, updatedBy: jorge })
    settingHistory.push({ key, at: updatedAt, by: jorge, scope: 'GLOBAL', before, after, reason, legalException: false })
    fact(updatedAt, staff('bo_admin'), 'BACKOFFICE', 'SETTING_CHANGED', { type: 'setting', id: key }, null, {
      before: { value: before },
      after: { value: after },
      reason,
    })
  }
  override('canje.ventanaDias', 'uriondo', 45, at(2026, 6, 1, 10), 'Clientes de temporada alta: ventana ampliada acordada con la bodega.')
  override('equipo.maxColaboradoresPorBodega', 'cintiviejo', 6, at(2026, 7, 1, 10), 'Plan piloto de equipo reducido.')
  override('puntos.bodegaPuedeHabilitar', 'cintiviejo', true, at(2026, 8, 5, 10), 'La destilería gestiona sus propios puntos de canje.')
  override('compra.maxBotellasPorCompra', 'cintiviejo', 6, at(2026, 9, 1, 10), 'Singani Gran Reserva de producción limitada.')
  changeGlobal('canje.ventanaDias', 30, 45, at(2026, 9, 10, 9), 'Prueba de ventana de canje ampliada.')
  const LEGAL = 'Excepción autorizada para el Cuartel 3 · El Portillo (1.540 msnm) mientras dure el ensayo con el ente regulador.'
  override('trazabilidad.excepcionMinimoLegal', 'altos', true, at(2026, 9, 10, 11), LEGAL)
  override('trazabilidad.singani.altitudMinimaMsnm', 'altos', 1500, at(2026, 9, 10, 11, 5), LEGAL, true)
  changeGlobal('canje.ventanaDias', 45, 30, at(2026, 9, 12, 9), 'Se vuelve al estándar tras la prueba.')

  // ---------------------------------------------------------------------------
  // ERP: registros de trazabilidad (quién los hizo según su rol en la bodega)
  // ---------------------------------------------------------------------------
  const wineryKeyOf = (wineryId: string) => wineryKeys.find((k) => W(k).id === wineryId)!
  const byRole: Record<string, Partial<Record<MembershipRole, string>>> = {
    altos: { AGRONOMIST: 'altos_agronomo', ENOLOGIST: 'altos_enologa' },
    cintiviejo: { AGRONOMIST: 'cvj_agronomo', ENOLOGIST: 'cvj_enologa' },
    guadalquivir: { AGRONOMIST: 'vgq_admin', ENOLOGIST: 'vgq_admin' },
  }
  const erpActor = (wineryId: string, role: 'AGRONOMIST' | 'ENOLOGIST', memberIdHint?: string | null) => {
    const wk = wineryKeyOf(wineryId)
    const hinted = memberIdHint ? W(wk).members?.find((m) => m.id === memberIdHint) : undefined
    if (hinted) {
      const key = users.find((u) => u.id === hinted.userId)!._mock.key
      return member(key, wk, hinted.memberRole)
    }
    const key = byRole[wk]?.[role] ?? W(wk).members!.find((m) => m.memberRole === 'OWNER')!.userId
    const u = users.find((x) => x._mock.key === key) ?? users.find((x) => x.id === key)!
    const role2 = W(wk).members!.find((m) => m.userId === u.id)!.memberRole
    return member(u._mock.key, wk, role2)
  }
  const tankWinery = (tankId: string) => erp['fermentation-tanks.json'].find((t) => t.id === tankId)!.wineryId
  for (const t of erp['terroirs.json']) {
    fact(t.createdAt, erpActor(t.wineryId, 'AGRONOMIST'), 'ERP', 'TERROIR_CREATED', { type: 'terroir', id: t.id }, t.wineryId, {
      after: { parcelName: t.parcelName, altitudeMasl: t.altitudeMasl },
    })
  }
  for (const h of erp['harvest-batches.json']) {
    fact(h.createdAt, erpActor(h.wineryId, 'AGRONOMIST', h.certifiedByMemberId), 'ERP', 'HARVEST_BATCH_CREATED', { type: 'harvest_batch', id: h.id }, h.wineryId, {
      after: { harvestBatchCode: h.harvestBatchCode, netWeightKg: h.netWeightKg },
    })
  }
  for (const t of erp['fermentation-tanks.json']) {
    fact(t.createdAt, erpActor(t.wineryId, 'ENOLOGIST'), 'ERP', 'FERMENTATION_TANK_CREATED', { type: 'fermentation_tank', id: t.id }, t.wineryId, {
      after: { tankCode: t.tankCode, status: t.status },
    })
  }
  for (const tr of erp['enological-treatments.json']) {
    const wineryId = tankWinery(tr.fermentationTankId)
    const when = tr.appliedAt.length === 10 ? `${tr.appliedAt}T12:00:00Z` : tr.appliedAt
    fact(when, erpActor(wineryId, 'ENOLOGIST'), 'ERP', 'ENOLOGICAL_TREATMENT_ADDED', { type: 'enological_treatment', id: tr.id }, wineryId, {
      after: { treatmentType: tr.treatmentType },
    })
  }
  for (const a of erp['wine-aging.json']) {
    fact(a.createdAt, erpActor(a.wineryId, 'ENOLOGIST'), 'ERP', 'WINE_AGING_BATCH_CREATED', { type: 'wine_aging_batch', id: a.id }, a.wineryId, {
      after: { lockUntilDate: a.lockUntilDate },
    })
  }
  for (const p of erp['production-batches.json']) {
    fact(p.createdAt, erpActor(p.wineryId, 'ENOLOGIST'), 'ERP', 'PRODUCTION_BATCH_CREATED', { type: 'production_batch', id: p.id }, p.wineryId, {
      after: { processType: p.processType, isDoEligible: p.isDoEligible },
    })
  }
  for (const b of erp['bottling.json']) {
    fact(b.createdAt, erpActor(b.wineryId, 'ENOLOGIST', b.releasedByMemberId), 'ERP', 'BOTTLING_BATCH_CREATED', { type: 'bottling_batch', id: b.id }, b.wineryId, {
      after: { internationalLotCode: b.internationalLotCode, bottles: b.totalBottlesPackaged },
    })
  }
  for (const l of erp['lab-analyses.json']) {
    const wineryId = erp['bottling.json'].find((b) => b.id === l.bottlingBatchId)!.wineryId
    fact(l.createdAt, erpActor(wineryId, 'ENOLOGIST', l.reviewedByMemberId), 'ERP', 'LAB_ANALYSIS_CREATED', { type: 'lab_analysis', id: l.id }, wineryId, {
      after: { conformsToSenasagStandards: l.conformsToSenasagStandards },
    })
  }

  // ---------------------------------------------------------------------------
  // Encadenado: orden cronológico (estable) y hash
  // ---------------------------------------------------------------------------
  const ordered = [...facts].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.order - b.order))
  const audit: AuditEvent[] = []
  for (const f of ordered) {
    const input: AuditInput & { order?: number } = { ...f }
    delete input.order
    const seq = audit.length + 1
    audit.push(chainAuditEvent(audit.at(-1), { ...input, correlationId: `fx-${String(seq).padStart(4, '0')}` }, uid(`audit:${seq}`)))
  }

  // ---------------------------------------------------------------------------
  // Alertas del tablero y buzón
  // ---------------------------------------------------------------------------
  const alerts: DashboardAlert[] = [
    {
      id: uid('alert:uriondo-suspended'),
      level: 'WARNING',
      message: 'Casa Uriondo está suspendida por el registro SENASAG vencido.',
      createdAt: at(2026, 8, 20, 10),
      link: `/bodegas/${W('uriondo').id}`,
    },
    {
      id: uid('alert:guadalquivir-expired'),
      level: 'WARNING',
      message: 'Caducó la invitación del dueño de Viñedos del Guadalquivir: reenvíala desde la ficha de la bodega.',
      createdAt: at(2026, 9, 21, 9),
      link: `/bodegas/${W('guadalquivir').id}`,
    },
    {
      id: uid('alert:angostura-meeting'),
      level: 'INFO',
      message: 'Reunión por videollamada con Viñedos La Angostura el 29-09 a las 15:00 (UTC).',
      createdAt: at(2026, 9, 19, 10),
      link: `/solicitudes/${uid('application:angostura')}`,
    },
  ]
  const mailbox: MockEmail[] = [...mails]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((m, i) => renderEmail(m.draft, uid(`email:${i + 1}`), m.at, DEFAULT_APP_URLS))

  const details = wineryKeys.map((key) =>
    buildWineryDetail(W(key), profiles.find((p) => p.wineryId === W(key).id)!, { users, invitations, nowIso: REFERENCE_NOW }),
  )

  return {
    'applications.json': applications.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    'invitations.json': invitations,
    'winery-profiles.json': profiles,
    'winery-details.json': details,
    'member-blocks.json': blocks,
    'staff-mfa.json': staffMfa,
    'settings.json': settings,
    'setting-overrides.json': overrides,
    'setting-history.json': settingHistory,
    'alerts.json': alerts,
    'audit.json': audit,
    'mailbox.json': mailbox,
    'waitlist.json': generateWaitlistFixtures(),
  }
}
