import { addMonthsClamped, dayFromIso, isoAt, isoDay, normalizeDateTime } from '../../../shared/dates'
import { deriveRestStatus, SINGANI_REST_DAYS } from '../../lot-view'
import {
  CreateDistillationBatchSchema,
  CreateEnologicalTreatmentSchema,
  CreateFermentationLogSchema,
  CreateFermentationTankSchema,
  CreateWineAgingBatchSchema,
  DESTINATION_TYPES,
  PROCESS_TYPES,
  REST_STATUSES,
  TANK_STATUSES,
  type EnologicalTreatment,
  type FermentationLog,
  type FermentationTankDetail,
  type FermentationTankResponse,
  type ProductionBatchResponse,
  type WineAgingResponse,
} from '../../schemas'
import { canSee, members, roles, scoped, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick, today } from '../db'
import { notFound, unprocessable } from '../errors'
import { created, enumParam, listResult, ok, parseBody, strParam, type RouteSpec } from '../http'
import { findHarvest, requireWinery } from './terroirs-harvest'

// /v1/fermentation-tanks*, /v1/wine-aging*, /v1/production-batches*

/** Altitud mínima (m s. n. m.) para destilación con D.O. Singani. */
export const DO_MIN_ALTITUDE_MASL = 1600

export function findTank(auth: AuthContext, id: string): FermentationTankResponse {
  const t = getErpDb().tanks.find((x) => x.id === id)
  if (!t || !canSee(auth, t.wineryId)) throw notFound(`Cuba con identificador "${id}" no encontrada`)
  return t
}

export function findAging(auth: AuthContext, id: string): WineAgingResponse {
  const a = getErpDb().wineAgings.find((x) => x.id === id)
  if (!a || !canSee(auth, a.wineryId)) throw notFound(`Lote de crianza con identificador "${id}" no encontrado`)
  return a
}

export function findProduction(auth: AuthContext, id: string): ProductionBatchResponse {
  const p = getErpDb().productionBatches.find((x) => x.id === id)
  if (!p || !canSee(auth, p.wineryId)) throw notFound(`Lote de producción con identificador "${id}" no encontrado`)
  return p
}

const byDate = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b))

export const winemakingRoutes: RouteSpec[] = [
  // ----- Tanques de fermentación -----
  {
    method: 'post',
    path: '/v1/fermentation-tanks',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseBody(request, CreateFermentationTankSchema)
      const harvest = findHarvest(auth, body.harvestBatchId)
      const startDate = normalizeDateTime(body.startDate)
      const tank: FermentationTankResponse = {
        id: newId('tank'),
        wineryId: harvest.wineryId,
        harvestBatchId: harvest.id,
        tankCode: body.tankCode,
        capacityLiters: body.capacityLiters ?? null,
        material: body.material ?? null,
        volumeFilledLiters: body.volumeFilledLiters ?? null,
        destinationType: body.destinationType ?? null,
        status: body.status ?? 'FILLING',
        startDate,
        endDate: null,
        createdAt: tick(),
      }
      getErpDb().tanks.push(tank)
      return created(tank)
    },
  },
  {
    method: 'get',
    path: '/v1/fermentation-tanks',
    access: members,
    list: 'paged',
    handle({ query, auth }) {
      const status = enumParam(query, 'status', TANK_STATUSES)
      const destination = enumParam(query, 'destinationType', DESTINATION_TYPES)
      const harvestBatchId = strParam(query, 'harvestBatchId')
      const items = scoped(auth, getErpDb().tanks).filter(
        (t) =>
          (!status || t.status === status) &&
          (!destination || t.destinationType === destination) &&
          (!harvestBatchId || t.harvestBatchId === harvestBatchId),
      )
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/fermentation-tanks/:id',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST', 'AGRONOMIST'], { adminReads: true }),
    handle({ auth, params }) {
      const t = findTank(auth, params.id!)
      const db = getErpDb()
      const detail: FermentationTankDetail = {
        ...t,
        logs: db.logs.filter((l) => l.fermentationTankId === t.id).sort(byDate((l) => l.recordedAt)),
        treatments: db.treatments.filter((x) => x.fermentationTankId === t.id).sort(byDate((x) => x.appliedAt)),
      }
      return ok(detail)
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/logs',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST', 'POS_OPERATOR']),
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseBody(request, CreateFermentationLogSchema)
      const log: FermentationLog = {
        id: newId('log'),
        fermentationTankId: t.id,
        temperatureCelsius: body.temperatureCelsius,
        specificGravity: body.specificGravity ?? null,
        phValue: body.phValue ?? null,
        co2Observations: body.co2Observations ?? null,
        recordedAt: normalizeDateTime(body.recordedAt),
        notes: body.notes ?? null,
        recordedByMemberId: auth.memberId,
      }
      tick()
      getErpDb().logs.push(log)
      return created(log)
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/treatments',
    access: roles(['ENOLOGIST', 'WINERY_ADMIN']),
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseBody(request, CreateEnologicalTreatmentSchema)
      const treatment: EnologicalTreatment = {
        id: newId('treatment'),
        fermentationTankId: t.id,
        treatmentType: body.treatmentType,
        additiveName: body.additiveName,
        additiveSupplier: body.additiveSupplier ?? null,
        dosageAppliedGPerHl: body.dosageAppliedGPerHl,
        totalAppliedG: body.totalAppliedG ?? null,
        regulatoryAuthCode: body.regulatoryAuthCode,
        appliedAt: normalizeDateTime(body.appliedAt),
        notes: body.notes ?? null,
      }
      tick()
      getErpDb().treatments.push(treatment)
      return created(treatment)
    },
  },

  // ----- Crianza -----
  {
    method: 'post',
    path: '/v1/wine-aging',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseBody(request, CreateWineAgingBatchSchema)
      const tank = findTank(auth, body.fermentationTankId)
      const start = body.startDate ? dayFromIso(body.startDate) : today()
      const aging: WineAgingResponse = {
        id: newId('aging'),
        wineryId: tank.wineryId,
        fermentationTankId: tank.id,
        containerType: body.containerType,
        containerMaterial: body.containerMaterial ?? null,
        containerCode: body.containerCode ?? null,
        barrelUseCycle: body.barrelUseCycle ?? null,
        volumeLiters: body.volumeLiters ?? null,
        plannedMonths: body.plannedMonths,
        lockUntilDate: isoAt(addMonthsClamped(start, body.plannedMonths), 0),
        agingStatus: 'AGING',
        notes: body.notes ?? null,
        createdAt: tick(),
      }
      getErpDb().wineAgings.push(aging)
      return created(aging)
    },
  },
  {
    method: 'get',
    path: '/v1/wine-aging',
    access: members,
    list: 'paged',
    handle: ({ query, auth }) => listResult(scoped(auth, getErpDb().wineAgings), query),
  },
  {
    method: 'get',
    path: '/v1/wine-aging/:id',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST'], { adminReads: true }),
    handle: ({ auth, params }) => ok(findAging(auth, params.id!)),
  },

  // ----- Destilación y reposo -----
  {
    method: 'post',
    path: '/v1/production-batches/distillation',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseBody(request, CreateDistillationBatchSchema)
      const tank = findTank(auth, body.fermentationTankId)
      const db = getErpDb()
      const isDoEligible = body.isDoEligible ?? false
      if (isDoEligible) {
        // Reglas D.O. Singani: la parcela de origen debe ser apta y estar a ≥ 1.600 m.
        const harvest = db.harvestBatches.find((h) => h.id === tank.harvestBatchId)
        const terroir = harvest ? db.terroirs.find((t) => t.id === harvest.terroirId) : undefined
        if (!terroir?.isDoEligible) {
          throw unprocessable('La parcela de origen no es apta para la Denominación de Origen', [
            `terroir ${terroir?.parcelName ?? 'desconocido'}: isDoEligible = false`,
          ])
        }
        if (terroir.altitudeMasl < DO_MIN_ALTITUDE_MASL) {
          throw unprocessable(
            `La D.O. Singani exige una altitud mínima de ${DO_MIN_ALTITUDE_MASL} m s. n. m. (parcela: ${terroir.altitudeMasl} m)`,
            [`altitudeMasl ${terroir.altitudeMasl} < ${DO_MIN_ALTITUDE_MASL}`],
          )
        }
      }
      const end = body.processEndDate ?? body.processStartDate
      const production: ProductionBatchResponse = {
        id: newId('production'),
        wineryId: tank.wineryId,
        fermentationTankId: tank.id,
        processType: 'SINGANI_DISTILLATION',
        equipmentIdentifier: body.equipmentIdentifier,
        processStartDate: normalizeDateTime(body.processStartDate),
        processEndDate: body.processEndDate ? normalizeDateTime(body.processEndDate) : null,
        inputVolumeLiters: body.inputVolumeLiters ?? null,
        outputVolumeLiters: body.outputVolumeLiters ?? null,
        wasteVolumeLiters: body.wasteVolumeLiters ?? null,
        initialAlcoholPercentage: body.initialAlcoholPercentage ?? null,
        isDoEligible,
        mandatoryRestUntil: isoAt(dayFromIso(end) + SINGANI_REST_DAYS, 0),
        restStatus: 'RESTING',
        additionalParams: body.additionalParams ?? null,
        notes: body.notes ?? null,
        createdAt: tick(),
      }
      db.productionBatches.push(production)
      return created(production)
    },
  },
  {
    method: 'get',
    path: '/v1/production-batches/:id/rest-status',
    access: members,
    handle({ auth, params }) {
      const p = findProduction(auth, params.id!)
      return ok(deriveRestStatus(p, { today: isoDay(today()) }))
    },
  },
  {
    method: 'get',
    path: '/v1/production-batches/:id',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST'], { adminReads: true }),
    handle: ({ auth, params }) => ok(findProduction(auth, params.id!)),
  },
  {
    method: 'get',
    path: '/v1/production-batches',
    access: members,
    list: 'paged',
    handle({ query, auth }) {
      const processType = enumParam(query, 'processType', PROCESS_TYPES)
      const restStatus = enumParam(query, 'restStatus', REST_STATUSES)
      const tankId = strParam(query, 'fermentationTankId')
      const items = scoped(auth, getErpDb().productionBatches).filter(
        (p) =>
          (!processType || p.processType === processType) &&
          (!restStatus || p.restStatus === restStatus) &&
          (!tankId || p.fermentationTankId === tankId),
      )
      return listResult(items, query)
    },
  },
]
