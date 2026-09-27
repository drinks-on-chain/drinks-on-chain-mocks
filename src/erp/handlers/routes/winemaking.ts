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
  type FermentationTankResponse,
  type ProductionBatchResponse,
  type WineAgingResponse,
} from '../../schemas'
import { canSee, scoped, winery, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick, today, type ErpDb } from '../db'
import { domainError, fieldError, forbidden, invalid, notFound, unprocessable } from '../errors'
import { created, enumParam, listResult, ok, parseCreateBody, strParam, type RouteSpec } from '../http'
import { agingView, logView, productionView, tankView, treatmentView } from '../views'
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

export const winemakingRoutes: RouteSpec[] = [
  // ----- Tanques de fermentación -----
  {
    method: 'post',
    path: '/v1/fermentation-tanks',
    access: winery(['OWNER', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseCreateBody(request, CreateFermentationTankSchema)
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
    access: winery(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT']),
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
      return listResult(items.map((t) => tankView(t)), query)
    },
  },
  {
    method: 'get',
    path: '/v1/fermentation-tanks/:id',
    access: winery(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT']),
    handle({ auth, params }) {
      return ok(tankView(findTank(auth, params.id!), true))
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/logs',
    access: winery(['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR']),
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseCreateBody(request, CreateFermentationLogSchema)
      const log: ErpDb['logs'][number] = {
        id: newId('log'),
        fermentationTankId: t.id,
        temperatureCelsius: body.temperatureCelsius,
        specificGravity: body.specificGravity ?? null,
        phValue: body.phValue ?? null,
        co2Observations: body.co2Observations ?? null,
        recordedAt: normalizeDateTime(body.recordedAt),
        notes: body.notes ?? null,
        recordedByMemberId: auth.memberId,
        // El backend guarda la persona (`recordedByUserId`), también la de la plataforma.
        recordedByUserId: auth.user.id,
      }
      tick()
      getErpDb().logs.push(log)
      return created(logView(log))
    },
  },
  {
    method: 'post',
    path: '/v1/fermentation-tanks/:id/treatments',
    access: winery(['OWNER', 'ENOLOGIST']),
    async handle({ request, auth, params }) {
      const t = findTank(auth, params.id!)
      const body = await parseCreateBody(request, CreateEnologicalTreatmentSchema)
      // Como el backend: lo autoriza un miembro activo de la bodega (la plataforma no puede).
      if (!auth.memberId) throw forbidden('El usuario no es miembro activo acreditado de esta bodega')
      const treatment: ErpDb['treatments'][number] = {
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
        authorizedByMemberId: auth.memberId,
      }
      tick()
      getErpDb().treatments.push(treatment)
      return created(treatmentView(treatment))
    },
  },

  // ----- Crianza -----
  {
    method: 'post',
    path: '/v1/wine-aging',
    access: winery(['OWNER', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseCreateBody(request, CreateWineAgingBatchSchema)
      const tank = findTank(auth, body.fermentationTankId)
      // Como el backend: una cuba solo pasa una vez a crianza.
      if (getErpDb().wineAgings.some((a) => a.fermentationTankId === tank.id)) {
        throw domainError(409, 'FERMENTATION_TANK_ALREADY_TRANSFERRED', `La cuba ${tank.tankCode} ya ha sido transferida a un lote de crianza previo`)
      }
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
    access: winery(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
    list: 'paged',
    handle: ({ query, auth }) => listResult(scoped(auth, getErpDb().wineAgings).map((a) => agingView(a)), query),
  },
  {
    method: 'get',
    path: '/v1/wine-aging/:id',
    access: winery(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
    handle: ({ auth, params }) => ok(agingView(findAging(auth, params.id!), true)),
  },

  // ----- Destilación y reposo -----
  {
    method: 'post',
    path: '/v1/production-batches/distillation',
    access: winery(['OWNER', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseCreateBody(request, CreateDistillationBatchSchema)
      const tank = findTank(auth, body.fermentationTankId)
      const db = getErpDb()
      // Balance de masa (backend): corazón + descarte no puede superar la entrada + 5 %.
      if (body.inputVolumeLiters && body.outputVolumeLiters && body.wasteVolumeLiters) {
        if (body.outputVolumeLiters + body.wasteVolumeLiters > body.inputVolumeLiters * 1.05) {
          throw invalid([
            fieldError(
              'outputVolumeLiters',
              `Balance de masa inconsistente: La suma de corazón (${body.outputVolumeLiters} L) y descarte (${body.wasteVolumeLiters} L) excede el volumen de entrada (${body.inputVolumeLiters} L)`,
            ),
          ])
        }
      }
      const isDoEligible = body.isDoEligible ?? false
      if (isDoEligible) {
        // Reglas D.O. Singani: la parcela de origen debe ser apta y estar a ≥ 1.600 m.
        const harvest = db.harvestBatches.find((h) => h.id === tank.harvestBatchId)
        const terroir = harvest ? db.terroirs.find((t) => t.id === harvest.terroirId) : undefined
        if (!terroir?.isDoEligible) {
          throw unprocessable('La parcela de origen no es apta para la Denominación de Origen', [
            fieldError('isDoEligible', `La parcela ${terroir?.parcelName ?? 'de origen'} no es apta para D.O.`),
          ])
        }
        if (terroir.altitudeMasl < DO_MIN_ALTITUDE_MASL) {
          throw unprocessable(
            `La D.O. Singani exige una altitud mínima de ${DO_MIN_ALTITUDE_MASL} m s. n. m. (parcela: ${terroir.altitudeMasl} m)`,
            [fieldError('isDoEligible', `Altitud ${terroir.altitudeMasl} m < ${DO_MIN_ALTITUDE_MASL} m`)],
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
    access: winery(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
    handle({ auth, params }) {
      const p = findProduction(auth, params.id!)
      return ok(deriveRestStatus(p, { today: isoDay(today()) }))
    },
  },
  {
    method: 'get',
    path: '/v1/production-batches/:id',
    access: winery(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
    handle: ({ auth, params }) => ok(productionView(findProduction(auth, params.id!), true)),
  },
  {
    method: 'get',
    path: '/v1/production-batches',
    access: winery(['OWNER', 'ENOLOGIST', 'ACCOUNTANT']),
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
      return listResult(items.map((p) => productionView(p)), query)
    },
  },
]
