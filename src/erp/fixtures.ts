import authLoginJson from '../../fixtures/erp/auth-login.json'
import bottlingJson from '../../fixtures/erp/bottling.json'
import treatmentsJson from '../../fixtures/erp/enological-treatments.json'
import logsJson from '../../fixtures/erp/fermentation-logs.json'
import tanksJson from '../../fixtures/erp/fermentation-tanks.json'
import harvestJson from '../../fixtures/erp/harvest-batches.json'
import labJson from '../../fixtures/erp/lab-analyses.json'
import lotsJson from '../../fixtures/erp/lots-view.json'
import productionJson from '../../fixtures/erp/production-batches.json'
import restStatusJson from '../../fixtures/erp/production-rest-status.json'
import terroirsJson from '../../fixtures/erp/terroirs.json'
import publicJson from '../../fixtures/erp/traceability-public.json'
import usersJson from '../../fixtures/erp/users.json'
import walletsJson from '../../fixtures/erp/wallets.json'
import agingJson from '../../fixtures/erp/wine-aging.json'
import wineriesJson from '../../fixtures/erp/wineries.json'
import type {
  AuthResponse,
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  EnologicalTreatment,
  FermentationLog,
  FermentationTankResponse,
  HarvestBatchResponse,
  LotView,
  MemberRole,
  MockUser,
  ProductionBatchResponse,
  PublicPassport,
  RestStatusResponse,
  TerroirResponse,
  UserRole,
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
  /** Respuesta de login por clave de usuario (`_mock.key`). */
  authLogin: Record<string, AuthResponse>
  terroirs: TerroirResponse[]
  harvestBatches: HarvestBatchResponse[]
  fermentationTanks: FermentationTankResponse[]
  fermentationLogs: FermentationLog[]
  enologicalTreatments: EnologicalTreatment[]
  wineAging: WineAgingResponse[]
  productionBatches: ProductionBatchResponse[]
  productionRestStatus: RestStatusResponse[]
  bottling: BottlingBatchResponse[]
  labAnalyses: BatchLabAnalysisResponse[]
  /** Pasaporte público por código de lote. */
  traceabilityPublic: Record<string, PublicPassport>
  lotsView: LotView[]
}

export const erpFixtures: ErpFixtures = {
  wineries: wineriesJson as unknown as WineryResponse[],
  users: usersJson as unknown as MockUser[],
  wallets: walletsJson as unknown as WalletResponse[],
  authLogin: authLoginJson as unknown as Record<string, AuthResponse>,
  terroirs: terroirsJson as unknown as TerroirResponse[],
  harvestBatches: harvestJson as unknown as HarvestBatchResponse[],
  fermentationTanks: tanksJson as unknown as FermentationTankResponse[],
  fermentationLogs: logsJson as unknown as FermentationLog[],
  enologicalTreatments: treatmentsJson as unknown as EnologicalTreatment[],
  wineAging: agingJson as unknown as WineAgingResponse[],
  productionBatches: productionJson as unknown as ProductionBatchResponse[],
  productionRestStatus: restStatusJson as unknown as RestStatusResponse[],
  bottling: bottlingJson as unknown as BottlingBatchResponse[],
  labAnalyses: labJson as unknown as BatchLabAnalysisResponse[],
  traceabilityPublic: publicJson as unknown as Record<string, PublicPassport>,
  lotsView: lotsJson as unknown as LotView[],
}

/** Contraseña de todos los usuarios de demo. */
export const DEMO_PASSWORD = 'demo1234'

/** Usuario de demo para un panel de desarrollo "cambiar de usuario". */
export interface DemoUser {
  key: string
  email: string
  password: string
  fullName: string
  userRole: UserRole
  memberRole: MemberRole | null
  wineryId: string | null
  wineryName: string | null
  /** Token Bearer que aceptan los handlers (`mock.access.<key>`). */
  accessToken: string
}

export const demoUsers: DemoUser[] = erpFixtures.users.map((u) => {
  const m = u.wineryMemberships[0]
  return {
    key: u._mock.key,
    email: u.email,
    password: u._mock.password,
    fullName: u.fullName,
    userRole: u.userRole,
    memberRole: m?.memberRole ?? null,
    wineryId: m?.wineryId ?? null,
    wineryName: m?.wineryName ?? null,
    accessToken: `mock.access.${u._mock.key}`,
  }
})
