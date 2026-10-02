import { sha256Hex } from '../../shared/crypto'
import type { BottlingBatchResponse, DagGraph, DagNode } from '../schemas'
import { currentLab, distillationHeart, harvestTerroir, lotDossier, type TraceState } from './state'

// Grafo DAG legado (`GET /v1/traceability/dag/{bottlingBatchId}` y `GET /v1/traceability/public/
// {lotCode}`), que sigue hasta H2 con los cierres de la apertura de la Ola 2 (EA-05): solo datos
// registrados (sin las métricas fijas 12,80 % y 0,28 g/L), `isCertified` = expediente cerrado y el
// operador real de la membresía que registró la etapa («No registrado» si no consta). Se retira
// por `GET /v1/lots/{id}/graph` y `GET /v1/public/passports/{code}`.

const dagHash = (input: string): string => `0x${sha256Hex(input)}`
/** `JSON.stringify(metadata, Object.keys(metadata).sort())` del backend: claves de primer nivel ordenadas. */
const metadataHash = (metadata: Record<string, unknown>): string => dagHash(JSON.stringify(metadata, Object.keys(metadata).sort()))
const scaled = (...values: (number | null | undefined)[]): number[] => (values.every((v) => v !== null && v !== undefined) ? values.map((v) => Math.round((v as number) * 100)) : [])

export function legacyDagGraph(state: TraceState, b: BottlingBatchResponse): DagGraph {
  const wineryName = state.wineries.find((w) => w.id === b.wineryId)?.commercialName ?? ''
  const aging = b.wineAgingBatchId ? state.wineAgings.find((x) => x.id === b.wineAgingBatchId) : undefined
  const production = !aging && b.productionBatchId ? state.productionBatches.find((x) => x.id === b.productionBatchId) : undefined
  const intermediate = aging ?? production
  const tank = intermediate ? state.tanks.find((x) => x.id === intermediate.fermentationTankId) : undefined
  const harvest = tank ? state.harvestBatches.find((x) => x.id === tank.harvestBatchId) : undefined
  const terroir = harvest ? state.terroirs.find((x) => x.id === harvest.terroirId) : undefined
  const lab = b.lotId ? currentLab(state, b.lotId) : state.labAnalyses.filter((l) => l.bottlingBatchId === b.id).at(-1)
  const isCertified = b.lotId ? lotDossier(state, b.lotId)?.status === 'CLOSED' : false
  /** Quien registró la etapa, según la línea de tiempo del lote. */
  const operator = (resourceId: string | undefined) => {
    const actor = resourceId ? state.lotEvents.filter((e) => e.lotId === b.lotId && e.resource.id === resourceId && e.actor).sort((x, y) => x.seq - y.seq)[0]?.actor : null
    return { name: actor?.fullName ?? 'No registrado', role: actor?.role ?? 'NOT_RECORDED', wineryName }
  }
  const nodes: DagNode[] = []
  let plotHash = ''
  let harvestHash = ''
  let vinificationHash = ''
  let intermediateHash = ''

  if (terroir && harvest) {
    const snapshot = harvestTerroir(state, harvest)
    plotHash = dagHash(`TERROIR-${terroir.id}`)
    const details = { parcelName: snapshot.parcelName, varietyName: snapshot.varietyName, altitudeMasl: snapshot.altitudeMasl, surfaceHectares: terroir.surfaceHectares, isDoEligible: terroir.isDoEligible }
    nodes.push({ batchId: plotHash, stage: 0, stageName: 'Plot', parents: [], timestamp: terroir.createdAt, volumeOrUnits: terroir.surfaceHectares, metrics: scaled(snapshot.altitudeMasl), metadataHash: metadataHash(details), isCertified, operator: operator(undefined), details })
  }
  if (harvest) {
    harvestHash = dagHash(`HARVEST-${harvest.id}`)
    const details = {
      harvestBatchCode: harvest.harvestBatchCode,
      grossWeightKg: harvest.grossWeightKg,
      tareWeightKg: harvest.tareWeightKg,
      netWeightKg: harvest.netWeightKg,
      brixDegrees: harvest.brixDegrees,
      initialPh: harvest.initialPh,
      initialAcidityGl: harvest.initialAcidityGl,
      phytosanitaryStatus: harvest.phytosanitaryStatus,
    }
    nodes.push({
      batchId: harvestHash,
      stage: 1,
      stageName: 'Harvest',
      parents: plotHash ? [plotHash] : [],
      timestamp: harvest.intakeDate,
      volumeOrUnits: harvest.netWeightKg,
      metrics: scaled(harvest.brixDegrees, harvest.initialPh, harvest.initialAcidityGl),
      metadataHash: metadataHash(details),
      isCertified,
      operator: operator(harvest.id),
      details,
    })
  }
  if (tank) {
    vinificationHash = dagHash(`TANK-${tank.id}`)
    const details = { tankCode: tank.tankCode, material: tank.material ?? null, volumeFilledLiters: tank.volumeFilledLiters ?? null, destinationType: tank.destinationType ?? null }
    // Sin métricas de relleno: el vino base no tiene análisis registrado en el tanque.
    nodes.push({ batchId: vinificationHash, stage: 2, stageName: 'Vinification', parents: harvestHash ? [harvestHash] : [], timestamp: tank.startDate, volumeOrUnits: tank.volumeFilledLiters ?? 0, metrics: [], metadataHash: metadataHash(details), isCertified, operator: operator(tank.id), details })
  }
  if (aging) {
    intermediateHash = dagHash(`AGING-${aging.id}`)
    const details = { containerType: aging.containerType, containerMaterial: aging.containerMaterial ?? null, plannedMonths: aging.plannedMonths, lockUntilDate: aging.lockUntilDate.slice(0, 10) }
    nodes.push({ batchId: intermediateHash, stage: 3, stageName: 'Aging', parents: vinificationHash ? [vinificationHash] : [], timestamp: aging.createdAt, volumeOrUnits: aging.volumeLiters ?? 0, metrics: scaled(aging.plannedMonths), metadataHash: metadataHash(details), isCertified, operator: operator(aging.id), details })
  } else if (production) {
    intermediateHash = dagHash(`DISTILLATION-${production.id}`)
    const heart = distillationHeart(production)
    const details = {
      equipmentIdentifier: production.equipmentIdentifier,
      inputVolumeLiters: production.inputVolumeLiters ?? null,
      outputVolumeLiters: heart.liters,
      wasteVolumeLiters: production.wasteVolumeLiters ?? null,
      initialAlcoholPercentage: heart.abv,
      restStatus: production.restStatus,
    }
    nodes.push({
      batchId: intermediateHash,
      stage: 4,
      stageName: 'Distillation',
      parents: vinificationHash ? [vinificationHash] : [],
      timestamp: production.processStartDate,
      volumeOrUnits: heart.liters ?? 0,
      metrics: scaled(heart.abv),
      metadataHash: metadataHash(details),
      isCertified,
      operator: operator(production.id),
      details,
    })
  }
  const rootBatchId = dagHash(`BOTTLING-${b.id}`)
  const bottlingDetails = {
    internationalLotCode: b.internationalLotCode,
    productType: b.productType,
    finalAlcoholAbv: b.finalAlcoholAbv,
    waterDilutionLiters: b.waterDilutionLiters ?? null,
    totalBottlesPackaged: b.totalBottlesPackaged,
    packagingFormatCl: b.packagingFormatCl,
    qrBatchUrl: b.qrBatchUrl ?? null,
  }
  nodes.push({
    batchId: rootBatchId,
    stage: 5,
    stageName: 'Bottling',
    parents: intermediateHash ? [intermediateHash] : [],
    timestamp: b.bottlingDate,
    volumeOrUnits: b.totalBottlesPackaged,
    metrics: [Math.round(b.finalAlcoholAbv * 100), b.packagingFormatCl * 10],
    metadataHash: metadataHash(bottlingDetails),
    isCertified,
    operator: operator(b.id),
    details: {
      ...bottlingDetails,
      labAnalysis: lab
        ? {
            certifiedLaboratoryName: lab.certifiedLaboratoryName,
            accreditedLabCertificationCode: lab.accreditedLabCertificationCode,
            actualAlcoholAbv: lab.actualAlcoholAbv,
            methanolContentMgL: lab.methanolContentMgL ?? null,
            conformsToSenasagStandards: lab.conformsToSenasagStandards,
          }
        : null,
    },
  })
  return { rootBatchId, internationalLotCode: b.internationalLotCode, productType: b.productType, nodes }
}
