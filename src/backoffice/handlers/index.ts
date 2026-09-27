import type { RouteSpec } from '../../erp/handlers/http'
import { applicationRoutes } from './applications'
import { auditRoutes } from './audit'
import { identityRoutes } from './identity'
import { invitationRoutes } from './invitations'
import { settingsRoutes } from './settings'
import { teamRoutes } from './team'
import { wineryOrganizationRoutes, wineryPlatformRoutes } from './wineries'

// Handlers de la Ola 1 (plan/contratos/o1-backoffice-y-bodegas.md): cuenta y segundo factor,
// invitaciones, solicitudes, bodegas, equipo, configuración, bitácora y tablero. Comparten la
// base, la sesión y la infraestructura de los del ERP.

export const BACKOFFICE_ROUTE_SPECS: readonly RouteSpec[] = [
  ...identityRoutes,
  ...invitationRoutes,
  ...applicationRoutes,
  ...wineryPlatformRoutes,
  ...wineryOrganizationRoutes,
  ...teamRoutes,
  ...settingsRoutes,
  ...auditRoutes,
]

export { withErpExtras, IDEMPOTENT_ERP_OPERATIONS } from './erp-audit'
export { getMockAppUrls, mockMailbox, setMockAppUrls, type MailboxFilter } from './support'
