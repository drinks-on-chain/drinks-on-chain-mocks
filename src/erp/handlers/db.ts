import { backofficeFixtures } from '../../backoffice/fixtures'
import type {
  MemberBlock,
  StaffMfa,
  StoredApplication,
  StoredInvitation,
  StoredOverride,
  StoredSetting,
  StoredSettingHistory,
  WineryProfile,
} from '../../backoffice/model'
import type { AuditEvent, DashboardAlert, MockEmail } from '../../backoffice/schemas'
import { REFERENCE_DAY, toDay, type Day } from '../../shared/dates'
import { uid } from '../../shared/uuid'
import { erpFixtures } from '../fixtures'
import type {
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  EnologicalTreatmentRecord,
  FermentationLogRecord,
  FermentationTankResponse,
  HarvestBatchResponse,
  MockUser,
  NotificationPrefs,
  ProductionBatchResponse,
  TerroirResponse,
  WalletResponse,
  WineAgingResponse,
  WineryResponse,
} from '../schemas'
import { resetSessions } from './sessions'

// Base de datos en memoria de los handlers: una copia de los fixtures que las mutaciones
// modifican durante la sesión. `resetErpDb()` la devuelve al estado inicial.
//
// En el navegador, la identidad (bodegas, personas, billeteras), el estado de la Ola 1
// (`backoffice`), el reloj y los contadores se guardan además en localStorage
// (`doc-mocks:state`) tras cada escritura, para que los flujos de la Ola 1 sobrevivan a una
// recarga igual que las sesiones. Los registros de trazabilidad del ERP siguen solo en memoria.

/** Instante inicial del reloj fijo de los mocks. */
export const CLOCK_START = Date.parse(`${REFERENCE_DAY}T12:00:00Z`)

/** Estado de la Ola 1 (back office, invitaciones, configuración, bitácora, buzón…). */
export interface BackofficeState {
  applications: StoredApplication[]
  invitations: StoredInvitation[]
  profiles: WineryProfile[]
  blocks: MemberBlock[]
  mfa: StaffMfa[]
  settings: StoredSetting[]
  overrides: StoredOverride[]
  settingHistory: StoredSettingHistory[]
  alerts: DashboardAlert[]
  audit: AuditEvent[]
  mailbox: MockEmail[]
  /** Retos de segundo factor (`mfaToken`): caducan con el reloj de los mocks (5 min). */
  mfaTokens: Record<string, { userId: string; expiresAt: number; secret: string | null }>
  /** Códigos TOTP fallidos seguidos por persona (5 → 429). */
  mfaFailures: Record<string, number>
  /** Enlaces de recuperación de contraseña (un solo uso, 60 min). */
  resetTokens: Record<string, { userId: string; expiresAt: number; usedAt: string | null }>
  /** Enlaces de verificación de correo (cuenta). */
  emailTokens: Record<string, { userId: string; usedAt: string | null }>
  /** Preferencias de perfil (IAM-09). */
  prefs: Record<string, { notificationPrefs: NotificationPrefs; promotionsConsent: boolean }>
  /** Motivo del bloqueo de la cuenta completa por persona. */
  accountBlocks: Record<string, string | null>
  /** Fecha del bloqueo de la cuenta completa por persona (`GET /v1/platform/accounts/{userId}`). */
  accountBlockedAt?: Record<string, string>
}

export interface ErpDb {
  wineries: WineryResponse[]
  users: MockUser[]
  wallets: WalletResponse[]
  terroirs: TerroirResponse[]
  harvestBatches: HarvestBatchResponse[]
  tanks: FermentationTankResponse[]
  /** Lecturas (filas de la semilla; las altas guardan además la persona que la registró). */
  logs: Array<FermentationLogRecord & { recordedByUserId?: string }>
  /** Tratamientos (filas de la semilla; las altas guardan además el miembro que lo autorizó). */
  treatments: Array<EnologicalTreatmentRecord & { authorizedByMemberId?: string }>
  wineAgings: WineAgingResponse[]
  productionBatches: ProductionBatchResponse[]
  bottlings: BottlingBatchResponse[]
  labAnalyses: BatchLabAnalysisResponse[]
  /** Estado de la Ola 1. */
  backoffice: BackofficeState
  /** Reloj fijo (ms). Avanza un minuto con cada alta. */
  clock: number
  /** Contadores por recurso para ids deterministas. */
  counters: Record<string, number>
}

function createBackofficeState(): BackofficeState {
  const f = structuredClone(backofficeFixtures)
  return {
    applications: f.applications,
    invitations: f.invitations,
    profiles: f.wineryProfiles,
    blocks: f.memberBlocks,
    mfa: f.staffMfa,
    settings: f.settings,
    overrides: f.settingOverrides,
    settingHistory: f.settingHistory,
    alerts: f.alerts,
    audit: f.audit,
    mailbox: f.mailbox,
    mfaTokens: {},
    mfaFailures: {},
    resetTokens: {},
    emailTokens: {},
    prefs: {},
    accountBlocks: {},
    accountBlockedAt: {},
  }
}

// ---------------------------------------------------------------------------
// Persistencia en el navegador
// ---------------------------------------------------------------------------

const STATE_KEY = 'doc-mocks:state'
/** Cambia con los fixtures: un estado guardado con otros fixtures se descarta. */
const STATE_VERSION = `0.3:${backofficeFixtures.audit.at(-1)?.hash.slice(0, 16) ?? ''}:${erpFixtures.users.length}`

interface PersistedState {
  version: string
  clock: number
  counters: Record<string, number>
  wineries: WineryResponse[]
  users: MockUser[]
  wallets: WalletResponse[]
  backoffice: BackofficeState
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' || typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function loadPersisted(): PersistedState | null {
  try {
    const raw = storage()?.getItem(STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedState
    return parsed.version === STATE_VERSION ? parsed : null
  } catch {
    return null
  }
}

function createErpDb(fresh = false): ErpDb {
  const f = structuredClone(erpFixtures)
  const db: ErpDb = {
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
    backoffice: createBackofficeState(),
    clock: CLOCK_START,
    counters: {},
  }
  const saved = fresh ? null : loadPersisted()
  if (saved) {
    Object.assign(db, {
      wineries: saved.wineries,
      users: saved.users,
      wallets: saved.wallets,
      backoffice: { ...db.backoffice, ...saved.backoffice },
      clock: saved.clock,
      counters: saved.counters,
    })
  }
  return db
}

let db: ErpDb = createErpDb()

/** Base de datos actual de los handlers (para pruebas y herramientas de desarrollo). */
export function getErpDb(): ErpDb {
  return db
}

/** Guarda la identidad y el estado de la Ola 1 en localStorage (solo en el navegador). */
export function persistErpDb(): void {
  const store = storage()
  if (!store) return
  const state: PersistedState = {
    version: STATE_VERSION,
    clock: db.clock,
    counters: db.counters,
    wineries: db.wineries,
    users: db.users,
    wallets: db.wallets,
    backoffice: db.backoffice,
  }
  try {
    store.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // cuota llena o almacenamiento bloqueado: basta con la memoria
  }
}

/** Descarta los cambios: vuelve a los fixtures, reinicia el reloj y cierra todas las sesiones. */
export function resetErpDb(): void {
  try {
    storage()?.removeItem(STATE_KEY)
  } catch {
    // sin almacenamiento
  }
  db = createErpDb(true)
  resetSessions()
}

/** Fecha y hora actual del reloj con milisegundos (para `timestamp` del envoltorio). */
export function nowIso(): string {
  return new Date(db.clock).toISOString()
}

/** Instante actual del reloj en el formato de los fixtures (`…:SSZ`), sin avanzarlo. */
export function nowStamp(): string {
  return new Date(db.clock).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Avanza el reloj un minuto y devuelve la marca en el formato de los fixtures (`…:SSZ`). */
export function tick(): string {
  db.clock += 60_000
  return new Date(db.clock).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Adelanta el reloj de los mocks (p. ej. para que caduque una invitación, un enlace de
 * recuperación o un reto TOTP en una prueba). No afecta al TOTP, que usa la hora real.
 */
export function advanceMockClock(ms: number): void {
  db.clock += Math.max(0, ms)
  persistErpDb()
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
