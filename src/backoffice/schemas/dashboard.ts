import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'
import { MembershipRoleSchema } from '../../erp/schemas/organizations'
import { AuditEventSchema } from './audit'

// Tablero del back office (contrato de la Ola 1 §8) y matriz de permisos (§5, §9).

export const ALERT_LEVELS = ['INFO', 'WARNING', 'CRITICAL'] as const
export const AlertLevelSchema = z.enum(ALERT_LEVELS)
export type AlertLevel = z.infer<typeof AlertLevelSchema>

export const DashboardAlertSchema = z.object({
  id: z.string(),
  level: AlertLevelSchema,
  message: z.string(),
  createdAt: IsoDateTimeSchema,
  /** Ruta sugerida dentro del back office (propuesta de los mocks), p. ej. `/bodegas/{id}`. */
  link: z.string().nullable(),
})
export type DashboardAlert = z.infer<typeof DashboardAlertSchema>

export const DashboardSchema = z.object({
  applications: z.object({
    unverified: z.number().int(),
    received: z.number().int(),
    inReview: z.number().int(),
    meetingScheduled: z.number().int(),
  }),
  wineries: z.object({
    invited: z.number().int(),
    active: z.number().int(),
    suspended: z.number().int(),
  }),
  invitations: z.object({
    pending: z.number().int(),
    expiringIn24h: z.number().int(),
  }),
  team: z.object({
    blockedMembers: z.number().int(),
  }),
  alerts: z.array(DashboardAlertSchema),
  /** Los 5 eventos más recientes de la bitácora. */
  recentAudit: z.array(AuditEventSchema).max(5),
})
export type Dashboard = z.infer<typeof DashboardSchema>

export const PERMISSION_LEVELS = ['FULL', 'READ', 'OWN', 'NONE'] as const
export const PermissionLevelSchema = z.enum(PERMISSION_LEVELS)
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>

export const PermissionCapabilitySchema = z.object({
  key: z.string(),
  label: z.string(),
  roles: z.record(MembershipRoleSchema, PermissionLevelSchema),
})
export type PermissionCapability = z.infer<typeof PermissionCapabilitySchema>

/** `GET /v1/platform/permissions` (PLT-04). */
export const PermissionMatrixSchema = z.object({
  capabilities: z.array(PermissionCapabilitySchema),
})
export type PermissionMatrix = z.infer<typeof PermissionMatrixSchema>
