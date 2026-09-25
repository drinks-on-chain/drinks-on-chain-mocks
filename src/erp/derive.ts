import type {
  AuthResponse,
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  FermentationTankResponse,
  HarvestBatchResponse,
  MockUser,
  ProductionBatchResponse,
  PublicPassport,
  TerroirResponse,
  WineAgingResponse,
  WineryResponse,
} from './schemas'

// Respuestas compuestas que comparten el generador y los handlers MSW (funciones puras).

/** Respuesta de `POST /v1/auth/login` para un usuario (`auth_response` de `generate.py`). */
export function buildAuthResponse(u: MockUser): AuthResponse {
  const m = u.wineryMemberships[0]
  return {
    user: {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      userRole: u.userRole,
      phoneNumber: u.phoneNumber,
      preferredLocale: 'es',
      wineryId: m ? m.wineryId : null,
      memberRole: m ? m.memberRole : null,
    },
    tokens: {
      accessToken: `mock.access.${u._mock.key}`,
      refreshToken: `mock.refresh.${u._mock.key}`,
      tokenType: 'Bearer',
      expiresIn: 604800,
    },
  }
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
