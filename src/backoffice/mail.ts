import type { MailApp, MailTemplate, MockEmail } from './schemas/mail'

// Plantillas de los correos de la Ola 1 (contrato §10) para el buzón simulado. Texto en español
// con la marca Drinks on Chain; el HTML es el mismo texto con el enlace como botón.

/** URL base de cada app en los enlaces de los correos (configurable con `setMockAppUrls`). */
export type AppUrls = Record<MailApp, string>

export const DEFAULT_APP_URLS: AppUrls = {
  WEB: 'http://localhost:3000',
  ERP: 'http://localhost:3002',
  BACKOFFICE: 'http://localhost:3003',
  POS: 'http://localhost:3004',
  MARKETPLACE: 'http://localhost:3005',
}

/** Rutas de los enlaces en cada app (propuesta de los mocks; ver docs/CONTRATO.md §6). */
export const MAIL_PATHS = {
  invitation: (token: string) => `/invitacion/${encodeURIComponent(token)}`,
  applicationVerify: (token: string) => `/unirse/verificar?token=${encodeURIComponent(token)}`,
  passwordReset: (token: string) => `/restablecer-contrasena?token=${encodeURIComponent(token)}`,
  emailVerify: (token: string) => `/verificar-correo?token=${encodeURIComponent(token)}`,
  // Ola 3 (propuesta de los mocks, como las anteriores): la misma ruta en el ERP y en el back office.
  tokenizationRequest: (requestId: string) => `/tokenizacion/solicitudes/${encodeURIComponent(requestId)}`,
  collection: (collectionId: string) => `/tokenizacion/colecciones/${encodeURIComponent(collectionId)}`,
  chainAlerts: () => '/cadena/alertas',
} as const

export interface MailDraft {
  to: string
  template: MailTemplate
  subject: string
  lines: string[]
  app: MailApp | null
  path: string | null
  token: string | null
  cta?: string
  /** Enlace absoluto fuera de las apps (p. ej. el contrato en el explorador): sustituye a `app` + `path`. */
  url?: string
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Convierte un borrador en el correo guardado. */
export function renderEmail(draft: MailDraft, id: string, createdAt: string, urls: AppUrls): MockEmail {
  const link = draft.url ?? (draft.app && draft.path ? `${urls[draft.app].replace(/\/+$/, '')}${draft.path}` : null)
  const text = [...draft.lines, ...(link ? ['', `${draft.cta ?? 'Abrir'}: ${link}`] : []), '', '— Drinks on Chain'].join('\n')
  const html = [
    '<div style="font-family:Georgia,serif;color:#1d1b16;background:#fdfcf5;padding:24px">',
    '<p style="font-size:20px;margin:0 0 16px">Drinks on Chain</p>',
    ...draft.lines.map((l) => `<p>${escapeHtml(l)}</p>`),
    link ? `<p><a href="${escapeHtml(link)}" style="color:#7a5c14">${escapeHtml(draft.cta ?? 'Abrir')}</a></p>` : '',
    '</div>',
  ].join('')
  return {
    id,
    to: draft.to,
    subject: draft.subject,
    template: draft.template,
    text,
    html,
    link,
    token: draft.token,
    app: draft.app,
    createdAt,
  }
}

const ROLE_LABELS: Record<string, string> = {
  SUPERADMIN: 'superusuario',
  ADMIN: 'administración',
  OPERATIONS: 'operaciones',
  SUPPORT: 'soporte',
  OWNER: 'dueño o dueña',
  ENOLOGIST: 'enología',
  AGRONOMIST: 'agronomía',
  OPERATOR: 'operario',
  ACCOUNTANT: 'contabilidad',
  MANAGER: 'encargado',
  CASHIER: 'cajero',
}

export const roleLabel = (role: string) => ROLE_LABELS[role] ?? role

/** Invitación: bodega → ERP, plataforma → Backoffice, punto → POS. */
export function invitationMail(p: {
  to: string
  token: string
  organizationName: string
  organizationType: 'PLATFORM' | 'WINERY' | 'PICKUP_POINT'
  role: string
  invitedByName: string
  expiresAt: string
}): MailDraft {
  const app: MailApp = p.organizationType === 'PLATFORM' ? 'BACKOFFICE' : p.organizationType === 'PICKUP_POINT' ? 'POS' : 'ERP'
  return {
    to: p.to,
    template: 'INVITATION',
    subject: `Invitación a ${p.organizationName} en Drinks on Chain`,
    lines: [
      'Hola:',
      `${p.invitedByName} te invita a ${p.organizationName} con el rol de ${roleLabel(p.role)}.`,
      `El enlace es de un solo uso y caduca el ${p.expiresAt.slice(0, 16).replace('T', ' ')} (UTC).`,
    ],
    app,
    path: MAIL_PATHS.invitation(p.token),
    token: p.token,
    cta: 'Aceptar la invitación',
  }
}

export function applicationVerifyMail(p: { to: string; token: string; tradeName: string }): MailDraft {
  return {
    to: p.to,
    template: 'APPLICATION_VERIFY',
    subject: 'Confirma tu correo para completar la solicitud',
    lines: [`Recibimos la solicitud de ${p.tradeName} para unirse a Drinks on Chain.`, 'Confirma tu correo para que el equipo pueda revisarla.'],
    app: 'WEB',
    path: MAIL_PATHS.applicationVerify(p.token),
    token: p.token,
    cta: 'Confirmar el correo',
  }
}

export function simpleMail(to: string, template: MailTemplate, subject: string, lines: string[]): MailDraft {
  return { to, template, subject, lines, app: null, path: null, token: null }
}

export function passwordResetMail(p: { to: string; token: string; app: MailApp }): MailDraft {
  return {
    to: p.to,
    template: 'PASSWORD_RESET',
    subject: 'Restablece tu contraseña de Drinks on Chain',
    lines: [
      'Pediste restablecer tu contraseña.',
      'El enlace es de un solo uso y caduca en 60 minutos. Si no fuiste tú, ignora este correo.',
    ],
    app: p.app,
    path: MAIL_PATHS.passwordReset(p.token),
    token: p.token,
    cta: 'Elegir una contraseña nueva',
  }
}

export function emailVerifyMail(p: { to: string; token: string; app: MailApp }): MailDraft {
  return {
    to: p.to,
    template: 'EMAIL_VERIFY',
    subject: 'Confirma tu correo en Drinks on Chain',
    lines: ['Confirma que este correo es tuyo.'],
    app: p.app,
    path: MAIL_PATHS.emailVerify(p.token),
    token: p.token,
    cta: 'Confirmar el correo',
  }
}
