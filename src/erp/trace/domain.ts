import type { ApiErrorDetail } from '../../shared/envelope'
import type {
  BottlingBalance,
  DoCheck,
  DoEvaluation,
  DoStatus,
  LabConformity,
  LabConformityCheck,
  LabConformityStatus,
  LabLimit,
  LotLockInfo,
  LotProductType,
  LotRules,
  LotStageCode,
} from '../schemas'
import { LAB_UNITS } from '../schemas/lab-analyses'
import { addDaysYmd, addMonthsYmd, daysBetween, laterOf } from './dates'
import { legalMinimumOf, LOT_RULE_KEYS, violation } from './rules'

// Reglas puras de la trazabilidad confiable (contrato de la Ola 2): D.O., candados, balance del
// embotellado, conformidad del laboratorio y etapa del lote. Puerto de `src/modules/lots/domain/`
// del backend: mismos cálculos, mensajes y redondeos, para que mocks y servidor expliquen lo mismo.

// ---------------------------------------------------------------------------
// Denominación de origen (§3.1, §4.3; EA-03)
// ---------------------------------------------------------------------------

export interface DoRules {
  minAltitudeMasl: number
  requiredVarieties: string[]
  legalExceptions: string[]
}

export interface DoTerroir {
  id: string
  altitudeMasl: number
  varietyName: string
}

/** Cepa normalizada para comparar: sin mayúsculas, tildes ni espacios repetidos. Sin sinónimos (P-7). */
export function normalizeVariety(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export const doRulesFromLot = (rules: LotRules): DoRules => ({
  minAltitudeMasl: rules.singani.minAltitudeMasl,
  requiredVarieties: rules.singani.requiredVarieties,
  legalExceptions: rules.legalExceptions,
})

const varietyIn = (variety: string, list: readonly string[]): boolean => list.some((v) => normalizeVariety(v) === normalizeVariety(variety))

/**
 * Evalúa la D.O. de un conjunto de parcelas. `ELIGIBLE_BY_EXCEPTION`: cumple solo gracias a un
 * valor de la bodega bajo el mínimo legal autorizado (A-31). Sin parcelas → `NOT_APPLICABLE`.
 */
export function evaluateDo(terroirs: readonly DoTerroir[], rules: DoRules, rulesSource: DoEvaluation['rulesSource'], evaluatedAt: string): DoEvaluation {
  const legalAltitude = (legalMinimumOf(LOT_RULE_KEYS.minAltitudeMasl) as number | null) ?? rules.minAltitudeMasl
  const legalVarieties = (legalMinimumOf(LOT_RULE_KEYS.requiredVarieties) as string[] | null) ?? rules.requiredVarieties
  const checks: DoCheck[] = []
  let byException = false
  const seen = new Set<string>()
  for (const t of terroirs) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    const altitudePass = t.altitudeMasl >= rules.minAltitudeMasl
    const varietyPass = varietyIn(t.varietyName, rules.requiredVarieties)
    checks.push(
      { rule: 'ALTITUDE', settingKey: LOT_RULE_KEYS.minAltitudeMasl, required: rules.minAltitudeMasl, legalMinimum: legalAltitude, actual: t.altitudeMasl, pass: altitudePass, terroirId: t.id },
      {
        rule: 'VARIETY',
        settingKey: LOT_RULE_KEYS.requiredVarieties,
        required: [...rules.requiredVarieties],
        legalMinimum: [...legalVarieties],
        actual: t.varietyName,
        pass: varietyPass,
        terroirId: t.id,
      },
    )
    if (altitudePass && t.altitudeMasl < legalAltitude && rules.legalExceptions.includes(LOT_RULE_KEYS.minAltitudeMasl)) byException = true
    if (varietyPass && !varietyIn(t.varietyName, legalVarieties) && rules.legalExceptions.includes(LOT_RULE_KEYS.requiredVarieties)) byException = true
  }
  let status: DoStatus
  if (checks.length === 0) status = 'NOT_APPLICABLE'
  else if (checks.some((c) => !c.pass)) status = 'NOT_ELIGIBLE'
  else status = byException ? 'ELIGIBLE_BY_EXCEPTION' : 'ELIGIBLE'
  return { status, checks, rulesSource, evaluatedAt }
}

export const isDoEligible = (status: DoStatus): boolean => status === 'ELIGIBLE' || status === 'ELIGIBLE_BY_EXCEPTION'

/** Un detalle por regla incumplida (`TRC_DO_TERROIR_NOT_ELIGIBLE` o `TRC_DO_NOT_ELIGIBLE`). */
export function doViolations(
  evaluation: DoEvaluation,
  code: 'TRC_DO_TERROIR_NOT_ELIGIBLE' | 'TRC_DO_NOT_ELIGIBLE',
  names: Record<string, string> = {},
  extraMeta: (terroirId: string) => Record<string, unknown> = () => ({}),
): ApiErrorDetail[] {
  return evaluation.checks
    .filter((c) => !c.pass)
    .map((c) => {
      const parcel = names[c.terroirId] ?? 'La parcela'
      const message =
        c.rule === 'ALTITUDE'
          ? `D.O. Singani: ${parcel} está a ${String(c.actual)} msnm; el mínimo del lote es ${String(c.required)} msnm`
          : `D.O. Singani: la cepa "${String(c.actual)}" de ${parcel} no está entre las exigidas (${(c.required as string[]).join(', ')})`
      return violation(code, message, {
        field: code === 'TRC_DO_TERROIR_NOT_ELIGIBLE' ? 'terroirId' : null,
        rule: c.settingKey,
        expected: c.required,
        actual: c.actual,
        meta: { terroirId: c.terroirId, check: c.rule, ...extraMeta(c.terroirId) },
      })
    })
}

// ---------------------------------------------------------------------------
// Candados (§5.3; EA-01)
// ---------------------------------------------------------------------------

export interface AgingLockInput {
  id: string
  /** Inicio de la crianza (`YYYY-MM-DD`). */
  startDate: string
  plannedMonths: number
  /** `lockUntilDate` guardado (registros anteriores a la Ola 2). */
  storedUnlockDate: string | null
}

export interface RestLockInput {
  id: string
  /** Fin de la destilación (`YYYY-MM-DD`); `null` = abierta (sin candado todavía). */
  processEndDate: string | null
  storedUnlockDate: string | null
}

function finishLock(kind: LotLockInfo['kind'], sourceId: string, unlockDate: string, today: string, rule: LotLockInfo['rule']): LotLockInfo {
  const remaining = daysBetween(today, unlockDate)
  return { kind, sourceId, unlockDate, released: remaining <= 0, daysRemaining: Math.max(0, remaining), rule }
}

/**
 * Candado de crianza: inicio + meses planificados (nunca menos que el mínimo de la instantánea),
 * en meses de calendario. Con un registro anterior a la Ola 2 manda la fecha más tardía entre la
 * calculada y la guardada.
 */
export function agingLock(input: AgingLockInput, rules: LotRules, today: string): LotLockInfo {
  const minimum = rules.wine.minAgingMonths
  const applied = Math.max(input.plannedMonths, minimum)
  const unlockDate = laterOf(addMonthsYmd(input.startDate, applied), input.storedUnlockDate) as string
  return finishLock('AGING', input.id, unlockDate, today, {
    settingKey: LOT_RULE_KEYS.minAgingMonths,
    minimum,
    applied,
    unit: 'meses',
    legalException: rules.legalExceptions.includes(LOT_RULE_KEYS.minAgingMonths),
  })
}

/** Candado de reposo del singani: fin de la destilación + reposo mínimo de la instantánea. */
export function restLock(input: RestLockInput, rules: LotRules, today: string): LotLockInfo | null {
  if (!input.processEndDate) return null
  const minimum = rules.singani.minRestDays
  const unlockDate = laterOf(addDaysYmd(input.processEndDate, minimum), input.storedUnlockDate) as string
  return finishLock('REST', input.id, unlockDate, today, {
    settingKey: LOT_RULE_KEYS.minRestDays,
    minimum,
    applied: minimum,
    unit: 'días',
    legalException: rules.legalExceptions.includes(LOT_RULE_KEYS.minRestDays),
  })
}

/** Próximo candado sin liberar (el que antes se libera), o `null`. */
export function nextLock(locks: readonly LotLockInfo[]): LotLockInfo | null {
  const pending = locks.filter((l) => !l.released)
  if (pending.length === 0) return null
  return pending.reduce((a, b) => (a.unlockDate <= b.unlockDate ? a : b))
}

/** Fecha en que el lote queda listo por candados (el último en liberarse). */
export function readyDateFromLocks(locks: readonly LotLockInfo[]): string | null {
  if (locks.length === 0) return null
  return locks.reduce((a, b) => (a.unlockDate >= b.unlockDate ? a : b)).unlockDate
}

// ---------------------------------------------------------------------------
// Balance del embotellado (§6.2; EA-02)
// ---------------------------------------------------------------------------

export interface BottlingBalanceInput {
  productType: LotProductType
  /** Σ litros disponibles de las fuentes. */
  availableLiters: number
  waterDilutionLiters: number
  bottles: number
  formatCl: number
  leftoverLiters: number
  maxLossPercent: number
  finalAbv: number
  /** Singani: alcohol puro del corazón disponible (litros × grado). */
  pureAlcoholAvailableLiters: number | null
}

/** Tolerancia de medida del balance de alcohol (S-11). */
export const ALCOHOL_BALANCE_TOLERANCE = 0.005

export const roundTo = (n: number, d = 3): number => {
  const f = 10 ** d
  return Math.round(n * f) / f
}

export function computeBottlingBalance(input: BottlingBalanceInput): BottlingBalance {
  const bottledLiters = (input.bottles * input.formatCl) / 100
  const inputLiters = input.availableLiters + input.waterDilutionLiters
  const lossLiters = inputLiters - bottledLiters - input.leftoverLiters
  const lossPercent = inputLiters > 0 ? (lossLiters / inputLiters) * 100 : 0
  const room = Math.max(0, inputLiters - input.leftoverLiters)
  // Tolerancia de redondeo para no perder una botella por decimales.
  const maxBottles = Math.floor(((room + 1e-6) * 100) / input.formatCl)
  return {
    availableLiters: roundTo(input.availableLiters),
    waterDilutionLiters: roundTo(input.waterDilutionLiters),
    bottledLiters: roundTo(bottledLiters),
    leftoverLiters: roundTo(input.leftoverLiters),
    lossLiters: roundTo(lossLiters),
    lossPercent: roundTo(lossPercent, 2),
    maxLossPercent: input.maxLossPercent,
    pureAlcohol:
      input.productType === 'SINGANI' && input.pureAlcoholAvailableLiters !== null
        ? { availableLiters: roundTo(input.pureAlcoholAvailableLiters), bottledLiters: roundTo((bottledLiters * input.finalAbv) / 100) }
        : null,
    maxBottles,
  }
}

/** Violaciones de las reglas 4–6 del §6.2 (volumen y merma, alcohol, vino sin agua), en ese orden. */
export function bottlingBalanceViolations(input: BottlingBalanceInput, balance: BottlingBalance): ApiErrorDetail[] {
  const out: ApiErrorDetail[] = []
  const meta = { ...balance } as unknown as Record<string, unknown>
  const epsilon = 1e-6
  if (balance.bottledLiters + balance.leftoverLiters > balance.availableLiters + balance.waterDilutionLiters + epsilon) {
    out.push(
      violation(
        'TRC_BOTTLING_EXCEEDS_VOLUME',
        `${input.bottles} botellas de ${input.formatCl} cL son ${balance.bottledLiters} L y solo hay ${roundTo(balance.availableLiters + balance.waterDilutionLiters - balance.leftoverLiters)} L disponibles: caben como máximo ${balance.maxBottles} botellas`,
        { field: 'totalBottlesPackaged', expected: balance.maxBottles, actual: input.bottles, meta },
      ),
    )
  } else if (balance.lossPercent > input.maxLossPercent + epsilon) {
    out.push(
      violation(
        'TRC_BOTTLING_LOSS_ABOVE_TOLERANCE',
        `La merma sería del ${balance.lossPercent} % (${balance.lossLiters} L) y la tolerada por el lote es del ${input.maxLossPercent} %: declara el remanente o revisa las botellas`,
        { field: 'totalBottlesPackaged', rule: LOT_RULE_KEYS.maxLossPercent, expected: input.maxLossPercent, actual: balance.lossPercent, meta },
      ),
    )
  }
  if (
    input.productType === 'SINGANI' &&
    balance.pureAlcohol &&
    balance.pureAlcohol.bottledLiters > balance.pureAlcohol.availableLiters * (1 + ALCOHOL_BALANCE_TOLERANCE) + epsilon
  ) {
    out.push(
      violation(
        'TRC_ALCOHOL_BALANCE_EXCEEDED',
        `Las botellas llevarían ${balance.pureAlcohol.bottledLiters} L de alcohol puro y el corazón solo tiene ${balance.pureAlcohol.availableLiters} L (tolerancia 0,5 %)`,
        {
          field: 'finalAlcoholAbv',
          expected: balance.pureAlcohol.availableLiters,
          actual: balance.pureAlcohol.bottledLiters,
          meta: { tolerancePercent: ALCOHOL_BALANCE_TOLERANCE * 100, unit: 'L' },
        },
      ),
    )
  }
  if (input.productType === 'WINE' && input.waterDilutionLiters > 0) {
    out.push(violation('TRC_DILUTION_NOT_ALLOWED', 'No se admite agua en un vino', { field: 'waterDilutionLiters', expected: 0, actual: input.waterDilutionLiters }))
  }
  return out
}

// ---------------------------------------------------------------------------
// Conformidad del laboratorio (§8.3; EA-08)
// ---------------------------------------------------------------------------

/** Parámetros exigidos por producto (S-16). */
export const REQUIRED_LAB_PARAMETERS: Record<LotProductType, string[]> = {
  SINGANI: ['metanol', 'cobre', 'grado'],
  WINE: ['acidezVolatil', 'grado'],
}

/** Valores medidos que entran en la conformidad. */
export interface LabValues {
  actualAlcoholAbv: number | null
  volatileAcidityAceticGl: number | null
  methanolMg100mlAa: number | null
  copperContentMgL: number | null
}

type UnitKind = 'mg/100ml a.a.' | 'mg/l' | 'g/l' | '% v/v' | 'unknown'

/** Unidad normalizada de un límite del catálogo (`mg/100 ml a.a.`, `mg/l`, `g/l`). */
export function normalizeUnit(unit: string): UnitKind {
  const u = unit.toLowerCase().replace(/\s+/g, '').replace(/\.$/, '')
  if (/^mg\/100ml(a\.?a|alcoholanhidro)/.test(u)) return 'mg/100ml a.a.'
  if (u === 'mg/l' || u === 'mg/lt') return 'mg/l'
  if (u === 'g/l' || u === 'g/lt') return 'g/l'
  if (u.startsWith('%')) return '% v/v'
  return 'unknown'
}

/** Metanol en mg/100 mL de alcohol anhidro a partir de mg/L de producto y el grado: `10 × mgL / grado`. */
export function methanolToAnhydrous(mgL: number, abv: number): number | null {
  if (!(abv > 0)) return null
  return Math.round(((10 * mgL) / abv) * 1000) / 1000
}

function labSource(parameter: string, values: LabValues): { value: number | null; unit: UnitKind; label: string } | null {
  switch (parameter) {
    case 'metanol':
      return { value: values.methanolMg100mlAa, unit: 'mg/100ml a.a.', label: LAB_UNITS.methanolMg100mlAa }
    case 'cobre':
      return { value: values.copperContentMgL, unit: 'mg/l', label: 'mg/L' }
    case 'acidezVolatil':
      return { value: values.volatileAcidityAceticGl, unit: 'g/l', label: 'g/L' }
    case 'grado':
      return { value: values.actualAlcoholAbv, unit: '% v/v', label: LAB_UNITS.actualAlcoholAbv }
    default:
      return null
  }
}

function convertUnit(value: number, from: UnitKind, to: UnitKind, abv: number | null): number | null {
  if (from === to) return value
  if (from === 'mg/l' && to === 'g/l') return value / 1000
  if (from === 'g/l' && to === 'mg/l') return value * 1000
  // Metanol: mg/100 mL a.a. → mg/L de producto con el grado.
  if (from === 'mg/100ml a.a.' && to === 'mg/l' && abv && abv > 0) return (value * abv) / 10
  return null
}

/**
 * Conformidad contra los límites de la instantánea del lote. Falta un parámetro exigido →
 * `INCOMPLETE` (nunca conforme por omisión); unidad del límite desconocida → `UNIT_UNKNOWN` e
 * `INCOMPLETE`; un parámetro fuera de su límite → `NON_CONFORMING`. Aviso (no bloqueo) si el grado
 * medido difiere más de 0,5 % vol del etiquetado (S-15).
 */
export function computeLabConformity(input: {
  productType: LotProductType | null
  values: LabValues
  limits: Record<string, LabLimit>
  labeledAbv: number | null
  rulesTakenAt: string
}): LabConformity {
  const required = input.productType ? REQUIRED_LAB_PARAMETERS[input.productType] : ['grado']
  const parameters = [...required, ...Object.keys(input.limits).filter((p) => !required.includes(p))]
  const checks: LabConformityCheck[] = []
  for (const parameter of parameters) {
    const source = labSource(parameter, input.values)
    const limit = input.limits[parameter] ?? null
    const isRequired = required.includes(parameter)
    if (!source) {
      if (isRequired) checks.push({ parameter, value: null, unit: limit?.unidad ?? '', limit, result: 'MISSING' })
      continue
    }
    if (source.value === null || source.value === undefined) {
      if (isRequired) checks.push({ parameter, value: null, unit: source.label, limit, result: 'MISSING' })
      continue
    }
    if (!limit) {
      checks.push({ parameter, value: source.value, unit: source.label, limit: null, result: 'PASS' })
      continue
    }
    const target = normalizeUnit(limit.unidad)
    const value = target === 'unknown' ? null : convertUnit(source.value, source.unit, target, input.values.actualAlcoholAbv)
    if (value === null) {
      checks.push({ parameter, value: source.value, unit: source.label, limit, result: 'UNIT_UNKNOWN' })
      continue
    }
    const fail = (limit.max !== undefined && value > limit.max) || (limit.min !== undefined && value < limit.min)
    checks.push({ parameter, value: source.value, unit: source.label, limit, result: fail ? 'FAIL' : 'PASS' })
  }
  let status: LabConformityStatus
  if (checks.some((c) => c.result === 'FAIL')) status = 'NON_CONFORMING'
  else if (checks.some((c) => c.result === 'MISSING' || c.result === 'UNIT_UNKNOWN')) status = 'INCOMPLETE'
  else status = 'CONFORMING'

  const warnings: ApiErrorDetail[] = []
  const measured = input.values.actualAlcoholAbv
  if (measured !== null && input.labeledAbv !== null && Math.abs(measured - input.labeledAbv) > 0.5) {
    warnings.push({
      field: 'actualAlcoholAbv',
      message: `El grado medido (${measured} % vol) difiere más de 0,5 % vol del embotellado (${input.labeledAbv} % vol)`,
      code: 'LAB_ABV_DEVIATION',
      expected: input.labeledAbv,
      actual: measured,
      meta: { toleranceAbv: 0.5 },
    })
  }
  for (const c of checks.filter((x) => x.result === 'UNIT_UNKNOWN')) {
    warnings.push({
      field: null,
      message: `Unidad del límite "${c.parameter}" desconocida (${c.limit?.unidad ?? 'sin unidad'}): revisa la configuración`,
      code: 'VALIDATION_ERROR',
      meta: { parameter: c.parameter },
    })
  }
  return { status, checks, warnings, rulesTakenAt: input.rulesTakenAt }
}

// ---------------------------------------------------------------------------
// Etapa del lote (§2.2)
// ---------------------------------------------------------------------------

export interface LotStageInput {
  discarded: boolean
  dossierClosed: boolean
  productType: LotProductType | null
  harvestStatuses: readonly string[]
  tanks: number
  agings: readonly { discarded: boolean }[]
  distillations: readonly { closed: boolean; discarded: boolean }[]
  bottled: boolean
}

/** Etapa calculada a partir de los registros; ninguna ruta la fija a mano salvo el descarte. */
export function deriveLotStage(input: LotStageInput): LotStageCode {
  if (input.discarded) return 'DISCARDED'
  if (input.dossierClosed) return 'CERTIFIED'
  if (input.bottled) return 'BOTTLED'
  const distillations = input.distillations.filter((d) => !d.discarded)
  const agings = input.agings.filter((a) => !a.discarded)
  const distilling = (): LotStageCode => (distillations.some((d) => !d.closed) ? 'DISTILLING' : 'RESTING')
  if (distillations.length > 0 && input.productType !== 'WINE') return distilling()
  if (agings.length > 0) return 'AGING'
  if (distillations.length > 0) return distilling()
  if (input.tanks > 0) return 'FERMENTING'
  if (input.harvestStatuses.length > 0) return input.harvestStatuses.every((s) => s === 'REJECTED') ? 'REJECTED' : 'HARVEST'
  return 'ORIGIN'
}

/** Tipo de producto del destino de un tanque (`WINE_AGING` ↔ `WINE`, `SINGANI_DIST` ↔ `SINGANI`). */
export function productTypeOfDestination(destination: string | null | undefined): LotProductType | null {
  if (destination === 'WINE_AGING') return 'WINE'
  if (destination === 'SINGANI_DIST') return 'SINGANI'
  return null
}

export const DESTINATION_OF_PRODUCT: Record<LotProductType, 'WINE_AGING' | 'SINGANI_DIST'> = { WINE: 'WINE_AGING', SINGANI: 'SINGANI_DIST' }
