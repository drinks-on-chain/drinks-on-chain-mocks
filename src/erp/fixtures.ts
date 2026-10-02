import authLoginJson from '../../fixtures/erp/auth-login.json'
import bottlingJson from '../../fixtures/erp/bottling.json'
import treatmentsJson from '../../fixtures/erp/enological-treatments.json'
import logsJson from '../../fixtures/erp/fermentation-logs.json'
import tanksJson from '../../fixtures/erp/fermentation-tanks.json'
import harvestJson from '../../fixtures/erp/harvest-batches.json'
import labJson from '../../fixtures/erp/lab-analyses.json'
import bottleLotsJson from '../../fixtures/erp/bottle-lots.json'
import correctionsJson from '../../fixtures/erp/corrections.json'
import lotAttachmentsJson from '../../fixtures/erp/lot-attachments.json'
import lotDossiersJson from '../../fixtures/erp/lot-dossiers.json'
import lotEventsJson from '../../fixtures/erp/lot-events.json'
import lotsV2Json from '../../fixtures/erp/lots.json'
import lotsJson from '../../fixtures/erp/lots-view.json'
import maturityJson from '../../fixtures/erp/maturity-analyses.json'
import phytoJson from '../../fixtures/erp/phyto-decisions.json'
import productionJson from '../../fixtures/erp/production-batches.json'
import restStatusJson from '../../fixtures/erp/production-rest-status.json'
import terroirsJson from '../../fixtures/erp/terroirs.json'
import publicJson from '../../fixtures/erp/traceability-public.json'
import usersJson from '../../fixtures/erp/users.json'
import walletsJson from '../../fixtures/erp/wallets.json'
import agingJson from '../../fixtures/erp/wine-aging.json'
import wineriesJson from '../../fixtures/erp/wineries.json'
import staffMfaJson from '../../fixtures/backoffice/staff-mfa.json'
import type { StaffMfa } from '../backoffice/model'
import type { BottleLot, StoredAttachment } from './trace/state'
import type {
  Audience,
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  Correction,
  EnologicalTreatmentRecord,
  FermentationLogRecord,
  FermentationTankResponse,
  HarvestBatchResponse,
  Lot,
  LotDossier,
  LotView,
  MaturityAnalysis,
  Membership,
  MembershipRole,
  MockUser,
  PhytoDecision,
  PlatformRole,
  ProductionBatchResponse,
  PublicPassport,
  RestStatusResponse,
  SessionResponse,
  StoredLotEvent,
  TerroirResponse,
  WalletResponse,
  WineAgingResponse,
  WineryResponse,
} from './schemas'

// Fixtures del ERP tipados. Los JSON se validan contra los esquemas en test/fixtures.test.ts,
// por eso aquí basta con declarar su tipo.

export interface ErpFixtures {
  wineries: WineryResponse[]
  users: MockUser[]
  wallets: WalletResponse[]
  /** Respuesta de login por clave de usuario (`_mock.key`), con los tokens estáticos. */
  authLogin: Record<string, SessionResponse>
  terroirs: TerroirResponse[]
  harvestBatches: HarvestBatchResponse[]
  fermentationTanks: FermentationTankResponse[]
  fermentationLogs: FermentationLogRecord[]
  enologicalTreatments: EnologicalTreatmentRecord[]
  wineAging: WineAgingResponse[]
  productionBatches: ProductionBatchResponse[]
  productionRestStatus: RestStatusResponse[]
  bottling: BottlingBatchResponse[]
  labAnalyses: BatchLabAnalysisResponse[]
  /** Grafo DAG legado por código de lote (`GET /v1/traceability/public/{lotCode}`, hasta H2). */
  traceabilityPublic: Record<string, PublicPassport>
  /** @deprecated Vista derivada de 0.1–0.4; se retira en H2 por `lots`. */
  lotsView: LotView[]
  /**
   * Lotes del servidor (Ola 2) tal como los devuelve `GET /v1/lots/{id}` el día de referencia: los
   * migrados (uno por pesaje anterior, con el id de la semilla del backend) y los nativos de
   * demostración, incluido «Singani Gran Reserva 2026» (contrato §18).
   */
  lots: Lot[]
  /** Línea de tiempo de todos los lotes (cada evento con su `lotId`). */
  lotEvents: StoredLotEvent[]
  maturityAnalyses: MaturityAnalysis[]
  phytoDecisions: PhytoDecision[]
  /** Códigos de botella por lote: totales, series sustituidas, anulados y rangos exportados. */
  bottleLots: BottleLot[]
  corrections: Correction[]
  lotAttachments: StoredAttachment[]
  /** Expedientes cerrados. */
  lotDossiers: LotDossier[]
}

export const erpFixtures: ErpFixtures = {
  wineries: wineriesJson as unknown as WineryResponse[],
  users: usersJson as unknown as MockUser[],
  wallets: walletsJson as unknown as WalletResponse[],
  authLogin: authLoginJson as unknown as Record<string, SessionResponse>,
  terroirs: terroirsJson as unknown as TerroirResponse[],
  harvestBatches: harvestJson as unknown as HarvestBatchResponse[],
  fermentationTanks: tanksJson as unknown as FermentationTankResponse[],
  fermentationLogs: logsJson as unknown as FermentationLogRecord[],
  enologicalTreatments: treatmentsJson as unknown as EnologicalTreatmentRecord[],
  wineAging: agingJson as unknown as WineAgingResponse[],
  productionBatches: productionJson as unknown as ProductionBatchResponse[],
  productionRestStatus: restStatusJson as unknown as RestStatusResponse[],
  bottling: bottlingJson as unknown as BottlingBatchResponse[],
  labAnalyses: labJson as unknown as BatchLabAnalysisResponse[],
  traceabilityPublic: publicJson as unknown as Record<string, PublicPassport>,
  lotsView: lotsJson as unknown as LotView[],
  lots: lotsV2Json as unknown as Lot[],
  lotEvents: lotEventsJson as unknown as StoredLotEvent[],
  maturityAnalyses: maturityJson as unknown as MaturityAnalysis[],
  phytoDecisions: phytoJson as unknown as PhytoDecision[],
  bottleLots: bottleLotsJson as unknown as BottleLot[],
  corrections: correctionsJson as unknown as Correction[],
  lotAttachments: lotAttachmentsJson as unknown as StoredAttachment[],
  lotDossiers: lotDossiersJson as unknown as LotDossier[],
}

/** Contraseña de todos los usuarios de demo. */
export const DEMO_PASSWORD = 'demo1234'

/**
 * Contraseña de ejemplo para cuentas y contraseñas nuevas (aceptar una invitación, restablecer o
 * cambiar la contraseña): cumple la política de la Ola 1 (≥ 10 caracteres, no común).
 */
export const DEMO_NEW_PASSWORD = 'vendimia-2026'

/** Usuario de demo para un panel de desarrollo "cambiar de usuario". */
export interface DemoUser {
  key: string
  email: string
  password: string
  fullName: string
  /** `STAFF` con al menos una membresía; `CONSUMER` sin ninguna. */
  audience: Audience
  /** Membresías (contrato de la Ola 0 §4). */
  memberships: Membership[]
  /** Organización activa al iniciar sesión. */
  activeOrganizationId: string | null
  /**
   * Rol en la organización activa (el de su membresía: plataforma o bodega), o `null` sin
   * organización. Sustituye a `userRole`/`memberRole`, retirados en H1.
   */
  role: MembershipRole | null
  /** Bodega activa, si la organización activa es una bodega. */
  wineryId: string | null
  wineryName: string | null
  /** Token Bearer estático que aceptan los handlers (`mock.access.<key>`), sin sesión revocable. */
  accessToken: string
  /** Rol en la organización de plataforma (personal interno) o `null`. */
  platformRole: PlatformRole | null
  /**
   * Segundo factor del personal interno: el login pide el TOTP. `secret` es `DEMO_TOTP_SECRET`
   * (genera el código con `generateTotp(secret)`); `null` si aún no lo inscribió.
   */
  mfa: { enrolled: boolean; secret: string | null; recoveryCodes: string[] } | null
}

export const demoUsers: DemoUser[] = erpFixtures.users.map((u) => {
  const session = erpFixtures.authLogin[u._mock.key]!
  const active = session.memberships.find((m) => m.organizationId === session.activeOrganizationId)
  return {
    key: u._mock.key,
    email: u.email,
    password: u._mock.password,
    fullName: u.fullName,
    audience: session.user.audience,
    memberships: session.memberships,
    activeOrganizationId: session.activeOrganizationId,
    role: active?.role ?? null,
    wineryId: active?.organizationType === 'WINERY' ? active.organizationId : null,
    wineryName: active?.organizationType === 'WINERY' ? active.organizationName : null,
    accessToken: session.tokens.accessToken,
    platformRole: u._mock.platformRole ?? null,
    mfa: mfaOf(u.id),
  }
})

function mfaOf(userId: string): DemoUser['mfa'] {
  const m = (staffMfaJson as unknown as StaffMfa[]).find((x) => x.userId === userId)
  return m ? { enrolled: m.enrolled, secret: m.secret, recoveryCodes: m.recoveryCodes } : null
}

/** Personal interno de demo (con rol de plataforma), para el panel `/__mocks` y las e2e. */
export const demoStaff: DemoUser[] = demoUsers.filter((u) => u.platformRole !== null)
