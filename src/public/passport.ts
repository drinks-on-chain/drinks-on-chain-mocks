import { publicAnchorView } from '../chain/views'
import type { PublicWineryProfile } from '../backoffice/schemas'
import type { Lot, MemberRole, StoredLotEvent } from '../erp/schemas'
import { MEMBER_ROLES } from '../erp/schemas/enums'
import { formatBottleCode } from '../erp/trace/bottle-code'
import { dayOf } from '../erp/trace/dates'
import { doRulesFromLot, evaluateDo } from '../erp/trace/domain'
import { bottleMerkleProof, lotAttachments } from '../erp/trace/dossier'
import { harvestAnalyses } from '../erp/trace/records'
import { LOT_RULE_KEYS } from '../erp/trace/rules'
import {
  agingLockOf,
  agingStartDay,
  bottleLotOf,
  correctionsOf,
  currentLab,
  distillationHeart,
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

/**
 * Texto público de cada evento (`publicEventSummary` del backend, los mismos textos). Nunca se
 * publica el resumen interno: lleva cifras (S-22), motivos y, a veces, nombres (S-21).
 */
export function publicEventSummary(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'HARVEST_WEIGHED':
      return 'Uva recibida y pesada en la bodega'
    case 'PHYTO_DECIDED': {
      const decision = PHYTO_LABELS[String(data.decision)]
      return decision ? `Dictamen fitosanitario: ${decision}` : 'Dictamen fitosanitario registrado'
    }
    case 'TANK_FILLED':
      return 'Mosto en tanque de fermentación'
    case 'FERMENTATION_STARTED':
      return 'Fermentación iniciada'
    case 'FERMENTATION_COMPLETED':
      return 'Fermentación completada'
    case 'PRODUCT_DECIDED':
      return data.productType === 'SINGANI' ? 'Destino del lote: singani' : data.productType === 'WINE' ? 'Destino del lote: vino' : 'Destino del lote decidido'
    case 'AGING_STARTED':
      return 'Crianza iniciada'
    case 'DISTILLATION_STARTED':
      return 'Destilación iniciada'
    case 'DISTILLATION_CLOSED':
      return 'Destilación cerrada: empieza el reposo'
    case 'LOCK_RELEASED':
      return 'Tiempo mínimo de crianza o reposo cumplido'
    case 'BOTTLED':
      return 'Lote embotellado'
    case 'LAB_REGISTERED':
      return 'Análisis de laboratorio registrado'
    case 'DOSSIER_CLOSED':
      return 'Expediente del lote cerrado'
    case 'LOT_DISCARDED':
      return 'Lote retirado por la bodega'
    // Ola 3 (contrato §11)
    case 'NFT_MINTED':
      return typeof data.quantity === 'number' ? `${data.quantity} botellas en preventa` : 'Botellas en preventa'
    case 'COLLECTION_PUBLISHED':
      return 'Colección publicada en el Marketplace'
    case 'DOSSIER_ANCHORED':
      return 'Expediente anclado en la red Stellar'
    case 'TOKENS_REDEEMABLE':
      return 'Botellas listas para canjear'
    default:
      return 'Registro del lote'
  }
}

/** Tipo de corrección del registro de un evento (para saber si una corrección `VOID` lo anuló). */
const VOIDABLE_RESOURCES: Record<string, 'MATURITY_ANALYSIS' | 'PHYTO_DECISION' | 'FERMENTATION_LOG' | 'TREATMENT' | 'LAB_ANALYSIS'> = {
  maturity_analysis: 'MATURITY_ANALYSIS',
  phyto_decision: 'PHYTO_DECISION',
  fermentation_log: 'FERMENTATION_LOG',
  enological_treatment: 'TREATMENT',
  lab_analysis: 'LAB_ANALYSIS',
}

/** ¿El evento es de un registro anulado? (un dictamen o un análisis anulado deja de contar y no se publica). */
function ofVoidedRecord(state: TraceState, e: StoredLotEvent): boolean {
  const type = VOIDABLE_RESOURCES[e.resource.type]
  return type !== undefined && isVoided(state, type, e.resource.id)
}

const roleOf = (role: string | undefined): MemberRole | null => ((MEMBER_ROLES as readonly string[]).includes(role ?? '') ? (role as MemberRole) : null)

/**
 * Eventos públicos de un lote, en orden (los usa también el borrador del catálogo): solo los de
 * visibilidad `PUBLIC`, sin los de registros anulados, con su texto público y el rol del autor.
 */
export function publicTimeline(state: TraceState, lotId: string): PublicTimelineEvent[] {
  return state.lotEvents
    .filter((e) => e.lotId === lotId && e.visibility === 'PUBLIC' && !ofVoidedRecord(state, e))
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      type: e.type,
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
      lateEntry: e.lateEntry,
      summary: publicEventSummary(e.type, e.data),
      actorRole: roleOf(e.actor?.role),
      corrected: e.corrected || correctionsOf(state, e.resource.type, e.resource.id).length > 0,
    }))
}

const minDay = (days: string[]): string | null => (days.length > 0 ? ([...days].sort()[0] as string) : null)
const maxDay = (days: string[]): string | null => (days.length > 0 ? ([...days].sort().at(-1) as string) : null)
/** Instante de un tanque (los registros guardan el día a medianoche UTC o el instante completo). */
const minInstant = (values: string[]): string | null => (values.length > 0 ? ([...values].sort()[0] as string) : null)
const maxInstant = (values: string[]): string | null => (values.length > 0 ? ([...values].sort().at(-1) as string) : null)

/** Reglas con las que se hizo el lote (`ruleItems` del backend): las de su producto, el dictamen y los límites de laboratorio. */
function ruleItems(lot: Lot, isSingani: boolean): PublicLotPassport['rules']['items'] {
  const K = LOT_RULE_KEYS
  const { rules } = lot
  const item = (key: string, label: string, value: unknown, unit: string | null) => ({ key, label, value, unit, legalException: rules.legalExceptions.includes(key) })
  return [
    ...(isSingani
      ? [
          item(K.minAltitudeMasl, 'Altitud mínima del viñedo', rules.singani.minAltitudeMasl, 'msnm'),
          item(K.requiredVarieties, 'Variedades exigidas', rules.singani.requiredVarieties, null),
          item(K.minRestDays, 'Reposo mínimo', rules.singani.minRestDays, 'días'),
        ]
      : [item(K.minAgingMonths, 'Crianza mínima', rules.wine.minAgingMonths, 'meses')]),
    item(K.requireApproved, 'Dictamen fitosanitario aprobado antes de fermentar', rules.phytosanitary.requireApproved, null),
    item(K.labLimits, 'Límites de laboratorio', rules.lab.limits, null),
  ]
}

/** Pasaporte de un lote embotellado (o descartado tras embotellarse). `now` es el instante de la consulta. */
export function buildLotPassport(state: TraceState, lot: Lot, winery: PublicWineryInfo, now: string): PublicLotPassport {
  const today = now.slice(0, 10)
  const bottlingRow = lotBottling(state, lot.id)
  const productType = lot.productType ?? (bottlingRow?.productType === 'SINGANI' ? 'SINGANI' : 'WINE')
  const isSingani = productType === 'SINGANI'
  const harvests = lotHarvests(state, lot.id)
  const tanks = lotTanks(state, lot.id)
  const agings = lotAgings(state, lot.id).filter((a) => a.agingStatus !== 'DISCARDED')
  const productions = lotProductions(state, lot.id).filter((p) => p.restStatus !== 'DISCARDED')
  const bottling = bottlingRow
  const lab = currentLab(state, lot.id)
  const dossier = lotDossier(state, lot.id)
  const denomination = lotDenomination(state, lot, now)
  const lotCode = lot.lotCode ?? ''

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
  // El dictamen que cuenta es el de la uva que entró a tanques (o, si ninguna entró, el de la no rechazada).
  const crushed = harvests.filter((h) => harvestInTank(state, h.id))
  const judged = crushed.length > 0 ? crushed : harvests.filter((h) => h.phytosanitaryStatus !== 'REJECTED')
  const tankIds = new Set(tanks.map((t) => t.id))
  // La crianza que fijó la disponibilidad del lote: la de desbloqueo más tardío.
  const aging = agings.map((a) => ({ row: a, lock: agingLockOf(a, lot.rules, today) })).sort((a, b) => b.lock.unlockDate.localeCompare(a.lock.unlockDate))[0]
  const allClosed = productions.length > 0 && productions.every((p) => p.processEndDate)
  const restUntil = maxDay(productions.map((p) => restLockOf(p, lot.rules, today)?.unlockDate ?? null).filter((d): d is string => d !== null))
  // Grado del corazón: el común a las destilaciones o, si difieren, su media ponderada por litros.
  const hearts = productions.map(distillationHeart)
  let heartAbv: number | null = null
  if (hearts.length > 0 && hearts.every((h) => h.abv !== null)) {
    if (new Set(hearts.map((h) => h.abv)).size === 1) heartAbv = hearts[0]!.abv
    else if (hearts.every((h) => h.liters !== null)) {
      const liters = hearts.reduce((s, h) => s + (h.liters as number), 0)
      heartAbv = liters > 0 ? Math.round((hearts.reduce((s, h) => s + (h.liters as number) * (h.abv as number), 0) / liters) * 100) / 100 : null
    }
  }
  const corrections = state.corrections.filter((c) => c.lotId === lot.id)

  return {
    kind: 'LOT',
    lotCode,
    name: lot.name,
    productType,
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
      phytosanitary: judged.length > 0 && judged.every((h) => h.phytosanitaryStatus === 'APPROVED') ? 'APPROVED' : 'NOT_RECORDED',
      maturity: analysis ? { brixDegrees: analysis.brixDegrees, ph: analysis.ph, acidityGl: analysis.acidityGl } : null,
    },
    fermentation: {
      status: tanks.length > 0 ? 'RECORDED' : 'NOT_RECORDED',
      // Instantes (ISO 8601), no fechas de calendario: el tanque guarda cuándo se llenó y cuándo terminó.
      startDate: minInstant(tanks.map((t) => t.startDate)),
      endDate: tanks.length > 0 && tanks.every((t) => t.endDate) ? maxInstant(tanks.map((t) => t.endDate as string)) : null,
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
            containerType: aging.row.containerType,
            containerMaterial: aging.row.containerMaterial ?? null,
            plannedMonths: aging.row.plannedMonths,
            startDate: agingStartDay(aging.row),
            unlockDate: aging.lock.unlockDate,
          }
        : { status: 'NOT_RECORDED', containerType: null, containerMaterial: null, plannedMonths: null, startDate: null, unlockDate: null },
    distillation: !isSingani
      ? { status: 'NOT_APPLICABLE', startDate: null, endDate: null, heartAbvPercent: null, restMinDays: null, restUntil: null }
      : productions.length > 0
        ? {
            status: 'RECORDED',
            startDate: minDay(productions.map((p) => dayOf(p.processStartDate))),
            endDate: allClosed ? maxDay(productions.map((p) => dayOf(p.processEndDate as string))) : null,
            heartAbvPercent: heartAbv,
            restMinDays: lot.rules.singani.minRestDays,
            restUntil,
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
    rules: { takenAt: lot.rules.takenAt, origin: lot.rules.origin, items: ruleItems(lot, isSingani) },
    timeline: publicTimeline(state, lot.id),
    corrections: { count: corrections.length, lastAt: corrections.map((c) => c.createdAt).sort().at(-1) ?? null },
    // `hash` y `canonicalUrl` solo con el expediente cerrado. Las URL son rutas relativas de la API
    // (`/v1/public/lots/…`) que la app resuelve contra su proxy; el backend puede darlas absolutas (`API_PUBLIC_URL`).
    dossier: {
      status: dossier?.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
      hash: dossier?.status === 'CLOSED' ? (dossier.hash ?? null) : null,
      closedAt: dossier?.status === 'CLOSED' ? (dossier.closedAt ?? null) : null,
      canonicalUrl: dossier?.status === 'CLOSED' ? `/v1/public/lots/${encodeURIComponent(lotCode)}/dossier` : null,
      anchor: publicAnchorView(state.chain, lot.id),
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
  // La prueba solo se da si el código entró en la raíz del expediente: uno anulado **antes** del
  // cierre no la tiene; uno anulado **después** (S-14) la conserva, con `status: VOIDED`.
  return {
    kind: 'BOTTLE',
    bottle: {
      code: bottle.code,
      codeFormatted: formatBottleCode(bottle.code),
      serial: bottle.serial,
      lotTotal: bottleLot.total,
      status: voided ? 'VOIDED' : 'ACTIVE',
      merkleProof: bottleMerkleProofOf(state, lot, bottleLot, bottle),
    },
    lot: buildLotPassport(state, lot, winery, now),
    redemption: null,
  }
}

/** Prueba Merkle de un código concreto (también uno ya sustituido o anulado tras el cierre). */
function bottleMerkleProofOf(state: TraceState, lot: Lot, bottleLot: BottleLot, bottle: { code: string; serial: number; generation: number }): PublicBottlePassport['bottle']['merkleProof'] {
  const dossier = lotDossier(state, lot.id)
  if (dossier?.status !== 'CLOSED' || !dossier.closedAt) return null
  // Anulado (él o todo el lote) antes del cierre: no entró en la raíz.
  const own = bottleLot.voided.find((v) => v.code === bottle.code)
  if (own && own.at <= dossier.closedAt) return null
  if (bottleLot.allVoided && bottleLot.allVoided.at <= dossier.closedAt) return null
  return bottleMerkleProof(state, lot, bottle.serial, bottle.generation)
}

/** Lote de un código de lote (sin distinguir mayúsculas). Solo los que tienen `lotCode` (embotellados). */
export function findLotByCode(state: TraceState, lotCode: string): Lot | null {
  const wanted = lotCode.trim().toUpperCase()
  return state.lots.find((l) => l.lotCode !== null && l.lotCode.toUpperCase() === wanted && bottleLotOf(state, l.id) !== null) ?? null
}
