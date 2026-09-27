import type {
  BottlingBatchDetail,
  BottlingBatchResponse,
  EnologicalTreatment,
  FermentationLog,
  FermentationTankDetail,
  FermentationTankResponse,
  FermentationTankWithHarvest,
  HarvestBatchDetail,
  HarvestBatchResponse,
  ProductionBatchDetail,
  ProductionBatchResponse,
  TerroirDetail,
  TerroirResponse,
  WineAgingDetail,
  WineAgingResponse,
} from '../schemas'
import { getErpDb, type ErpDb } from './db'

// Respuestas del ERP con las relaciones que incluye el backend (los `include` de Prisma de cada
// servicio; ver src/erp/schemas/details.ts). Las filas de la base de los mocks no las guardan.

const desc = <T>(key: (x: T) => string) => (a: T, b: T) => key(b).localeCompare(key(a))
const asc = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b))

/** Persona (`userId`) de un miembro de bodega. */
function userOfMember(db: ErpDb, memberId: string | null | undefined): string | undefined {
  if (!memberId) return undefined
  for (const w of db.wineries) {
    const m = w.members?.find((x) => x.id === memberId)
    if (m) return m.userId
  }
  return undefined
}

/**
 * Quién autoriza los tratamientos de la semilla (los fixtures no lo guardan): el enólogo activo
 * de la bodega o, si no hay, el dueño (como la semilla del backend).
 */
function treatmentAuthorizer(db: ErpDb, tankId: string): string {
  const tank = db.tanks.find((t) => t.id === tankId)
  const members = db.wineries.find((w) => w.id === tank?.wineryId)?.members?.filter((m) => m.isActive) ?? []
  return (members.find((m) => m.memberRole === 'ENOLOGIST') ?? members.find((m) => m.memberRole === 'OWNER'))?.id ?? ''
}

/** `FermentationLogResponseDto` de una lectura guardada. */
export function logView(log: ErpDb['logs'][number], db: ErpDb = getErpDb()): FermentationLog {
  return {
    id: log.id,
    fermentationTankId: log.fermentationTankId,
    temperatureCelsius: log.temperatureCelsius,
    specificGravity: log.specificGravity ?? null,
    phValue: log.phValue ?? null,
    co2Observations: log.co2Observations ?? null,
    recordedAt: log.recordedAt,
    recordedByUserId: log.recordedByUserId ?? userOfMember(db, log.recordedByMemberId) ?? '',
    notes: log.notes ?? null,
  }
}

/** `EnologicalTreatmentResponseDto` de un tratamiento guardado. */
export function treatmentView(t: ErpDb['treatments'][number], db: ErpDb = getErpDb()): EnologicalTreatment {
  return {
    id: t.id,
    fermentationTankId: t.fermentationTankId,
    treatmentType: t.treatmentType,
    additiveName: t.additiveName,
    additiveSupplier: t.additiveSupplier ?? null,
    dosageAppliedGPerHl: t.dosageAppliedGPerHl,
    totalAppliedG: t.totalAppliedG ?? null,
    regulatoryAuthCode: t.regulatoryAuthCode,
    appliedAt: t.appliedAt,
    authorizedByMemberId: t.authorizedByMemberId ?? treatmentAuthorizer(db, t.fermentationTankId),
    notes: t.notes ?? null,
  }
}

const terroirOf = (db: ErpDb, id: string) => db.terroirs.find((t) => t.id === id)
const harvestOf = (db: ErpDb, id: string) => db.harvestBatches.find((h) => h.id === id)
const tankOf = (db: ErpDb, id: string) => db.tanks.find((t) => t.id === id)

/** `GET /v1/terroirs/:id`: con sus lotes de vendimia (más recientes primero). */
export function terroirDetail(t: TerroirResponse, db: ErpDb = getErpDb()): TerroirDetail {
  return { ...t, harvestBatches: db.harvestBatches.filter((h) => h.terroirId === t.id).sort(desc((h) => h.intakeDate)) }
}

/** `GET /v1/harvest-batches` (con `terroir`) y `/:id` (además `fermentationTanks`). */
export function harvestView(h: HarvestBatchResponse, detail = false, db: ErpDb = getErpDb()): HarvestBatchDetail {
  const terroir = terroirOf(db, h.terroirId)
  return {
    ...h,
    ...(terroir && { terroir }),
    ...(detail && { fermentationTanks: db.tanks.filter((t) => t.harvestBatchId === h.id) }),
  }
}

/** `GET /v1/fermentation-tanks` (con `harvestBatch`) y `/:id` (además lecturas y tratamientos, en orden cronológico). */
export function tankView(t: FermentationTankResponse, detail = false, db: ErpDb = getErpDb()): FermentationTankDetail {
  const harvestBatch = harvestOf(db, t.harvestBatchId)
  return {
    ...t,
    ...(harvestBatch && { harvestBatch }),
    ...(detail && {
      logs: db.logs.filter((l) => l.fermentationTankId === t.id).sort(asc((l) => l.recordedAt)).map((l) => logView(l, db)),
      treatments: db.treatments.filter((x) => x.fermentationTankId === t.id).sort(asc((x) => x.appliedAt)).map((x) => treatmentView(x, db)),
    }),
  }
}

/** Cuba con su vendimia y la parcela de esta (detalles de crianza, destilación y embotellado). */
function tankWithChain(db: ErpDb, id: string): FermentationTankWithHarvest | undefined {
  const tank = tankOf(db, id)
  if (!tank) return undefined
  const harvest = harvestOf(db, tank.harvestBatchId)
  const terroir = harvest ? terroirOf(db, harvest.terroirId) : undefined
  return { ...tank, ...(harvest && { harvestBatch: { ...harvest, ...(terroir && { terroir }) } }) }
}

/** `GET /v1/wine-aging` (con `fermentationTank`) y `/:id` (cuba con su cadena + `bottlingBatches`). */
export function agingView(a: WineAgingResponse, detail = false, db: ErpDb = getErpDb()): WineAgingDetail {
  const fermentationTank = detail ? tankWithChain(db, a.fermentationTankId) : tankOf(db, a.fermentationTankId)
  return {
    ...a,
    ...(fermentationTank && { fermentationTank }),
    ...(detail && { bottlingBatches: db.bottlings.filter((b) => b.wineAgingBatchId === a.id) }),
  }
}

/** `GET /v1/production-batches` (con `fermentationTank`) y `/:id` (cuba con su cadena + `bottlingBatches`). */
export function productionView(p: ProductionBatchResponse, detail = false, db: ErpDb = getErpDb()): ProductionBatchDetail {
  const fermentationTank = detail ? tankWithChain(db, p.fermentationTankId) : tankOf(db, p.fermentationTankId)
  return {
    ...p,
    ...(fermentationTank && { fermentationTank }),
    ...(detail && { bottlingBatches: db.bottlings.filter((b) => b.productionBatchId === p.id) }),
  }
}

/** `GET /v1/bottling` (con `labAnalysis`) y `/:id` (además el origen con su cadena). */
export function bottlingView(b: BottlingBatchResponse, detail = false, db: ErpDb = getErpDb()): BottlingBatchDetail {
  const labAnalysis = db.labAnalyses.find((l) => l.bottlingBatchId === b.id) ?? null
  if (!detail) return { ...b, labAnalysis }
  const aging = b.wineAgingBatchId ? db.wineAgings.find((a) => a.id === b.wineAgingBatchId) : undefined
  const production = b.productionBatchId ? db.productionBatches.find((p) => p.id === b.productionBatchId) : undefined
  const chainOf = (tankId: string) => {
    const fermentationTank = tankWithChain(db, tankId)
    return fermentationTank ? { fermentationTank } : {}
  }
  return {
    ...b,
    labAnalysis,
    wineAgingBatch: aging ? { ...aging, ...chainOf(aging.fermentationTankId) } : null,
    productionBatch: production ? { ...production, ...chainOf(production.fermentationTankId) } : null,
  }
}
