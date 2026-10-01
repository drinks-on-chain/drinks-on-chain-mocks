import alertsJson from '../../fixtures/backoffice/alerts.json'
import applicationsJson from '../../fixtures/backoffice/applications.json'
import auditJson from '../../fixtures/backoffice/audit.json'
import invitationsJson from '../../fixtures/backoffice/invitations.json'
import mailboxJson from '../../fixtures/backoffice/mailbox.json'
import blocksJson from '../../fixtures/backoffice/member-blocks.json'
import historyJson from '../../fixtures/backoffice/setting-history.json'
import overridesJson from '../../fixtures/backoffice/setting-overrides.json'
import settingsJson from '../../fixtures/backoffice/settings.json'
import staffMfaJson from '../../fixtures/backoffice/staff-mfa.json'
import waitlistJson from '../../fixtures/backoffice/waitlist.json'
import detailsJson from '../../fixtures/backoffice/winery-details.json'
import profilesJson from '../../fixtures/backoffice/winery-profiles.json'
import type {
  MemberBlock,
  StaffMfa,
  StoredApplication,
  StoredInvitation,
  StoredOverride,
  StoredSetting,
  StoredSettingHistory,
  WineryProfile,
} from './model'
import type { AuditEvent, DashboardAlert, MockEmail, WaitlistEntry, WineryDetail } from './schemas'

// Fixtures de la Ola 1 tipados (`fixtures/backoffice/*.json`, generados por `pnpm seed`). Se
// validan contra sus esquemas en test/backoffice-fixtures.test.ts.

export interface BackofficeFixtures {
  /** Solicitudes de alta con notas; `_mock.verifyToken` en las `UNVERIFIED`. */
  applications: StoredApplication[]
  /** Invitaciones; `_mock.token` es el token del enlace. */
  invitations: StoredInvitation[]
  /** Perfil de la Ola 1 de cada bodega (slug, prefijo de lote, historia pública, historial). */
  wineryProfiles: WineryProfile[]
  /** Fichas `WineryDetail` tal como las devuelve el back office con los fixtures. */
  wineryDetails: WineryDetail[]
  memberBlocks: MemberBlock[]
  /** Segundo factor del personal interno (secreto de demo `DEMO_TOTP_SECRET`). */
  staffMfa: StaffMfa[]
  /** Valor general de cada parámetro (docs-back/05 §4). */
  settings: StoredSetting[]
  settingOverrides: StoredOverride[]
  settingHistory: StoredSettingHistory[]
  alerts: DashboardAlert[]
  /** Bitácora encadenada por hash. */
  audit: AuditEvent[]
  /** Correos ya "enviados" (buzón simulado). */
  mailbox: MockEmail[]
  /** Lista de espera (contrato O1b): consumidores y bodegas, más recientes primero. */
  waitlist: WaitlistEntry[]
}

export const backofficeFixtures: BackofficeFixtures = {
  applications: applicationsJson as unknown as StoredApplication[],
  invitations: invitationsJson as unknown as StoredInvitation[],
  wineryProfiles: profilesJson as unknown as WineryProfile[],
  wineryDetails: detailsJson as unknown as WineryDetail[],
  memberBlocks: blocksJson as unknown as MemberBlock[],
  staffMfa: staffMfaJson as unknown as StaffMfa[],
  settings: settingsJson as unknown as StoredSetting[],
  settingOverrides: overridesJson as unknown as StoredOverride[],
  settingHistory: historyJson as unknown as StoredSettingHistory[],
  alerts: alertsJson as unknown as DashboardAlert[],
  audit: auditJson as unknown as AuditEvent[],
  mailbox: mailboxJson as unknown as MockEmail[],
  waitlist: waitlistJson as unknown as WaitlistEntry[],
}
