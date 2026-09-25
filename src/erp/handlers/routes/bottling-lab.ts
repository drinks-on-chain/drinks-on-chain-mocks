import { dayFromIso, dayParts, isoDay, normalizeDateTime } from '../../../shared/dates'
import { fakeHash64 } from '../../../shared/uuid'
import { WINERY_CODES_BY_ID } from '../../catalog'
import { deriveRestStatus } from '../../lot-view'
import {
  CreateBatchLabAnalysisSchema,
  CreateBottlingBatchSchema,
  PRODUCT_TYPES,
  type BatchLabAnalysisResponse,
  type BottlingBatchResponse,
} from '../../schemas'
import { canSee, members, roles, scoped, type AuthContext } from '../auth-context'
import { getErpDb, newId, tick, today } from '../db'
import { conflict, notFound, unprocessable } from '../errors'
import { boolParam, created, enumParam, listResult, ok, parseBody, type RouteSpec } from '../http'
import { requireWinery } from './terroirs-harvest'
import { findAging, findProduction } from './winemaking'

// /v1/bottling* y /v1/lab-analyses*

export function findBottling(auth: AuthContext | null, id: string): BottlingBatchResponse {
  const b = getErpDb().bottlings.find((x) => x.id === id)
  if (!b || (auth && !canSee(auth, b.wineryId))) throw notFound(`Lote de embotellado con identificador "${id}" no encontrado`)
  return b
}

/** Código de bodega para el lote: catálogo fijo o tres primeras letras del nombre comercial. */
function wineryCode(wineryId: string): string {
  const known = WINERY_CODES_BY_ID[wineryId]
  if (known) return known
  const w = getErpDb().wineries.find((x) => x.id === wineryId)
  const letters = (w?.commercialName ?? 'DOC')
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
  return (letters.replace(/^(BODEGA|DESTILERIA|VINEDOS)/, '') || letters).slice(0, 3).padEnd(3, 'X')
}

/** `{BODEGA}-{AÑO}-{TIPO}-{SEQ}`; la secuencia es por bodega y año (como en los fixtures). */
function nextLotCode(wineryId: string, year: number, productType: string): string {
  const code = wineryCode(wineryId)
  const prefix = `${code}-${year}-`
  const seqs = getErpDb()
    .bottlings.filter((b) => b.internationalLotCode.startsWith(prefix))
    .map((b) => Number(b.internationalLotCode.split('-').at(-1)))
    .filter((n) => Number.isFinite(n))
  const seq = (seqs.length ? Math.max(...seqs) : 0) + 1
  return `${prefix}${productType}-${String(seq).padStart(3, '0')}`
}

export const bottlingLabRoutes: RouteSpec[] = [
  {
    method: 'post',
    path: '/v1/bottling',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST']),
    async handle({ request, auth }) {
      requireWinery(auth)
      const body = await parseBody(request, CreateBottlingBatchSchema)
      const todayDay = today()
      let wineryId: string
      let markBottled: () => void
      if (body.wineAgingBatchId) {
        const aging = findAging(auth, body.wineAgingBatchId)
        if (aging.agingStatus === 'BOTTLED' || aging.agingStatus === 'DISCARDED') {
          throw unprocessable(`El lote de crianza ya está en estado ${aging.agingStatus}`)
        }
        const lockDay = dayFromIso(aging.lockUntilDate)
        if (todayDay < lockDay) {
          throw unprocessable(`El vino se encuentra bloqueado por período de crianza hasta el ${isoDay(lockDay)}`, [
            `lockUntilDate: ${aging.lockUntilDate}`,
            `daysRemaining: ${lockDay - todayDay}`,
          ])
        }
        wineryId = aging.wineryId
        markBottled = () => {
          aging.agingStatus = 'BOTTLED'
        }
      } else {
        const production = findProduction(auth, body.productionBatchId!)
        if (production.restStatus === 'BOTTLED' || production.restStatus === 'DISCARDED') {
          throw unprocessable(`El lote de destilación ya está en estado ${production.restStatus}`)
        }
        if (production.restStatus !== 'NOT_REQUIRED') {
          const rest = deriveRestStatus(production, { today: isoDay(todayDay) })
          if (!rest.isRestCompleted) {
            throw unprocessable(
              `Reglas D.O. incumplidas: reposo inerte de ${rest.daysElapsed} días (mínimo 180, faltan ${rest.daysRemaining})`,
              [`mandatoryRestUntil: ${production.mandatoryRestUntil ?? ''}`, `daysRemaining: ${rest.daysRemaining}`],
            )
          }
        }
        wineryId = production.wineryId
        markBottled = () => {
          production.restStatus = 'BOTTLED'
        }
      }
      const bottlingDate = normalizeDateTime(body.bottlingDate)
      const lot = nextLotCode(wineryId, dayParts(dayFromIso(bottlingDate)).year, body.productType)
      const id = newId('bottling')
      const bottling: BottlingBatchResponse = {
        id,
        wineryId,
        wineAgingBatchId: body.wineAgingBatchId ?? null,
        productionBatchId: body.productionBatchId ?? null,
        productType: body.productType,
        internationalLotCode: lot,
        finalAlcoholAbv: body.finalAlcoholAbv,
        waterDilutionLiters: body.waterDilutionLiters ?? null,
        totalBottlesPackaged: body.totalBottlesPackaged,
        packagingFormatCl: body.packagingFormatCl,
        bottleType: body.bottleType ?? null,
        labelDesignUrl: body.labelDesignUrl ?? null,
        bottlingDate,
        releasedByMemberId: auth.memberId,
        blockchainAnchorTxHash: null,
        blockchainDataHash: fakeHash64(`data:${id}`),
        isAnchoredOnChain: false,
        anchoredAt: null,
        qrBatchUrl: `https://app.drinksonchain.bo/b/${lot}`,
        createdAt: tick(),
      }
      markBottled()
      getErpDb().bottlings.push(bottling)
      return created(bottling)
    },
  },
  {
    method: 'get',
    path: '/v1/bottling',
    access: members,
    list: 'paged',
    handle({ query, auth }) {
      const productType = enumParam(query, 'productType', PRODUCT_TYPES)
      const anchored = boolParam(query, 'isAnchoredOnChain')
      const items = scoped(auth, getErpDb().bottlings).filter(
        (b) => (!productType || b.productType === productType) && (anchored === undefined || b.isAnchoredOnChain === anchored),
      )
      return listResult(items, query)
    },
  },
  {
    method: 'get',
    path: '/v1/bottling/:id',
    access: members,
    handle: ({ auth, params }) => ok(findBottling(auth, params.id!)),
  },

  // ----- Laboratorio -----
  {
    method: 'post',
    path: '/v1/lab-analyses',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST', 'PLATFORM_ADMIN']),
    async handle({ request, auth }) {
      const body = await parseBody(request, CreateBatchLabAnalysisSchema)
      const bottling = findBottling(auth, body.bottlingBatchId)
      const db = getErpDb()
      if (db.labAnalyses.some((l) => l.bottlingBatchId === bottling.id)) {
        throw conflict('El lote ya tiene un informe oficial registrado')
      }
      const lab: BatchLabAnalysisResponse = {
        id: newId('lab'),
        bottlingBatchId: bottling.id,
        certifiedLaboratoryName: body.certifiedLaboratoryName,
        accreditedLabCertificationCode: body.accreditedLabCertificationCode,
        analysisRequestDate: body.analysisRequestDate ? normalizeDateTime(body.analysisRequestDate) : null,
        testPerformedAt: normalizeDateTime(body.testPerformedAt),
        actualAlcoholAbv: body.actualAlcoholAbv,
        totalAlcoholAbv: body.totalAlcoholAbv ?? null,
        totalAcidityTartaricGl: body.totalAcidityTartaricGl,
        volatileAcidityAceticGl: body.volatileAcidityAceticGl,
        freeSulfurDioxideMgL: body.freeSulfurDioxideMgL ?? null,
        totalSulfurDioxideMgL: body.totalSulfurDioxideMgL ?? null,
        reducingSugarsGl: body.reducingSugarsGl ?? null,
        totalDryExtractGl: body.totalDryExtractGl ?? null,
        sugarFreeDryExtractGl: body.sugarFreeDryExtractGl ?? null,
        overpressureBar: body.overpressureBar ?? null,
        methanolContentMgL: body.methanolContentMgL ?? null,
        copperContentMgL: body.copperContentMgL ?? null,
        additionalParams: body.additionalParams ?? null,
        laboratoryReportPdfUrl: body.laboratoryReportPdfUrl,
        conformsToSenasagStandards: body.conformsToSenasagStandards ?? false,
        conformsToEuStandards: body.conformsToEuStandards ?? false,
        conformsToUsaStandards: body.conformsToUsaStandards ?? false,
        reviewedByMemberId: auth.memberId,
        createdAt: tick(),
      }
      db.labAnalyses.push(lab)
      return created(lab)
    },
  },
  {
    method: 'get',
    path: '/v1/lab-analyses/batch/:bottlingBatchId',
    access: roles(['WINERY_ADMIN', 'ENOLOGIST', 'AGRONOMIST', 'PLATFORM_ADMIN', 'CONSUMER']),
    handle({ auth, params }) {
      // Los consumidores leen cualquier certificado (también aparece en el pasaporte público).
      const bottling = findBottling(auth.role === 'CONSUMER' ? null : auth, params.bottlingBatchId!)
      const lab = getErpDb().labAnalyses.find((l) => l.bottlingBatchId === bottling.id)
      if (!lab) throw notFound(`Informe analítico del lote "${bottling.internationalLotCode}" no encontrado`)
      return ok(lab)
    },
  },
]
