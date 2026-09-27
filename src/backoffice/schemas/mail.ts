import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'

// Buzón simulado (solo en los mocks): los correos que el backend enviaría por la cola `email`
// (contrato de la Ola 1 §10) se guardan aquí para que el panel `/__mocks` y las e2e lean los
// enlaces, como harían con Mailpit.

export const MAIL_TEMPLATES = [
  'INVITATION',
  'APPLICATION_VERIFY',
  'APPLICATION_RECEIVED',
  'APPLICATION_NEW_FOR_OPERATIONS',
  'APPLICATION_DUPLICATE_FOR_OPERATIONS',
  'APPLICATION_APPROVED',
  'APPLICATION_REJECTED',
  'PASSWORD_RESET',
  'PASSWORD_CHANGED',
  'EMAIL_VERIFY',
  'TEAM_CHANGED_BY_PLATFORM',
  'WINERY_STATUS_CHANGED',
  'MFA_RESET',
  'MFA_FAILED_ATTEMPTS',
] as const
export const MailTemplateSchema = z.enum(MAIL_TEMPLATES)
export type MailTemplate = z.infer<typeof MailTemplateSchema>

/** App a la que lleva el enlace del correo. */
export const MAIL_APPS = ['ERP', 'BACKOFFICE', 'WEB', 'POS', 'MARKETPLACE'] as const
export const MailAppSchema = z.enum(MAIL_APPS)
export type MailApp = z.infer<typeof MailAppSchema>

export const MockEmailSchema = z.object({
  id: z.string(),
  to: z.string(),
  subject: z.string(),
  template: MailTemplateSchema,
  text: z.string(),
  html: z.string(),
  /** Enlace principal del correo (invitación, verificación, recuperación…). */
  link: z.string().nullable(),
  /** Token del enlace, para las pruebas que no quieren analizar la URL. */
  token: z.string().nullable(),
  app: MailAppSchema.nullable(),
  createdAt: IsoDateTimeSchema,
})
export type MockEmail = z.infer<typeof MockEmailSchema>
