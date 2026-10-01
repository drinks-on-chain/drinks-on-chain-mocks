import { PLATFORM_ORGANIZATION } from './catalog'
import type {
  AuthTokens,
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  FermentationTankResponse,
  HarvestBatchResponse,
  Membership,
  MockUser,
  ProductionBatchResponse,
  DagGraph,
  DagNode,
  SessionResponse,
  TerroirResponse,
  WineAgingResponse,
  WineryResponse,
} from './schemas'
import { sha256Hex } from '../shared/crypto'
import { uid } from '../shared/uuid'

// Respuestas compuestas que comparten el generador y los handlers MSW (funciones puras).

/** Vida del token de acceso en segundos (15 min, contrato de la Ola 0 §5). */
export const ACCESS_TOKEN_TTL_SECONDS = 900

/**
 * Membresías de una persona (contrato de la Ola 0 §4), en orden: plataforma antes que bodegas.
 * - `_mock.platformRole` → membresía de la organización de plataforma con ese rol.
 * - Cada `wineryMemberships[i]` → membresía `WINERY` con su rol; el id es el del miembro de la
 *   bodega; `isActive: false` → `BLOCKED`.
 * - Consumidores (y el cajero de demo) → ninguna (el POS llega en la Ola 5).
 */
export function deriveMemberships(user: MockUser, wineries: readonly WineryResponse[]): Membership[] {
  const out: Membership[] = []
  if (user._mock.platformRole) {
    out.push({
      id: uid(`membership:platform:${user.id}`),
      organizationId: PLATFORM_ORGANIZATION.id,
      organizationType: 'PLATFORM',
      organizationName: PLATFORM_ORGANIZATION.name,
      organizationStatus: PLATFORM_ORGANIZATION.status,
      role: user._mock.platformRole,
      status: user.isActive ? 'ACTIVE' : 'BLOCKED',
    })
  }
  for (const m of user.wineryMemberships) {
    const winery = wineries.find((w) => w.id === m.wineryId)
    if (!winery) continue
    const member = winery.members?.find((x) => x.userId === user.id)
    out.push({
      id: member?.id ?? uid(`membership:${winery.id}:${user.id}`),
      organizationId: winery.id,
      organizationType: 'WINERY',
      organizationName: winery.commercialName,
      organizationStatus: winery.certificationStatus,
      role: m.memberRole,
      status: m.isActive ? 'ACTIVE' : 'BLOCKED',
    })
  }
  return out
}

/** ¿Se puede activar esta membresía? (membresía `ACTIVE` y organización no `REVOKED`). */
export function isUsableMembership(m: Membership): boolean {
  return m.status === 'ACTIVE' && m.organizationStatus !== 'REVOKED'
}

/**
 * Organización activa: la preferida (la última usada) si sigue siendo utilizable; si no, la
 * primera membresía utilizable (plataforma antes que bodega); `null` si no hay.
 */
export function pickActiveOrganizationId(memberships: readonly Membership[], preferred?: string | null): string | null {
  const usable = memberships.filter(isUsableMembership)
  if (preferred && usable.some((m) => m.organizationId === preferred)) return preferred
  return usable[0]?.organizationId ?? null
}

/** Tokens estáticos de un usuario de demo (`mock.access.<clave>`): los de `auth-login.json`. */
export function staticTokens(user: MockUser): AuthTokens {
  return {
    accessToken: `mock.access.${user._mock.key}`,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  }
}

/**
 * Respuesta de sesión (login, signup, refresh, switch-organization) para una persona
 * (`auth_response` de `generate.py`). Sin `activeOrganizationId` usa la organización por defecto.
 */
export function buildSessionResponse(
  user: MockUser,
  wineries: readonly WineryResponse[],
  options: { activeOrganizationId?: string | null; tokens?: AuthTokens; memberships?: Membership[] } = {},
): SessionResponse {
  const memberships = options.memberships ?? deriveMemberships(user, wineries)
  const activeOrganizationId =
    options.activeOrganizationId === undefined ? pickActiveOrganizationId(memberships) : options.activeOrganizationId
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      preferredLocale: 'es',
      audience: memberships.length > 0 ? 'STAFF' : 'CONSUMER',
    },
    memberships,
    activeOrganizationId,
    tokens: options.tokens ?? staticTokens(user),
  }
}

/** Nombre de 0.1. */
export function buildAuthResponse(user: MockUser, wineries: readonly WineryResponse[]): SessionResponse {
  return buildSessionResponse(user, wineries)
}

export interface PassportChain {
  wineries: readonly WineryResponse[]
  terroirs: readonly TerroirResponse[]
  harvestBatches: readonly HarvestBatchResponse[]
  tanks: readonly FermentationTankResponse[]
  wineAgings: readonly WineAgingResponse[]
  productionBatches: readonly ProductionBatchResponse[]
  labAnalyses: readonly BatchLabAnalysisResponse[]
}

const dagHash = (input: string): string => `0x${sha256Hex(input)}`

/** `JSON.stringify(metadata, Object.keys(metadata).sort())` del backend: claves de primer nivel ordenadas. */
const dagMetadataHash = (metadata: Record<string, unknown>): string =>
  dagHash(JSON.stringify(metadata, Object.keys(metadata).sort()))

const num = (value: number | null | undefined): number => Number(value ?? 0)

/**
 * Grafo DAG de un embotellado (`DagGraphResponseDto`), como `DagBuilderService` del backend:
 * `GET /v1/traceability/dag/:bottlingBatchId` y el pasaporte público `GET /v1/traceability/public/:lotCode`.
 * Las fechas son las que guardan los mocks (ISO sin milisegundos).
 */
export function buildDagGraph(b: BottlingBatchResponse, chain: PassportChain): DagGraph {
  const w = chain.wineries.find((x) => x.id === b.wineryId)
  const wineryName = w?.commercialName ?? ''
  const aging = b.wineAgingBatchId ? chain.wineAgings.find((x) => x.id === b.wineAgingBatchId) : undefined
  const production = !aging && b.productionBatchId ? chain.productionBatches.find((x) => x.id === b.productionBatchId) : undefined
  const intermediate = aging ?? production
  const tank = intermediate ? chain.tanks.find((x) => x.id === intermediate.fermentationTankId) : undefined
  const harvest = tank ? chain.harvestBatches.find((x) => x.id === tank.harvestBatchId) : undefined
  const terroir = harvest ? chain.terroirs.find((x) => x.id === harvest.terroirId) : undefined
  const lab = chain.labAnalyses.find((l) => l.bottlingBatchId === b.id)
  const operator = (name: string, role: string) => ({ name, role, wineryName })
  const nodes: DagNode[] = []
  let plotHash = ''
  let harvestHash = ''
  let vinificationHash = ''
  let intermediateHash = ''

  if (terroir) {
    plotHash = dagHash(`TERROIR-${terroir.id}`)
    const details = {
      parcelName: terroir.parcelName,
      varietyName: terroir.varietyName,
      altitudeMasl: num(terroir.altitudeMasl),
      surfaceHectares: num(terroir.surfaceHectares),
      isDoEligible: terroir.isDoEligible,
    }
    nodes.push({
      batchId: plotHash,
      stage: 0,
      stageName: 'Plot',
      parents: [],
      timestamp: terroir.createdAt,
      volumeOrUnits: num(terroir.surfaceHectares),
      metrics: [Math.round(num(terroir.altitudeMasl) * 100)],
      metadataHash: dagMetadataHash(details),
      isCertified: terroir.isDoEligible,
      operator: operator('Ingeniero Agrónomo', 'Agronomist'),
      details,
    })
  }
  if (harvest) {
    harvestHash = dagHash(`HARVEST-${harvest.id}`)
    const details = {
      harvestBatchCode: harvest.harvestBatchCode,
      grossWeightKg: num(harvest.grossWeightKg),
      tareWeightKg: num(harvest.tareWeightKg),
      netWeightKg: num(harvest.netWeightKg),
      brixDegrees: num(harvest.brixDegrees),
      initialPh: num(harvest.initialPh),
      initialAcidityGl: num(harvest.initialAcidityGl),
      phytosanitaryStatus: harvest.phytosanitaryStatus,
    }
    nodes.push({
      batchId: harvestHash,
      stage: 1,
      stageName: 'Harvest',
      parents: plotHash ? [plotHash] : [],
      timestamp: harvest.intakeDate,
      volumeOrUnits: num(harvest.netWeightKg),
      metrics: [
        Math.round(num(harvest.brixDegrees) * 100),
        Math.round(num(harvest.initialPh) * 100),
        Math.round(num(harvest.initialAcidityGl) * 100),
      ],
      metadataHash: dagMetadataHash(details),
      isCertified: harvest.phytosanitaryStatus === 'APPROVED',
      operator: operator('Jefe de Báscula', 'Weigher'),
      details,
    })
  }
  if (tank) {
    vinificationHash = dagHash(`TANK-${tank.id}`)
    const details = {
      tankCode: tank.tankCode,
      material: tank.material ?? null,
      volumeFilledLiters: num(tank.volumeFilledLiters),
      destinationType: tank.destinationType ?? null,
    }
    nodes.push({
      batchId: vinificationHash,
      stage: 2,
      stageName: 'Vinification',
      parents: harvestHash ? [harvestHash] : [],
      timestamp: tank.startDate,
      volumeOrUnits: num(tank.volumeFilledLiters),
      // Estimación fija del backend (vino base: 12,80 % vol. y 0,28 g/l de acidez).
      metrics: [1280, 28],
      metadataHash: dagMetadataHash(details),
      isCertified: true,
      operator: operator('Enólogo de Planta', 'Oenologist'),
      details,
    })
  }
  if (aging) {
    intermediateHash = dagHash(`AGING-${aging.id}`)
    const details = {
      containerType: aging.containerType,
      containerMaterial: aging.containerMaterial ?? null,
      plannedMonths: aging.plannedMonths,
      lockUntilDate: aging.lockUntilDate.slice(0, 10),
    }
    nodes.push({
      batchId: intermediateHash,
      stage: 3,
      stageName: 'Aging',
      parents: vinificationHash ? [vinificationHash] : [],
      timestamp: aging.createdAt,
      volumeOrUnits: num(aging.volumeLiters),
      metrics: [aging.plannedMonths * 100],
      metadataHash: dagMetadataHash(details),
      isCertified: true,
      operator: operator('Maestro de Cava', 'Oenologist'),
      details,
    })
  } else if (production) {
    intermediateHash = dagHash(`DISTILLATION-${production.id}`)
    const details = {
      equipmentIdentifier: production.equipmentIdentifier,
      inputVolumeLiters: num(production.inputVolumeLiters),
      outputVolumeLiters: num(production.outputVolumeLiters),
      wasteVolumeLiters: num(production.wasteVolumeLiters),
      initialAlcoholPercentage: num(production.initialAlcoholPercentage),
      restStatus: production.restStatus,
    }
    nodes.push({
      batchId: intermediateHash,
      stage: 4,
      stageName: 'Distillation',
      parents: vinificationHash ? [vinificationHash] : [],
      timestamp: production.processStartDate,
      volumeOrUnits: num(production.outputVolumeLiters),
      metrics: [Math.round(Number(production.initialAlcoholPercentage ?? 70.2) * 100)],
      metadataHash: dagMetadataHash(details),
      isCertified: production.isDoEligible,
      operator: operator('Maestro Destilador', 'Distiller'),
      details,
    })
  }
  const rootBatchId = dagHash(`BOTTLING-${b.id}`)
  const bottlingDetails = {
    internationalLotCode: b.internationalLotCode,
    productType: b.productType,
    finalAlcoholAbv: num(b.finalAlcoholAbv),
    waterDilutionLiters: num(b.waterDilutionLiters),
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
    metrics: [Math.round(num(b.finalAlcoholAbv) * 100), b.packagingFormatCl * 10],
    metadataHash: dagMetadataHash(bottlingDetails),
    isCertified: Boolean(lab?.conformsToSenasagStandards),
    operator: operator('Supervisor de Envasado', 'Packer'),
    details: {
      ...bottlingDetails,
      labAnalysis: lab
        ? {
            certifiedLaboratoryName: lab.certifiedLaboratoryName,
            accreditedLabCertificationCode: lab.accreditedLabCertificationCode,
            actualAlcoholAbv: num(lab.actualAlcoholAbv),
            methanolContentMgL: num(lab.methanolContentMgL),
            conformsToSenasagStandards: lab.conformsToSenasagStandards,
          }
        : null,
    },
  })
  return { rootBatchId, internationalLotCode: b.internationalLotCode, productType: b.productType, nodes }
}
