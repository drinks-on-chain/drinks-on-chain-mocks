import { getMockAppUrls, lotPrefixOf } from '../../backoffice/handlers/support'
import { getScenario, isDataScenario, type DataScenarioName } from '../../shared/scenarios'
import { WINERY_CODES_BY_ID } from '../catalog'
import type { TraceActor } from '../schemas'
import { laPazDate } from '../trace/dates'
import { injectMigrationIssue, resetSinganiCase } from '../trace/demo'
import { takeSettingsSnapshot } from '../trace/rules'
import { releaseLocks, type TraceCtx } from '../trace/state'
import type { AuthContext } from './auth-context'
import { getErpDb, newId, nowStamp, TRACE_KEYS, traceFromFixtures, type ErpDb } from './db'

// Puente entre los handlers y los servicios puros de `src/erp/trace/`: contexto de cada operación
// (reloj de los mocks, autor, ids y configuración vigente), deshacer una escritura que falla, la
// tarea diaria de los candados y los escenarios de datos de la Ola 2.

/**
 * Prefijo de lote de la bodega: el asignado al activarse (Ola 1, ORIGIN-05), el del catálogo fijo
 * o las tres primeras letras de su nombre comercial.
 */
export function lotPrefixFor(wineryId: string): string {
  const known = lotPrefixOf(wineryId) ?? WINERY_CODES_BY_ID[wineryId]
  if (known) return known
  const w = getErpDb().wineries.find((x) => x.id === wineryId)
  const letters = (w?.commercialName ?? 'DOC')
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
  return (letters.replace(/^(BODEGA|DESTILERIA|VINEDOS)/, '') || letters).slice(0, 3).padEnd(3, 'X')
}

/** Membresía de la bodega que actúa (`null` = plataforma o sistema). */
export function actorOfAuth(auth: AuthContext | null): TraceActor | null {
  if (!auth?.memberId || !auth.memberRole) return null
  return { membershipId: auth.memberId, userId: auth.user.id, fullName: auth.user.fullName, role: auth.memberRole }
}

/**
 * Contexto de una operación de trazabilidad. `now` es el reloj de los mocks en este instante: tras
 * una escritura que lo avanza (`tick()`), pide un contexto nuevo.
 */
export function traceCtx(auth: AuthContext | null = null): TraceCtx {
  const db = getErpDb()
  const now = nowStamp()
  return {
    now,
    today: laPazDate(db.clock),
    actor: actorOfAuth(auth),
    newId,
    // El QR apunta al Marketplace de la app (`setMockAppUrls` / opción `appUrls`).
    passportBaseUrl: getMockAppUrls().MARKETPLACE,
    snapshot: (wineryId) => takeSettingsSnapshot(db.backoffice.settings, db.backoffice.overrides, wineryId, now),
    lotPrefix: lotPrefixFor,
  }
}

type TraceBackup = Pick<ErpDb, (typeof TRACE_KEYS)[number]>

/** Copia de la trazabilidad antes de una escritura (los servicios cambian el estado paso a paso). */
export function backupTrace(): TraceBackup {
  const db = getErpDb()
  return structuredClone(Object.fromEntries(TRACE_KEYS.map((k) => [k, db[k]]))) as TraceBackup
}

/** Deshace una escritura que falló a medias: como la transacción del backend, o todo o nada. */
export function restoreTrace(backup: TraceBackup): void {
  Object.assign(getErpDb(), backup)
}

/** Tarea diaria `trace.locks.release` (§15): corre una vez por día del reloj de los mocks (p. ej. tras `advanceMockClock`). */
export function runDailyTasks(): void {
  const db = getErpDb()
  const today = laPazDate(db.clock)
  if (db.locksReleasedOn === today) return
  db.locksReleasedOn = today
  releaseLocks(db, traceCtx(null))
}

/** Rehace la trazabilidad desde los fixtures y deja el lote de demostración en la etapa del escenario. */
function applyDataScenario(db: ErpDb, name: DataScenarioName | 'normal'): void {
  Object.assign(db, traceFromFixtures())
  db.locksReleasedOn = laPazDate(db.clock)
  const ctx = traceCtx(null)
  switch (name) {
    case 'lote-en-reposo':
      resetSinganiCase(db, ctx, { upTo: 'RESTING', closedDaysAgo: 170 })
      break
    case 'lote-listo':
      resetSinganiCase(db, ctx, { upTo: 'READY' })
      break
    case 'laboratorio-no-conforme':
      resetSinganiCase(db, ctx, { upTo: 'LAB', lab: 'NON_CONFORMING' })
      break
    case 'lote-con-incidencia':
      injectMigrationIssue(db, ctx)
      break
    case 'normal':
      break
  }
}

/**
 * Aplica el escenario de datos activo (`setScenario('lote-listo')`, `?mock=lote-listo`) si la base
 * aún no lo tiene. Volver a `normal` (o a un escenario que no es de datos) restaura los fixtures.
 */
export function syncDataScenario(): void {
  const db = getErpDb()
  const scenario = getScenario()
  const wanted = isDataScenario(scenario) ? scenario : 'normal'
  if (db.dataScenario === wanted) return
  applyDataScenario(db, wanted)
  db.dataScenario = wanted
}
