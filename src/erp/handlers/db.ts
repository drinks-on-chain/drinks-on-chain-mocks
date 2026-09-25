import { REFERENCE_DAY, toDay, type Day } from '../../shared/dates'
import { uid } from '../../shared/uuid'
import { erpFixtures } from '../fixtures'
import type {
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  EnologicalTreatment,
  FermentationLog,
  FermentationTankResponse,
  HarvestBatchResponse,
  MockUser,
  ProductionBatchResponse,
  TerroirResponse,
  WalletResponse,
  WineAgingResponse,
  WineryResponse,
} from '../schemas'

// Base de datos en memoria de los handlers del ERP: una copia de los fixtures que las
// mutaciones modifican durante la sesión. `resetErpDb()` la devuelve al estado inicial.

/** Instante inicial del reloj fijo de los mocks. */
export const CLOCK_START = Date.parse(`${REFERENCE_DAY}T12:00:00Z`)

export interface ErpDb {
  wineries: WineryResponse[]
  users: MockUser[]
  wallets: WalletResponse[]
  terroirs: TerroirResponse[]
  harvestBatches: HarvestBatchResponse[]
  tanks: FermentationTankResponse[]
  logs: FermentationLog[]
  treatments: EnologicalTreatment[]
  wineAgings: WineAgingResponse[]
  productionBatches: ProductionBatchResponse[]
  bottlings: BottlingBatchResponse[]
  labAnalyses: BatchLabAnalysisResponse[]
  /** Reloj fijo (ms). Avanza un minuto con cada alta. */
  clock: number
  /** Contadores por recurso para ids deterministas. */
  counters: Record<string, number>
}

function createErpDb(): ErpDb {
  const f = structuredClone(erpFixtures)
  return {
    wineries: f.wineries,
    users: f.users,
    wallets: f.wallets,
    terroirs: f.terroirs,
    harvestBatches: f.harvestBatches,
    tanks: f.fermentationTanks,
    logs: f.fermentationLogs,
    treatments: f.enologicalTreatments,
    wineAgings: f.wineAging,
    productionBatches: f.productionBatches,
    bottlings: f.bottling,
    labAnalyses: f.labAnalyses,
    clock: CLOCK_START,
    counters: {},
  }
}

let db: ErpDb = createErpDb()

/** Base de datos actual de los handlers (para pruebas y herramientas de desarrollo). */
export function getErpDb(): ErpDb {
  return db
}

/** Descarta los cambios de la sesión: vuelve a los fixtures y reinicia el reloj. */
export function resetErpDb(): void {
  db = createErpDb()
}

/** Fecha y hora actual del reloj con milisegundos (para `timestamp` del envoltorio). */
export function nowIso(): string {
  return new Date(db.clock).toISOString()
}

/** Avanza el reloj un minuto y devuelve la marca en el formato de los fixtures (`…:SSZ`). */
export function tick(): string {
  db.clock += 60_000
  return new Date(db.clock).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** "Hoy" según el reloj de los mocks. */
export function today(): Day {
  return toDay(new Date(db.clock))
}

/** Siguiente número de secuencia de un recurso. */
export function nextSeq(resource: string): number {
  db.counters[resource] = (db.counters[resource] ?? 0) + 1
  return db.counters[resource]
}

/** Id determinista para una entidad creada en la sesión (`mock:<recurso>:<n>`). */
export function newId(resource: string): string {
  return uid(`mock:${resource}:${nextSeq(resource)}`)
}
