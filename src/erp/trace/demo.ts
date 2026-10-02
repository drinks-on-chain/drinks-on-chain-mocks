import { uid } from '../../shared/uuid'
import type { Lot, TraceActor } from '../schemas'
import { actorOfMember, migratedLotId, reviewLot } from './backfill'
import { bottleLot, exportBottleCodesCsv, lotBottlingRequest, registerLab, voidBottleCode } from './bottling'
import { isoSeconds } from './dates'
import { computeBottlingBalance } from './domain'
import { addAttachment, closeDossier, correctLot } from './dossier'
import { discardLot, removeLot, updateLot } from './lots'
import {
  addLog,
  addMaturityAnalysis,
  addTreatment,
  closeDistillation,
  completeTank,
  createAging,
  createDistillation,
  createHarvest,
  createTank,
  decidePhyto,
} from './records'
import { addComplianceIssue, bottleCodeOf, bottleLotOf, createLot, ctxAt, lotBottling, releaseLocks, type TraceCtx, type TraceState } from './state'
import { bottlingInputOf } from './backfill'

// Lotes de demostración nativos de la Ola 2 (los demás vienen de la migración de los datos
// anteriores). Se construyen recorriendo los mismos servicios que los handlers, cada paso en su
// fecha: así los fixtures cumplen las reglas por construcción y llevan su línea de tiempo real.
// El caso del contrato §18 —Destilería Cinti Viejo, «Singani Gran Reserva 2026», 2.950 botellas—
// se puede rehacer hasta cualquier etapa: es lo que hacen los escenarios de `/__mocks`.

const DAY_MS = 86_400_000

/** Nombre y bodega del lote del caso del contrato §18. */
export const SINGANI_CASE = {
  name: 'Singani Gran Reserva 2026',
  wineryId: uid('winery:cintiviejo'),
  /** Pesaje del lote (su id fija el del lote, como en los migrados). */
  harvestBatchId: uid('demo:sgr-2026:harvest:1'),
  lotId: migratedLotId(uid('demo:sgr-2026:harvest:1')),
  bottles: 2950,
  /** Serie cuyo código se anuló y se sustituyó (etiqueta dañada). */
  replacedSerial: 17,
} as const

/** Hasta dónde llega el caso: en reposo, listo para embotellar, embotellado, con laboratorio o con el expediente cerrado. */
export type SinganiCaseStage = 'RESTING' | 'READY' | 'BOTTLED' | 'LAB' | 'CERTIFIED'

export interface SinganiCaseOptions {
  upTo?: SinganiCaseStage
  /** Días desde el cierre de la destilación (185 → reposo de 180 días ya cumplido; 170 → faltan 10). */
  closedDaysAgo?: number
  lab?: 'CONFORMING' | 'NON_CONFORMING'
}

/** Ids deterministas de un lote de demostración (`demo:<clave>:<recurso>:<n>`). */
function demoIds(key: string): (kind: string) => string {
  const counters: Record<string, number> = {}
  return (kind) => uid(`demo:${key}:${kind}:${(counters[kind] = (counters[kind] ?? 0) + 1)}`)
}

function member(state: TraceState, key: string): TraceActor {
  const actor = actorOfMember(state, uid(`member:${key}`))
  if (!actor) throw new Error(`Lote de demostración: falta el miembro ${key}`)
  return actor
}

/** Pasos de un lote de demostración: cada uno con su fecha (días antes de hoy, hora UTC) y su autor. */
function stepper(state: TraceState, ctx: TraceCtx, key: string) {
  const newId = demoIds(key)
  const base = Date.parse(`${ctx.today}T00:00:00Z`)
  const at = (daysAgo: number, hour = 14, minute = 0) => isoSeconds(base - daysAgo * DAY_MS + hour * 3_600_000 + minute * 60_000)
  const day = (daysAgo: number) => at(daysAgo, 0).slice(0, 10)
  const as = (who: string | null, daysAgo: number, hour = 14, minute = 0): TraceCtx => ({ ...ctxAt(ctx, at(daysAgo, hour, minute), who ? member(state, who) : null), newId })
  return { at, day, as }
}

const fileKey = (wineryId: string, folder: string, name: string) => `org/${wineryId}/${folder}/2026/${name}`

/**
 * Caso del contrato §18: la enóloga crea el lote singani (estimación 3.000, 75 cL, 40 %), el
 * operario pesa 18.400 kg, el agrónomo aprueba el dictamen, tanque de 12.100 L, destilación con
 * cabezas 120 L, corazón 1.500 L al 60 % y colas 210 L, reposo de 180 días, embotellado de 2.950
 * botellas con 750 L de agua (merma 1,7 %; alcohol puro 885 L ≤ 900 L), laboratorio conforme y
 * expediente cerrado con su huella.
 */
export function runSinganiCase(state: TraceState, ctx: TraceCtx, options: SinganiCaseOptions = {}): Lot {
  const { upTo = 'CERTIFIED', closedDaysAgo = 185, lab = 'CONFORMING' } = options
  const { at, day, as } = stepper(state, ctx, 'sgr-2026')
  const W = SINGANI_CASE.wineryId
  const harvestYear = Number(day(200).slice(0, 4))
  const lot = createLot(
    state,
    as('cvj_enologa', 202),
    W,
    {
      name: SINGANI_CASE.name,
      harvestYear,
      productType: 'SINGANI',
      estimatedBottles: 3000,
      plannedFormatCl: 75,
      targetAbvPercent: 40,
      plannedTerroirIds: [uid('terroir:cvj_02')],
      notes: 'Edición de la vendimia 2026 con la uva de Cañón Viejo.',
    },
    { id: SINGANI_CASE.lotId },
  )
  const harvest = createHarvest(state, as('cvj_operario', 200, 13, 40), W, {
    lotId: lot.id,
    terroirId: uid('terroir:cvj_02'),
    intakeDate: at(200, 13, 40),
    grossWeightKg: 18550,
    tareWeightKg: 150,
    temperatureAtIntakeC: 15.8,
    notes: 'Cosecha manual matutina en cajas de 15 kg.',
  })
  addMaturityAnalysis(state, as('cvj_enologa', 200, 15, 10), harvest, { brixDegrees: 23.4, ph: 3.4, acidityGl: 5.9, measuredAt: at(200, 14, 30) })
  correctLot(state, as('cvj_operario', 200, 18), lot, {
    target: { type: 'HARVEST_BATCH', id: harvest.id },
    kind: 'AMEND',
    changes: { temperatureAtIntakeC: 16.2 },
    reason: 'Lectura del termómetro mal transcrita en la planilla de recepción',
  })
  decidePhyto(state, as('cvj_agronomo', 199, 13), harvest, {
    decision: 'APPROVED',
    inspectionReportKey: fileKey(W, 'inspections', 'acta-fitosanitaria-sgr-2026.pdf'),
    notes: 'Racimos sanos, sin botritis ni oídio.',
  })
  const tank = createTank(state, as('cvj_enologa', 199, 16), W, {
    lotId: lot.id,
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-11',
    capacityLiters: 15000,
    material: 'Acero inoxidable AISI 316',
    volumeFilledLiters: 12100,
    startFermentation: true,
    startDate: day(199),
  })
  addTreatment(state, as('cvj_enologa', 199, 17), tank, {
    treatmentType: 'SO2_ADDITION',
    additiveName: 'Metabisulfito de potasio grado alimentario',
    additiveSupplier: 'Laffort Oenologie',
    dosageAppliedGPerHl: 3,
    totalAppliedG: 363,
    regulatoryAuthCode: 'SENASAG-REG-ADD-2024-88',
    appliedAt: at(199, 17),
    notes: 'Sulfitado inicial',
  })
  const operario = member(state, 'cvj_operario')
  const readings: [number, number, number][] = [
    [198, 21.4, 1.086],
    [196, 23.1, 1.061],
    [194, 23.8, 1.034],
    [192, 22.6, 1.012],
    [190, 21.0, 0.996],
  ]
  for (const [daysAgo, temperatureCelsius, specificGravity] of readings) {
    addLog(state, as('cvj_operario', daysAgo, 12), tank, { temperatureCelsius, specificGravity, phValue: 3.42, recordedAt: at(daysAgo, 12) }, operario.userId)
  }
  completeTank(state, as('cvj_enologa', 188, 15), tank, { endDate: day(188), finalVolumeLiters: 12100, destination: 'SINGANI_DIST' })
  const distillation = createDistillation(state, as('cvj_enologa', closedDaysAgo + 2, 13), W, {
    fermentationTankId: tank.id,
    equipmentIdentifier: 'Alambique de cobre Charentais AL-01',
    processStartDate: day(closedDaysAgo + 2),
    inputVolumeLiters: 12100,
    notes: 'Destilación lenta a fuego directo con separación estricta de cabezas',
  })
  closeDistillation(state, as('cvj_enologa', closedDaysAgo, 20), distillation, {
    processEndDate: day(closedDaysAgo),
    cuts: { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 },
    heartAbvPercent: 60,
  })
  updateLot(state, as('cvj_enologa', closedDaysAgo - 1, 14), lot, { estimatedBottles: SINGANI_CASE.bottles, reason: 'Rendimiento real del corazón tras la destilación' })
  if (upTo === 'RESTING' || closedDaysAgo < 180) return lot

  releaseLocks(state, as(null, closedDaysAgo - 180, 4, 5), lot.id)
  if (upTo === 'READY') return lot

  bottleLot(
    state,
    as('cvj_enologa', 3, 15),
    lot,
    lotBottlingRequest(state, lot, {
      bottlingDate: day(3),
      packagingFormatCl: 75,
      totalBottlesPackaged: SINGANI_CASE.bottles,
      finalAlcoholAbv: 40,
      waterDilutionLiters: 750,
      bottleType: 'Vidrio extra-flint 750 ml',
      labelDesignKey: fileKey(W, 'labels', 'etiqueta-sgr-2026.png'),
    }),
  )
  const codes = bottleLotOf(state, lot.id)!
  voidBottleCode(state, as('cvj_enologa', 3, 17), W, bottleCodeOf(codes, SINGANI_CASE.replacedSerial), { reason: 'Etiqueta dañada en la línea de envasado', replace: true })
  exportBottleCodesCsv(state, as('cvj_enologa', 3, 18), lot)
  addAttachment(state, as('cvj_enologa', 3, 18, 30), lot, { key: fileKey(W, 'labels', 'etiqueta-sgr-2026.png'), kind: 'LABEL', title: 'Etiqueta frontal aprobada' })
  if (upTo === 'BOTTLED') return lot

  registerLab(state, as('cvj_enologa', 2, 16), lot, {
    certifiedLaboratoryName: 'Laboratorio de Servicios Analíticos ISO 17025',
    accreditedLabCertificationCode: 'LAB-SENASAG-2026-884',
    analysisRequestDate: day(3),
    testPerformedAt: day(2),
    actualAlcoholAbv: 40.1,
    totalAlcoholAbv: 40.1,
    totalAcidityTartaricGl: 4.7,
    volatileAcidityAceticGl: 0.21,
    methanolMg100mlAa: lab === 'CONFORMING' ? 46.5 : 385,
    copperContentMgL: 0.8,
    laboratoryReportKey: fileKey(W, 'lab-reports', 'informe-sgr-2026.pdf'),
    conformsToEuStandards: true,
    conformsToUsaStandards: true,
  })
  if (upTo === 'LAB' || lab === 'NON_CONFORMING') return lot

  addAttachment(state, as('cvj_admin', 2, 17), lot, { key: fileKey(W, 'certificates', 'certificado-do-singani-2026.pdf'), kind: 'DO_CERTIFICATE', title: 'Certificado de la D.O. Singani 2026' })
  closeDossier(state, as('cvj_admin', 1, 15), lot)
  return lot
}

/** Lote en origen (planificación y preventa temprana): sin pesajes todavía. */
function runOriginLot(state: TraceState, ctx: TraceCtx): void {
  const { as } = stepper(state, ctx, 'origen-2026')
  createLot(state, as('cvj_admin', 10), uid('winery:cintiviejo'), {
    name: 'Singani Edición Aniversario 2026',
    harvestYear: Number(ctx.today.slice(0, 4)),
    productType: 'SINGANI',
    estimatedBottles: 1800,
    plannedFormatCl: 70,
    targetAbvPercent: 40,
    plannedTerroirIds: [uid('terroir:cvj_04')],
    targetReadyDate: `${Number(ctx.today.slice(0, 4)) + 1}-06-30`,
    notes: 'Lote previsto para la preventa de aniversario.',
  })
}

/** Lote singani con la destilación abierta (`DISTILLING`). */
function runDistillingLot(state: TraceState, ctx: TraceCtx): void {
  const { at, day, as } = stepper(state, ctx, 'molino-2026')
  const W = uid('winery:cintiviejo')
  const harvestId = uid('demo:molino-2026:harvest:1')
  const lot = createLot(
    state,
    as('cvj_enologa', 191),
    W,
    { name: 'Singani El Molino 2026', harvestYear: Number(day(190).slice(0, 4)), productType: 'SINGANI', estimatedBottles: 1400, plannedFormatCl: 75, targetAbvPercent: 40, plannedTerroirIds: [uid('terroir:cvj_04')] },
    { id: migratedLotId(harvestId) },
  )
  const harvest = createHarvest(state, as('cvj_operario', 190, 13, 20), W, {
    lotId: lot.id,
    terroirId: uid('terroir:cvj_04'),
    intakeDate: at(190, 13, 20),
    grossWeightKg: 9150,
    tareWeightKg: 150,
    temperatureAtIntakeC: 16.4,
    maturity: { brixDegrees: 22.9, ph: 3.38, acidityGl: 6.4 },
  })
  decidePhyto(state, as('cvj_agronomo', 189, 13), harvest, { decision: 'APPROVED', notes: 'Sin incidencias.' })
  const tank = createTank(state, as('cvj_enologa', 189, 16), W, {
    lotId: lot.id,
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-12',
    capacityLiters: 8000,
    material: 'Acero inoxidable AISI 316',
    volumeFilledLiters: 5900,
    startFermentation: true,
    startDate: day(189),
  })
  completeTank(state, as('cvj_enologa', 165, 15), tank, { endDate: day(165), finalVolumeLiters: 5800, destination: 'SINGANI_DIST' })
  createDistillation(state, as('cvj_enologa', 3, 13), W, {
    fermentationTankId: tank.id,
    equipmentIdentifier: 'Alambique de cobre AL-02',
    processStartDate: day(3),
    inputVolumeLiters: 5800,
  })
}

/** Uva recibida sin lote (`lotId: null`): entra a un lote al llenar un tanque. */
function runUnassignedHarvest(state: TraceState, ctx: TraceCtx): void {
  const { at, as } = stepper(state, ctx, 'uva-sin-lote')
  createHarvest(state, as('cvj_operario', 2, 13, 5), uid('winery:cintiviejo'), {
    terroirId: uid('terroir:cvj_01'),
    intakeDate: at(2, 13, 5),
    grossWeightKg: 4350,
    tareWeightKg: 150,
    temperatureAtIntakeC: 17.1,
    notes: 'Uva recibida de la segunda pasada; pendiente de asignar a un lote.',
  })
}

/** Lote en fermentación, aún sin tipo de producto, con la última lectura por encima de 32 °C (alerta del panel). */
function runFermentingLot(state: TraceState, ctx: TraceCtx): void {
  const { at, day, as } = stepper(state, ctx, 'sauces-2026')
  const W = uid('winery:altos')
  const harvest = createHarvest(state, as('altos_enologa', 9, 13, 30), W, {
    newLot: { name: 'Moscatel Los Sauces 2026', harvestYear: Number(day(9).slice(0, 4)), estimatedBottles: 5200, plannedFormatCl: 75 },
    terroirId: uid('terroir:altos_02'),
    intakeDate: at(9, 13, 30),
    grossWeightKg: 7550,
    tareWeightKg: 150,
    temperatureAtIntakeC: 18.2,
    maturity: { brixDegrees: 22.6, ph: 3.44, acidityGl: 6.3 },
  })
  decidePhyto(state, as('altos_agronomo', 8, 13), harvest, { decision: 'APPROVED', notes: 'Uva sana.' })
  const tank = createTank(state, as('altos_enologa', 8, 16), W, {
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-15',
    capacityLiters: 8000,
    material: 'Acero inoxidable AISI 304',
    volumeFilledLiters: 5200,
    startFermentation: true,
    startDate: day(8),
  })
  const operario = member(state, 'altos_operario')
  const readings: [number, number, number, number][] = [
    [7, 12, 22.3, 1.088],
    [5, 12, 24.9, 1.064],
    [3, 12, 27.8, 1.041],
    [2, 12, 30.6, 1.028],
    [1, 22, 33.4, 1.019],
  ]
  for (const [daysAgo, hour, temperatureCelsius, specificGravity] of readings) {
    addLog(state, as('altos_operario', daysAgo, hour), tank, { temperatureCelsius, specificGravity, recordedAt: at(daysAgo, hour) }, operario.userId)
  }
}

/** Lote de vino descartado por la bodega durante la crianza (`DISCARDED`). */
function runDiscardedLot(state: TraceState, ctx: TraceCtx): void {
  const { at, day, as } = stepper(state, ctx, 'loma-alta-2026')
  const W = uid('winery:altos')
  const harvest = createHarvest(state, as('altos_enologa', 195, 13, 15), W, {
    newLot: { name: 'Syrah Loma Alta 2026', harvestYear: Number(day(195).slice(0, 4)), productType: 'WINE', estimatedBottles: 5600, plannedFormatCl: 75 },
    terroirId: uid('terroir:altos_04'),
    intakeDate: at(195, 13, 15),
    grossWeightKg: 6900,
    tareWeightKg: 100,
    temperatureAtIntakeC: 14.6,
    maturity: { brixDegrees: 24.8, ph: 3.6, acidityGl: 5.6 },
  })
  decidePhyto(state, as('altos_agronomo', 194, 13), harvest, { decision: 'APPROVED', notes: 'Uva sana.' })
  const tank = createTank(state, as('altos_enologa', 194, 16), W, {
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-16',
    capacityLiters: 6000,
    material: 'Acero inoxidable AISI 304',
    volumeFilledLiters: 4600,
    startFermentation: true,
    startDate: day(194),
  })
  completeTank(state, as('altos_enologa', 170, 15), tank, { endDate: day(170), finalVolumeLiters: 4450, destination: 'WINE_AGING' })
  createAging(state, as('altos_enologa', 168, 14), W, {
    fermentationTankId: tank.id,
    containerType: 'Barrica',
    containerMaterial: 'Roble francés, tostado medio',
    containerCode: 'BAR-FR-2025-09',
    barrelUseCycle: 2,
    containerCount: 19,
    volumeLiters: 4300,
    plannedMonths: 10,
    startDate: day(168),
  })
  const lot = state.lots.find((l) => l.id === harvest.lotId) as Lot
  discardLot(state, as('altos_admin', 8, 15), lot, 'Contaminación por Brettanomyces detectada en las barricas')
}

// ---------------------------------------------------------------------------
// Casos del pasaporte público (los pide el visor `/b/{código}` del Marketplace)
// ---------------------------------------------------------------------------

/**
 * Códigos de lote de los fixtures que cubren cada caso del pasaporte público. Sirven para abrir el
 * visor en cada estado (`/b/{lotCode}`) y para las pruebas del Marketplace.
 */
export const PASSPORT_CASES = {
  /** Caso del contrato §18: expediente cerrado, laboratorio conforme, prueba Merkle. */
  certified: 'CVJ-2026-SINGANI-004',
  /** Embotellado, con laboratorio conforme y el expediente abierto (lote migrado). */
  bottled: 'CVJ-2026-SINGANI-001',
  /** Embotellado sin análisis de laboratorio: «No registrado». */
  labNotRecorded: 'CVJ-2026-WINE-003',
  /** Embotellado con el análisis vigente no conforme. */
  labNonConforming: 'ALT-2025-WINE-001',
  /** D.O. Singani por excepción legal (parcela a 1.540 m con el mínimo de la bodega en 1.500 m, A-31). */
  doByException: 'ALT-2025-SINGANI-002',
  /** Con un registro tardío en su línea de tiempo (pesaje anotado 12 días después). */
  lateEntry: 'ALT-2025-SINGANI-002',
  /** Lote retirado por la bodega tras embotellarse: `stage: DISCARDED` y todos sus códigos anulados. */
  discarded: 'CVJ-2025-SINGANI-001',
  /** Bodega suspendida: el pasaporte sigue visible con `winery.active: false` (S-23). */
  wineryInactive: 'CUR-2026-SINGANI-001',
} as const
export type PassportCase = keyof typeof PASSPORT_CASES

const LAB_ALTOS = { certifiedLaboratoryName: 'Laboratorio CENAVIT Tarija', accreditedLabCertificationCode: 'LAB-SENASAG-2025-417' }

/** Vino de Altos embotellado con el análisis vigente **no conforme** (acidez volátil sobre el límite). */
function runNonConformingLot(state: TraceState, ctx: TraceCtx): void {
  const { at, day, as } = stepper(state, ctx, 'angostura-2024')
  const W = uid('winery:altos')
  const harvest = createHarvest(state, as('altos_operario', 925, 13, 10), W, {
    newLot: undefined,
    lotId: createLot(state, as('altos_enologa', 926), W, { name: 'Tannat La Angostura 2024', harvestYear: Number(day(925).slice(0, 4)), productType: 'WINE', estimatedBottles: 4500, plannedFormatCl: 75 }).id,
    terroirId: uid('terroir:altos_01'),
    intakeDate: at(925, 13, 10),
    grossWeightKg: 5100,
    tareWeightKg: 100,
    temperatureAtIntakeC: 15.2,
    maturity: { brixDegrees: 24.6, ph: 3.62, acidityGl: 5.4 },
  })
  const lot = state.lots.find((l) => l.id === harvest.lotId) as Lot
  decidePhyto(state, as('altos_agronomo', 924, 13), harvest, { decision: 'APPROVED', notes: 'Uva sana.' })
  const tank = createTank(state, as('altos_enologa', 924, 16), W, {
    lotId: lot.id,
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-31',
    capacityLiters: 5000,
    material: 'Acero inoxidable AISI 304',
    volumeFilledLiters: 3600,
    startFermentation: true,
    startDate: day(924),
  })
  completeTank(state, as('altos_enologa', 900, 15), tank, { endDate: day(900), finalVolumeLiters: 3500, destination: 'WINE_AGING' })
  createAging(state, as('altos_enologa', 880, 14), W, {
    fermentationTankId: tank.id,
    containerType: 'Barrica',
    containerMaterial: 'Roble americano, tostado medio',
    containerCode: 'BAR-AM-2024-03',
    barrelUseCycle: 3,
    containerCount: 15,
    volumeLiters: 3400,
    plannedMonths: 12,
    startDate: day(880),
  })
  releaseLocks(state, as(null, 514, 4, 5), lot.id)
  bottleLot(state, as('altos_enologa', 420, 15), lot, lotBottlingRequest(state, lot, { bottlingDate: day(420), packagingFormatCl: 75, totalBottlesPackaged: 4400, finalAlcoholAbv: 13.8, bottleType: 'Bordelesa 750 ml' }))
  registerLab(state, as('altos_enologa', 415, 16), lot, {
    ...LAB_ALTOS,
    analysisRequestDate: day(418),
    testPerformedAt: day(415),
    actualAlcoholAbv: 13.9,
    totalAcidityTartaricGl: 5.6,
    // Por encima del límite de la instantánea (1,2 g/L): no conforme.
    volatileAcidityAceticGl: 1.45,
    freeSulfurDioxideMgL: 22,
    totalSulfurDioxideMgL: 96,
    laboratoryReportKey: fileKey(W, 'lab-reports', 'informe-tannat-la-angostura-2024.pdf'),
  })
}

/** Singani de Altos con D.O. por excepción legal (El Portillo, 1.540 m) y el pesaje anotado con retraso. */
function runExceptionLot(state: TraceState, ctx: TraceCtx): void {
  const { at, day, as } = stepper(state, ctx, 'portillo-2025')
  const W = uid('winery:altos')
  const lot = createLot(state, as('altos_enologa', 562), W, {
    name: 'Singani El Portillo 2025',
    harvestYear: Number(day(560).slice(0, 4)),
    productType: 'SINGANI',
    estimatedBottles: 1050,
    plannedFormatCl: 70,
    targetAbvPercent: 40,
    plannedTerroirIds: [uid('terroir:altos_03')],
  })
  // Registro tardío (S-9): la uva entró hace 560 días y el pesaje se anotó 12 días después.
  const harvest = createHarvest(state, as('altos_operario', 548, 14), W, {
    lotId: lot.id,
    terroirId: uid('terroir:altos_03'),
    intakeDate: at(560, 13, 20),
    grossWeightKg: 6120,
    tareWeightKg: 120,
    temperatureAtIntakeC: 16.8,
    notes: 'Pesaje pasado al ERP desde la planilla de recepción.',
  })
  addMaturityAnalysis(state, as('altos_enologa', 548, 15), harvest, { brixDegrees: 22.8, ph: 3.41, acidityGl: 6.1, measuredAt: at(560, 15) })
  decidePhyto(state, as('altos_agronomo', 548, 16), harvest, { decision: 'APPROVED', notes: 'Inspección en campo sin incidencias.', decidedAt: at(559, 13) })
  const tank = createTank(state, as('altos_enologa', 547, 14), W, {
    lotId: lot.id,
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-32',
    capacityLiters: 5000,
    material: 'Acero inoxidable AISI 304',
    volumeFilledLiters: 4000,
    startFermentation: true,
    startDate: day(559),
  })
  completeTank(state, as('altos_enologa', 540, 15), tank, { endDate: day(540), finalVolumeLiters: 3900, destination: 'SINGANI_DIST' })
  const distillation = createDistillation(state, as('altos_enologa', 534, 13), W, {
    fermentationTankId: tank.id,
    equipmentIdentifier: 'Alambique de cobre AL-A1',
    processStartDate: day(534),
    inputVolumeLiters: 3900,
  })
  closeDistillation(state, as('altos_enologa', 530, 19), distillation, { processEndDate: day(530), cuts: { headsLiters: 40, heartLiters: 480, tailsLiters: 70 }, heartAbvPercent: 62 })
  releaseLocks(state, as(null, 350, 4, 5), lot.id)
  bottleLot(
    state,
    as('altos_enologa', 300, 15),
    lot,
    lotBottlingRequest(state, lot, { bottlingDate: day(300), packagingFormatCl: 70, totalBottlesPackaged: 1040, finalAlcoholAbv: 40, waterDilutionLiters: 260, bottleType: 'Vidrio extra-flint 700 ml' }),
  )
  registerLab(state, as('altos_enologa', 297, 16), lot, {
    ...LAB_ALTOS,
    analysisRequestDate: day(299),
    testPerformedAt: day(297),
    actualAlcoholAbv: 40,
    totalAcidityTartaricGl: 4.5,
    volatileAcidityAceticGl: 0.19,
    methanolMg100mlAa: 58,
    copperContentMgL: 1.1,
    laboratoryReportKey: fileKey(W, 'lab-reports', 'informe-singani-el-portillo-2025.pdf'),
  })
}

/** Singani de Cinti Viejo retirado por la bodega después de embotellarse: lote `DISCARDED` y códigos anulados. */
function runWithdrawnLot(state: TraceState, ctx: TraceCtx): void {
  const { at, day, as } = stepper(state, ctx, 'san-roque-2024')
  const W = uid('winery:cintiviejo')
  const lot = createLot(state, as('cvj_enologa', 932), W, {
    name: 'Singani Los Parrales 2024',
    harvestYear: Number(day(930).slice(0, 4)),
    productType: 'SINGANI',
    estimatedBottles: 1150,
    plannedFormatCl: 75,
    targetAbvPercent: 40,
    plannedTerroirIds: [uid('terroir:cvj_01')],
  })
  const harvest = createHarvest(state, as('cvj_operario', 930, 13, 30), W, {
    lotId: lot.id,
    terroirId: uid('terroir:cvj_01'),
    intakeDate: at(930, 13, 30),
    grossWeightKg: 7150,
    tareWeightKg: 150,
    temperatureAtIntakeC: 15.4,
    maturity: { brixDegrees: 23.1, ph: 3.39, acidityGl: 6 },
  })
  decidePhyto(state, as('cvj_agronomo', 929, 13), harvest, { decision: 'APPROVED', notes: 'Sin incidencias.' })
  const tank = createTank(state, as('cvj_enologa', 929, 16), W, {
    lotId: lot.id,
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-33',
    capacityLiters: 6000,
    material: 'Acero inoxidable AISI 316',
    volumeFilledLiters: 4700,
    startFermentation: true,
    startDate: day(929),
  })
  completeTank(state, as('cvj_enologa', 910, 15), tank, { endDate: day(910), finalVolumeLiters: 4600, destination: 'SINGANI_DIST' })
  const distillation = createDistillation(state, as('cvj_enologa', 905, 13), W, {
    fermentationTankId: tank.id,
    equipmentIdentifier: 'Alambique de cobre AL-02',
    processStartDate: day(905),
    inputVolumeLiters: 4600,
  })
  closeDistillation(state, as('cvj_enologa', 902, 19), distillation, { processEndDate: day(902), cuts: { headsLiters: 50, heartLiters: 560, tailsLiters: 85 }, heartAbvPercent: 61 })
  releaseLocks(state, as(null, 722, 4, 5), lot.id)
  bottleLot(
    state,
    as('cvj_enologa', 500, 15),
    lot,
    lotBottlingRequest(state, lot, { bottlingDate: day(500), packagingFormatCl: 75, totalBottlesPackaged: 1120, finalAlcoholAbv: 40, waterDilutionLiters: 290, bottleType: 'Vidrio extra-flint 750 ml' }),
  )
  discardLot(state, as('cvj_admin', 30, 15), lot, 'Partida retirada por turbidez detectada en el control de almacén')
}

/** Singani de Casa Uriondo, una bodega **suspendida**: su pasaporte sigue visible con `winery.active: false`. */
function runSuspendedWineryLot(state: TraceState, ctx: TraceCtx): void {
  const { at, day, as } = stepper(state, ctx, 'uriondo-2025')
  const W = uid('winery:uriondo')
  const terroirId = uid('terroir:uriondo_01')
  state.terroirs.push({
    id: terroirId,
    wineryId: W,
    parcelName: 'Finca La Cabaña · Parrales del Río',
    cadastreCode: 'CAT-URI-0412',
    surfaceHectares: 2.8,
    altitudeMasl: 1740,
    latitude: -21.692,
    longitude: -64.668,
    geographicPolygonGeojson: null,
    rawMaterialType: 'uva',
    varietyName: 'Moscatel de Alejandría',
    soilType: 'Franco-limoso',
    irrigationSystem: 'Riego por goteo',
    isDoEligible: true,
    doType: 'D.O. Singani',
    doCertificateUrl: null,
    isActive: true,
    createdAt: at(700, 11),
  })
  const owner = 'sofia:uriondo'
  const lot = createLot(state, as(owner, 562), W, {
    name: 'Singani Casa Uriondo 2025',
    harvestYear: Number(day(560).slice(0, 4)),
    productType: 'SINGANI',
    estimatedBottles: 900,
    plannedFormatCl: 75,
    targetAbvPercent: 40,
    plannedTerroirIds: [terroirId],
  })
  const harvest = createHarvest(state, as(owner, 560, 13, 45), W, {
    lotId: lot.id,
    terroirId,
    intakeDate: at(560, 13, 45),
    grossWeightKg: 5600,
    tareWeightKg: 100,
    temperatureAtIntakeC: 17.3,
    maturity: { brixDegrees: 22.4, ph: 3.45, acidityGl: 6.2 },
  })
  decidePhyto(state, as(owner, 559, 13), harvest, { decision: 'APPROVED', notes: 'Uva sana.' })
  const tank = createTank(state, as(owner, 559, 16), W, {
    lotId: lot.id,
    inputs: [{ harvestBatchId: harvest.id }],
    tankCode: 'TK-01',
    capacityLiters: 5000,
    material: 'Acero inoxidable AISI 304',
    volumeFilledLiters: 3700,
    startFermentation: true,
    startDate: day(559),
  })
  completeTank(state, as(owner, 541, 15), tank, { endDate: day(541), finalVolumeLiters: 3600, destination: 'SINGANI_DIST' })
  const distillation = createDistillation(state, as(owner, 536, 13), W, {
    fermentationTankId: tank.id,
    equipmentIdentifier: 'Alambique de cobre CU-01',
    processStartDate: day(536),
    inputVolumeLiters: 3600,
  })
  closeDistillation(state, as(owner, 533, 19), distillation, { processEndDate: day(533), cuts: { headsLiters: 38, heartLiters: 440, tailsLiters: 66 }, heartAbvPercent: 61 })
  releaseLocks(state, as(null, 353, 4, 5), lot.id)
  bottleLot(
    state,
    as(owner, 200, 15),
    lot,
    lotBottlingRequest(state, lot, { bottlingDate: day(200), packagingFormatCl: 75, totalBottlesPackaged: 880, finalAlcoholAbv: 40, waterDilutionLiters: 228, bottleType: 'Vidrio extra-flint 750 ml' }),
  )
  registerLab(state, as(owner, 197, 16), lot, {
    certifiedLaboratoryName: 'Laboratorio CENAVIT Tarija',
    accreditedLabCertificationCode: 'LAB-SENASAG-2026-052',
    analysisRequestDate: day(199),
    testPerformedAt: day(197),
    actualAlcoholAbv: 40.2,
    totalAcidityTartaricGl: 4.4,
    volatileAcidityAceticGl: 0.2,
    methanolMg100mlAa: 51,
    copperContentMgL: 0.9,
    laboratoryReportKey: fileKey(W, 'lab-reports', 'informe-singani-casa-uriondo-2025.pdf'),
  })
}

/**
 * Lotes nativos de la Ola 2 de los fixtures: uno en cada etapa que la migración no cubre, los casos
 * del pasaporte público (`PASSPORT_CASES`) y, el último, el caso del §18.
 */
export function runDemoLots(state: TraceState, ctx: TraceCtx): void {
  runOriginLot(state, ctx)
  runDistillingLot(state, ctx)
  runUnassignedHarvest(state, ctx)
  runFermentingLot(state, ctx)
  runDiscardedLot(state, ctx)
  runNonConformingLot(state, ctx)
  runExceptionLot(state, ctx)
  runWithdrawnLot(state, ctx)
  runSuspendedWineryLot(state, ctx)
  runSinganiCase(state, ctx)
}

/** Rehace el caso del §18 hasta otra etapa (escenarios `lote-en-reposo`, `lote-listo`, `laboratorio-no-conforme`). */
export function resetSinganiCase(state: TraceState, ctx: TraceCtx, options: SinganiCaseOptions): Lot {
  removeLot(state, SINGANI_CASE.lotId)
  return runSinganiCase(state, ctx, options)
}

/** Embotellado migrado al que el escenario `lote-con-incidencia` le devuelve su error de origen (agua 620 L). */
export const MIGRATION_ISSUE_BOTTLING_ID = uid('bottling:b02')

/**
 * Lote con incidencia de migración: deshace la corrección de realismo de CVJ-2026-SINGANI-002 (630 L
 * de agua → los 620 L originales) y repite la revisión de integridad, como una base que ya tenía
 * los datos anteriores: 2.140 botellas son 1.605 L y solo había 1.600 L (`TRC_BOTTLING_EXCEEDS_VOLUME`).
 */
export function injectMigrationIssue(state: TraceState, ctx: TraceCtx): Lot | null {
  const bottling = state.bottlings.find((b) => b.id === MIGRATION_ISSUE_BOTTLING_ID)
  const lot = bottling ? state.lots.find((l) => l.id === bottling.lotId) : undefined
  if (!bottling || !lot) return null
  bottling.waterDilutionLiters = 620
  const { input } = bottlingInputOf(state, lot, bottling)
  if (input) bottling.balance = computeBottlingBalance(input)
  for (const issue of reviewLot(state, ctx, lot)) addComplianceIssue(ctx, lot, { ...issue, source: 'MIGRATION' })
  if (ctx.now > lot.updatedAt) lot.updatedAt = ctx.now
  return lot
}

export { lotBottling }
