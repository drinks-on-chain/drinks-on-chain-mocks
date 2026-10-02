import type { PublicWineryProfile } from '../backoffice/schemas'
import type { Lot, MemberRole, StoredLotEvent } from '../erp/schemas'
import { MEMBER_ROLES } from '../erp/schemas/enums'
import { formatBottleCode } from '../erp/trace/bottle-code'
import { dayOf } from '../erp/trace/dates'
import { doRulesFromLot, evaluateDo } from '../erp/trace/domain'
import { bottleMerkleProof, lotAttachments } from '../erp/trace/dossier'
import { harvestAnalyses } from '../erp/trace/records'
import { LOT_RULE_KEYS, LOT_RULE_LABELS, formatQuantity } from '../erp/trace/rules'
import {
  agingLockOf,
  agingStartDay,
  bottleLotOf,
  correctionsOf,
  currentLab,
  harvestInTank,
  harvestTerroir,
  isVoided,
  lotAgings,
  lotBottling,
  lotDenomination,
  lotDossier,
  lotHarvests,
  lotProductions,
  lotTanks,
  restLockOf,
  type BottleLot,
  type TraceState,
} from '../erp/trace/state'
import type { PublicBottlePassport, PublicLotPassport, PublicTimelineEvent } from './schemas'

export { LOT_CODE_PATTERN } from './schemas'

// Pasaporte público (contrato de la Ola 2 §12): lo que ve el visor `/b/{código}` sin cuenta. Solo
// datos registrados (EA-05): nada fijo ni inventado; lo que falta es `NOT_RECORDED` o `null`.
// No son públicos (S-22) pesos, volúmenes intermedios, dosis, balance, mermas, notas internas ni
// el detalle de las correcciones; de las personas solo sale el rol (S-21).

/** Perfil público de una bodega y si está activa (el pasaporte sigue visible aunque no lo esté, S-23). */
export type PublicWineryInfo = PublicWineryProfile & { active: boolean }
export type WineryResolver = (wineryId: string) => PublicWineryInfo

/** Perfil público (`PublicWineryProfileDto`) sin la marca `active`. */
export const toPublicProfile = (w: PublicWineryInfo): PublicWineryProfile => ({
  slug: w.slug,
  tradeName: w.tradeName,
  region: w.region,
  category: w.category,
  logoUrl: w.logoUrl,
  publicStory: w.publicStory,
  website: w.website,
})


const PHYTO_LABELS: Record<string, string> = { APPROVED: 'aprobado', REJECTED: 'rechazado', QUARANTINE: 'en cuarentena' }
const LAB_LABELS: Record<string, string> = { CONFORMING: 'conforme', NON_CONFORMING: 'no conforme', INCOMPLETE: 'incompleto' }

/** Texto público de un evento: sin pesos, volúmenes ni nombres (el resumen interno sí los lleva). */
function publicSummary(e: StoredLotEvent): string {
  const d = e.data
  switch (e.type) {
    case 'HARVEST_WEIGHED':
      return 'Uva recibida y pesada en la bodega'
    case 'PHYTO_DECIDED':
      return `Dictamen fitosanitario: ${PHYTO_LABELS[String(d.decision)] ?? 'registrado'}`
    case 'TANK_FILLED':
      return 'Mosto en el tanque de fermentación'
    case 'FERMENTATION_STARTED':
      return 'Fermentación iniciada'
    case 'FERMENTATION_COMPLETED':
      return 'Fermentación completada'
    case 'PRODUCT_DECIDED':
      return `Destino del lote: ${d.productType === 'WINE' ? 'vino' : 'singani'}`
    case 'AGING_STARTED':
      return typeof d.plannedMonths === 'number' ? `Inicio de la crianza (${d.plannedMonths} meses)` : 'Inicio de la crianza'
    case 'DISTILLATION_STARTED':
      return 'Destilación iniciada'
    case 'DISTILLATION_CLOSED':
      return 'Destilación terminada: empieza el reposo'
    case 'LOCK_RELEASED':
      return d.kind === 'AGING' ? 'Crianza cumplida' : 'Reposo cumplido'
    case 'BOTTLED':
      return typeof d.bottles === 'number' ? `Embotellado: ${formatQuantity(d.bottles)} botellas de ${String(d.formatCl)} cL` : 'Embotellado'
    case 'LAB_REGISTERED':
      return `Análisis de laboratorio: ${LAB_LABELS[String(d.conformity)] ?? 'registrado'}`
    case 'DOSSIER_CLOSED':
      return 'Expediente cerrado con su huella'
    case 'LOT_DISCARDED':
      return 'Lote retirado por la bodega'
    default:
      return 'Registro del lote'
  }
}

const roleOf = (role: string | undefined): MemberRole | null => ((MEMBER_ROLES as readonly string[]).includes(role ?? '') ? (role as MemberRole) : null)

/** Eventos públicos de un lote, en orden (los usa también el borrador del catálogo). */
export function publicTimeline(state: TraceState, lotId: string): PublicTimelineEvent[] {
  return state.lotEvents
    .filter((e) => e.lotId === lotId && e.visibility === 'PUBLIC')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      type: e.type,
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
      lateEntry: e.lateEntry,
      summary: publicSummary(e),
      actorRole: roleOf(e.actor?.role),
      corrected: e.corrected || correctionsOf(state, e.resource.type, e.resource.id).length > 0,
    }))
}

const minDay = (days: string[]): string | null => (days.length > 0 ? ([...days].sort()[0] as string) : null)
const maxDay = (days: string[]): string | null => (days.length > 0 ? ([...days].sort().at(-1) as string) : null)

/** Pasaporte de un lote embotellado (o descartado tras embotellarse). `now` es el instante de la consulta. */
export function buildLotPassport(state: TraceState, lot: Lot, winery: PublicWineryInfo, now: string): PublicLotPassport {
  const today = now.slice(0, 10)
  const isSingani = lot.productType === 'SINGANI'
  const harvests = lotHarvests(state, lot.id)
  const tanks = lotTanks(state, lot.id)
  const agings = lotAgings(state, lot.id).filter((a) => a.agingStatus !== 'DISCARDED')
  const productions = lotProductions(state, lot.id).filter((p) => p.restStatus !== 'DISCARDED')
  const bottling = lotBottling(state, lot.id)
  const lab = currentLab(state, lot.id)
  const dossier = lotDossier(state, lot.id)
  const denomination = lotDenomination(state, lot, now)
  const lotCode = lot.lotCode ?? ''
  const exceptions = lot.rules.legalExceptions

  const seen = new Set<string>()
  const terroirs = harvests
    .map((h) => harvestTerroir(state, h))
    .filter((t) => !seen.has(t.id) && Boolean(seen.add(t.id)))
    .map((t) => ({
      parcelName: t.parcelName,
      region: winery.region,
      altitudeMasl: t.altitudeMasl,
      variety: t.varietyName,
      doStatus: isSingani ? evaluateDo([t], doRulesFromLot(lot.rules), 'LOT_SNAPSHOT', now).status : ('NOT_APPLICABLE' as const),
    }))
  const analysis = harvests.flatMap((h) => harvestAnalyses(state, h.id)).sort((a, b) => a.measuredAt.localeCompare(b.measuredAt)).at(-1)
  const inTanks = harvests.filter((h) => harvestInTank(state, h.id))
  const tankIds = new Set(tanks.map((t) => t.id))
  const aging = agings[0]
  const closed = productions.filter((p) => p.processEndDate)
  const lastClosed = closed.sort((a, b) => (a.processEndDate as string).localeCompare(b.processEndDate as string)).at(-1)
  const restLock = lastClosed ? restLockOf(lastClosed, lot.rules, today) : null

  const ruleKeys = isSingani
    ? [LOT_RULE_KEYS.minAltitudeMasl, LOT_RULE_KEYS.requiredVarieties, LOT_RULE_KEYS.minRestDays]
    : [LOT_RULE_KEYS.minAgingMonths]
  const items = [...ruleKeys, LOT_RULE_KEYS.requireApproved, LOT_RULE_KEYS.maxLossPercent, LOT_RULE_KEYS.labLimits].map((key) => ({
    key,
    label: LOT_RULE_LABELS[key]?.label ?? key,
    value: lot.rules.values[key] ?? null,
    unit: LOT_RULE_LABELS[key]?.unit ?? null,
    legalException: exceptions.includes(key),
  }))
  const corrections = state.corrections.filter((c) => c.lotId === lot.id)

  return {
    kind: 'LOT',
    lotCode,
    name: lot.name,
    productType: lot.productType ?? 'WINE',
    vintage: lot.harvestYear,
    stage: lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED' || lot.stage === 'DISCARDED' ? lot.stage : 'BOTTLED',
    winery: { slug: winery.slug, tradeName: winery.tradeName, region: winery.region, logoUrl: winery.logoUrl, website: winery.website, active: winery.active },
    denomination: {
      applies: isSingani,
      status: denomination.status,
      rules: isSingani ? { minAltitudeMasl: lot.rules.singani.minAltitudeMasl, requiredVarieties: lot.rules.singani.requiredVarieties } : null,
      legalException: denomination.status === 'ELIGIBLE_BY_EXCEPTION',
    },
    origin: { status: terroirs.length > 0 ? 'RECORDED' : 'NOT_RECORDED', terroirs },
    harvest: {
      status: harvests.length > 0 ? 'RECORDED' : 'NOT_RECORDED',
      firstIntakeDate: minDay(harvests.map((h) => dayOf(h.intakeDate))),
      lastIntakeDate: maxDay(harvests.map((h) => dayOf(h.intakeDate))),
      phytosanitary: inTanks.length > 0 && inTanks.every((h) => h.phytosanitaryStatus === 'APPROVED') ? 'APPROVED' : 'NOT_RECORDED',
      maturity: analysis ? { brixDegrees: analysis.brixDegrees, ph: analysis.ph, acidityGl: analysis.acidityGl } : null,
    },
    fermentation: {
      status: tanks.length > 0 ? 'RECORDED' : 'NOT_RECORDED',
      startDate: minDay(tanks.map((t) => dayOf(t.startDate))),
      endDate: tanks.length > 0 && tanks.every((t) => t.endDate) ? maxDay(tanks.map((t) => dayOf(t.endDate as string))) : null,
      readingsCount: state.logs.filter((l) => tankIds.has(l.fermentationTankId) && !isVoided(state, 'FERMENTATION_LOG', l.id)).length,
      treatments: state.treatments
        .filter((t) => tankIds.has(t.fermentationTankId) && !isVoided(state, 'TREATMENT', t.id))
        .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt))
        .map((t) => ({ type: t.treatmentType, additive: t.additiveName, regulatoryAuthCode: t.regulatoryAuthCode, appliedAt: t.appliedAt })),
    },
    aging: isSingani
      ? { status: 'NOT_APPLICABLE', containerType: null, containerMaterial: null, plannedMonths: null, startDate: null, unlockDate: null }
      : aging
        ? {
            status: 'RECORDED',
            containerType: aging.containerType,
            containerMaterial: aging.containerMaterial ?? null,
            plannedMonths: aging.plannedMonths,
            startDate: agingStartDay(aging),
            unlockDate: agingLockOf(aging, lot.rules, today).unlockDate,
          }
        : { status: 'NOT_RECORDED', containerType: null, containerMaterial: null, plannedMonths: null, startDate: null, unlockDate: null },
    distillation: !isSingani
      ? { status: 'NOT_APPLICABLE', startDate: null, endDate: null, heartAbvPercent: null, restMinDays: null, restUntil: null }
      : productions.length > 0
        ? {
            status: 'RECORDED',
            startDate: minDay(productions.map((p) => dayOf(p.processStartDate))),
            endDate: lastClosed?.processEndDate ? dayOf(lastClosed.processEndDate) : null,
            heartAbvPercent: lastClosed?.heartAbvPercent ?? lastClosed?.initialAlcoholPercentage ?? null,
            restMinDays: lot.rules.singani.minRestDays,
            restUntil: restLock?.unlockDate ?? null,
          }
        : { status: 'NOT_RECORDED', startDate: null, endDate: null, heartAbvPercent: null, restMinDays: null, restUntil: null },
    bottling: bottling
      ? { status: 'RECORDED', date: dayOf(bottling.bottlingDate), bottles: bottling.totalBottlesPackaged, formatCl: bottling.packagingFormatCl, finalAbv: bottling.finalAlcoholAbv }
      : { status: 'NOT_RECORDED', date: null, bottles: null, formatCl: null, finalAbv: null },
    lab: {
      status: lab?.conformityStatus ?? 'NOT_RECORDED',
      laboratoryName: lab?.certifiedLaboratoryName ?? null,
      testedAt: lab ? dayOf(lab.testPerformedAt) : null,
      checks: lab?.conformity?.checks ?? [],
    },
    rules: { takenAt: lot.rules.takenAt, origin: lot.rules.origin, items },
    timeline: publicTimeline(state, lot.id),
    corrections: { count: corrections.length, lastAt: corrections.map((c) => c.createdAt).sort().at(-1) ?? null },
    dossier: {
      status: dossier?.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
      hash: dossier?.hash ?? null,
      closedAt: dossier?.closedAt ?? null,
      canonicalUrl: dossier?.status === 'CLOSED' ? `/v1/public/lots/${encodeURIComponent(lotCode)}/dossier` : null,
      anchor: null,
    },
    publicAttachments: lotAttachments(state, lot)
      .filter((a) => a.visibility === 'PUBLIC')
      .map((a) => ({ id: a.id, kind: a.kind, title: a.title, url: `/v1/public/lots/${encodeURIComponent(lotCode)}/attachments/${a.id}` })),
    generatedAt: now,
  }
}

/** Pasaporte de una botella: número de serie, estado del código, prueba Merkle (con el expediente cerrado) y el pasaporte del lote. */
export function buildBottlePassport(
  state: TraceState,
  lot: Lot,
  bottleLot: BottleLot,
  bottle: { code: string; serial: number; generation: number },
  winery: PublicWineryInfo,
  now: string,
): PublicBottlePassport {
  const voided = Boolean(bottleLot.allVoided) || bottleLot.voided.some((v) => v.code === bottle.code)
  return {
    kind: 'BOTTLE',
    bottle: {
      code: bottle.code,
      codeFormatted: formatBottleCode(bottle.code),
      serial: bottle.serial,
      lotTotal: bottleLot.total,
      status: voided ? 'VOIDED' : 'ACTIVE',
      merkleProof: voided ? null : bottleMerkleProof(state, lot, bottle.serial, bottle.generation),
    },
    lot: buildLotPassport(state, lot, winery, now),
    redemption: null,
  }
}

/** Lote de un código de lote (sin distinguir mayúsculas). Solo los que tienen `lotCode` (embotellados). */
export function findLotByCode(state: TraceState, lotCode: string): Lot | null {
  const wanted = lotCode.trim().toUpperCase()
  return state.lots.find((l) => l.lotCode !== null && l.lotCode.toUpperCase() === wanted && bottleLotOf(state, l.id) !== null) ?? null
}
