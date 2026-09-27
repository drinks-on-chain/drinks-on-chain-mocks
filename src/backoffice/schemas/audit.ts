import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'

// Bitácora (contrato de la Ola 1 §7; docs-back/07 §4). Solo inserción y encadenada por hash:
// `hash` = SHA-256 (hex) del JSON canónico del evento sin `hash` (claves ordenadas, sin espacios),
// que incluye `prevHash` (el `hash` del evento anterior; `null` en el primero).

export const CLIENT_APPS = ['ERP', 'MARKETPLACE', 'BACKOFFICE', 'POS', 'PUBLIC', 'API', 'WORKER'] as const
export const ClientAppSchema = z.enum(CLIENT_APPS)
export type ClientApp = z.infer<typeof ClientAppSchema>

/** Cabecera con la que cada app se identifica (`ERP`, `BACKOFFICE`…). */
export const CLIENT_APP_HEADER = 'X-Client-App'

export const AuditActorSchema = z.object({
  userId: z.string().nullable(),
  fullName: z.string().nullable(),
  role: z.string().nullable(),
  organizationId: z.string().nullable(),
  viaPlatform: z.boolean(),
})
export type AuditActor = z.infer<typeof AuditActorSchema>

export const AuditEventSchema = z.object({
  id: z.string(),
  seq: z.number().int().min(1),
  occurredAt: IsoDateTimeSchema,
  /** `userId: null` = el sistema. */
  actor: AuditActorSchema,
  source: z.object({
    app: ClientAppSchema,
    ip: z.string().nullable(),
    deviceId: z.string().nullable(),
  }),
  /** Código estable: `WINERY_APPROVED`, `MEMBER_BLOCKED`, `SETTING_CHANGED`… */
  action: z.string(),
  resource: z.object({
    type: z.string(),
    id: z.string().nullable(),
  }),
  /** Organización afectada. */
  organizationId: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  correlationId: z.string().nullable(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
})
export type AuditEvent = z.infer<typeof AuditEventSchema>

/** `GET /v1/platform/audit/verify`. */
export const AuditVerifyResultSchema = z.object({
  valid: z.boolean(),
  checked: z.number().int().min(0),
  firstBrokenSeq: z.number().int().nullable(),
})
export type AuditVerifyResult = z.infer<typeof AuditVerifyResultSchema>

/** Máximo de filas de `GET /v1/platform/audit/export` (más → 422 `AUDIT_EXPORT_TOO_LARGE`). */
export const AUDIT_EXPORT_MAX_ROWS = 50_000
