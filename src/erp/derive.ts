import { PLATFORM_ORGANIZATION } from './catalog'
import type {
  AuthTokens,
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  FermentationTankResponse,
  HarvestBatchResponse,
  Membership,
  MemberRole,
  MockUser,
  ProductionBatchResponse,
  PublicPassport,
  SessionResponse,
  TerroirResponse,
  UserRole,
  WineAgingResponse,
  WineryResponse,
} from './schemas'
import { uid } from '../shared/uuid'

// Respuestas compuestas que comparten el generador y los handlers MSW (funciones puras).

/** Vida del token de acceso en segundos (15 min, contrato de la Ola 0 §5). */
export const ACCESS_TOKEN_TTL_SECONDS = 900

/**
 * Membresías de una persona (contrato de la Ola 0 §4), en orden: plataforma antes que bodegas.
 * - `PLATFORM_ADMIN` → `SUPERADMIN` de la organización de plataforma.
 * - Cada `wineryMemberships[i]` → membresía `WINERY` con su rol; el id es el del miembro de la
 *   bodega; `isActive: false` → `BLOCKED`.
 * - `POS_OPERATOR` y consumidores → ninguna (el POS llega en la Ola 5).
 */
export function deriveMemberships(user: MockUser, wineries: readonly WineryResponse[]): Membership[] {
  const out: Membership[] = []
  if (user.userRole === 'PLATFORM_ADMIN') {
    out.push({
      id: uid(`membership:platform:${user.id}`),
      organizationId: PLATFORM_ORGANIZATION.id,
      organizationType: 'PLATFORM',
      organizationName: PLATFORM_ORGANIZATION.name,
      organizationStatus: PLATFORM_ORGANIZATION.status,
      role: 'SUPERADMIN',
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

/** `userRole` equivalente a un rol de bodega (los operarios y contables son `ENOLOGIST`, como en los fixtures). */
export const USER_ROLE_FOR_MEMBER: Record<MemberRole, UserRole> = {
  OWNER: 'WINERY_ADMIN',
  ENOLOGIST: 'ENOLOGIST',
  AGRONOMIST: 'AGRONOMIST',
  OPERATOR: 'ENOLOGIST',
  ACCOUNTANT: 'ENOLOGIST',
}

/** Tokens estáticos de un usuario de demo (`mock.access.<clave>`): los de `auth-login.json`. */
export function staticTokens(user: MockUser): AuthTokens {
  return {
    accessToken: `mock.access.${user._mock.key}`,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: `mock.refresh.${user._mock.key}`,
  }
}

/**
 * Respuesta de sesión (login, signup, refresh, switch-organization) para una persona
 * (`auth_response` de `generate.py`). Sin `activeOrganizationId` usa la organización por defecto.
 */
export function buildSessionResponse(
  user: MockUser,
  wineries: readonly WineryResponse[],
  options: { activeOrganizationId?: string | null; tokens?: AuthTokens } = {},
): SessionResponse {
  const memberships = deriveMemberships(user, wineries)
  const activeOrganizationId =
    options.activeOrganizationId === undefined ? pickActiveOrganizationId(memberships) : options.activeOrganizationId
  const active = memberships.find((m) => m.organizationId === activeOrganizationId)
  const activeWinery = active?.organizationType === 'WINERY' ? active : undefined
  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      preferredLocale: 'es',
      audience: memberships.length > 0 ? 'STAFF' : 'CONSUMER',
      userRole: user.userRole,
      wineryId: activeWinery ? activeWinery.organizationId : null,
      memberRole: activeWinery ? (activeWinery.role as MemberRole) : null,
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

/** Pasaporte público de un embotellado (`GET /v1/traceability/public/:lotCode`). */
export function buildPublicPassport(b: BottlingBatchResponse, chain: PassportChain): PublicPassport {
  const w = chain.wineries.find((x) => x.id === b.wineryId)!
  let tank: FermentationTankResponse
  if (b.productionBatchId) {
    const p = chain.productionBatches.find((x) => x.id === b.productionBatchId)!
    tank = chain.tanks.find((x) => x.id === p.fermentationTankId)!
  } else {
    const a = chain.wineAgings.find((x) => x.id === b.wineAgingBatchId)!
    tank = chain.tanks.find((x) => x.id === a.fermentationTankId)!
  }
  const h = chain.harvestBatches.find((x) => x.id === tank.harvestBatchId)!
  const t = chain.terroirs.find((x) => x.id === h.terroirId)!
  const lab = chain.labAnalyses.find((l) => l.bottlingBatchId === b.id)
  return {
    lotCode: b.internationalLotCode,
    winery: {
      commercialName: w.commercialName,
      department: w.geographicRegion.split('·')[0]!.trim(),
      altitudeMasl: t.altitudeMasl,
    },
    product: {
      productType: b.productType,
      alcoholAbv: b.finalAlcoholAbv,
      bottlesPackaged: b.totalBottlesPackaged,
      packagingFormatCl: b.packagingFormatCl,
      bottlingDate: b.bottlingDate,
    },
    terroir: {
      parcelName: t.parcelName,
      altitudeMasl: t.altitudeMasl,
      varietyName: t.varietyName,
      doEligible: t.isDoEligible,
      doType: t.doType ?? null,
    },
    laboratoryCertification: lab
      ? {
          certifiedLaboratoryName: lab.certifiedLaboratoryName,
          accreditedLabCertificationCode: lab.accreditedLabCertificationCode,
          actualAlcoholAbv: lab.actualAlcoholAbv,
          totalAcidityTartaricGl: lab.totalAcidityTartaricGl,
          volatileAcidityAceticGl: lab.volatileAcidityAceticGl,
          conformsToSenasagStandards: lab.conformsToSenasagStandards,
          reportPdfUrl: lab.laboratoryReportPdfUrl,
        }
      : null,
    blockchainIntegrity: {
      sha256Hash: b.blockchainDataHash ?? null,
      network: 'Stellar Testnet',
      status: b.isAnchoredOnChain ? 'VERIFIED_ON_CHAIN' : 'PENDING_ANCHOR',
    },
  }
}
