import { isBelowLegalMinimum } from '../../backoffice/model'
import type { StoredOverride, StoredSetting } from '../../backoffice/model'
import { DEFAULT_LAB_LIMITS, SETTINGS_CATALOG, settingEntry } from '../../backoffice/settings-catalog'
import type { ApiErrorDetail, TraceErrorCode } from '../../shared/envelope'
import type { LabLimit, LotRules } from '../schemas'

// Instantánea de reglas del lote (contrato de la Ola 2 §2.3, CFG-06) y forma de las violaciones.
// Como `domain/lot-rules.ts` y `domain/trace-errors.ts` del backend.

/** Claves del catálogo con `appliesAt: 'LOT'` que usa el lote (docs-back/05 §4). */
export const LOT_RULE_KEYS = {
  minAltitudeMasl: 'trazabilidad.singani.altitudMinimaMsnm',
  requiredVarieties: 'trazabilidad.singani.variedadesExigidas',
  minRestDays: 'trazabilidad.singani.reposoMinimoDias',
  minAgingMonths: 'trazabilidad.vino.crianzaMinimaMeses',
  requireApproved: 'trazabilidad.fitosanitario.exigirAprobado',
  maxLossPercent: 'trazabilidad.embotellado.mermaMaximaPorcentaje',
  labLimits: 'trazabilidad.laboratorio.limites',
} as const

/** Valores vigentes de una bodega para los parámetros `appliesAt: 'LOT'` (`SettingsService.snapshot`). */
export interface SettingsSnapshot {
  takenAt: string
  values: Record<string, unknown>
  sources: Record<string, 'GLOBAL' | 'WINERY'>
  /** Claves con un valor bajo el mínimo legal (autorizado por administración, A-31). */
  legalExceptions: string[]
}

/** Toma la instantánea de la configuración de una bodega: ajuste de la bodega → estándar general → catálogo. */
export function takeSettingsSnapshot(
  settings: readonly StoredSetting[],
  overrides: readonly StoredOverride[],
  wineryId: string,
  takenAt: string,
): SettingsSnapshot {
  const values: Record<string, unknown> = {}
  const sources: Record<string, 'GLOBAL' | 'WINERY'> = {}
  const legalExceptions: string[] = []
  for (const entry of SETTINGS_CATALOG) {
    if (entry.appliesAt !== 'LOT') continue
    const override = overrides.find((o) => o.key === entry.key && o.wineryId === wineryId)
    const global = settings.find((s) => s.key === entry.key)
    const value = override ? override.value : global ? global.value : entry.default
    values[entry.key] = value
    sources[entry.key] = override ? 'WINERY' : 'GLOBAL'
    if (isBelowLegalMinimum(entry, value)) legalExceptions.push(entry.key)
  }
  return { takenAt, values: structuredClone(values), sources, legalExceptions }
}

const defaultOf = <T>(key: string): T => settingEntry(key)?.default as T
const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const stringList = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...(value as string[])] : fallback

function labLimits(value: unknown): Record<string, LabLimit> {
  const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : DEFAULT_LAB_LIMITS
  const limits: Record<string, LabLimit> = {}
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const limit: LabLimit = { unidad: typeof r.unidad === 'string' ? r.unidad : '' }
    if (typeof r.max === 'number') limit.max = r.max
    if (typeof r.min === 'number') limit.min = r.min
    limits[key] = limit
  }
  return limits
}

/** Reglas del lote a partir de la instantánea de la configuración. */
export function buildLotRules(snapshot: SettingsSnapshot, origin: LotRules['origin']): LotRules {
  const v = snapshot.values
  const K = LOT_RULE_KEYS
  return {
    takenAt: snapshot.takenAt,
    origin,
    singani: {
      minAltitudeMasl: numberOr(v[K.minAltitudeMasl], defaultOf<number>(K.minAltitudeMasl)),
      requiredVarieties: stringList(v[K.requiredVarieties], defaultOf<string[]>(K.requiredVarieties)),
      minRestDays: numberOr(v[K.minRestDays], defaultOf<number>(K.minRestDays)),
    },
    wine: { minAgingMonths: numberOr(v[K.minAgingMonths], defaultOf<number>(K.minAgingMonths)) },
    phytosanitary: { requireApproved: typeof v[K.requireApproved] === 'boolean' ? (v[K.requireApproved] as boolean) : defaultOf<boolean>(K.requireApproved) },
    bottling: { maxLossPercent: numberOr(v[K.maxLossPercent], defaultOf<number>(K.maxLossPercent)) },
    lab: { limits: labLimits(v[K.labLimits]) },
    legalExceptions: [...snapshot.legalExceptions],
    sources: { ...snapshot.sources },
    values: { ...v },
  }
}

/** Mínimo legal (A-31) de una clave del catálogo, si lo tiene. */
export function legalMinimumOf(key: string): number | string[] | null {
  const legal = settingEntry(key)?.legalMinimum
  if (legal === undefined || legal === null) return null
  return typeof legal === 'number' ? legal : [...legal]
}

/** Texto y unidad de cada regla de la instantánea, para el pasaporte público (`rules.items`). */
export const LOT_RULE_LABELS: Record<string, { label: string; unit: string | null }> = {
  [LOT_RULE_KEYS.minAltitudeMasl]: { label: 'Altitud mínima de la parcela (D.O. Singani)', unit: 'msnm' },
  [LOT_RULE_KEYS.requiredVarieties]: { label: 'Cepas admitidas (D.O. Singani)', unit: null },
  [LOT_RULE_KEYS.minRestDays]: { label: 'Reposo mínimo tras la destilación', unit: 'días' },
  [LOT_RULE_KEYS.minAgingMonths]: { label: 'Crianza mínima del vino', unit: 'meses' },
  [LOT_RULE_KEYS.requireApproved]: { label: 'Dictamen fitosanitario aprobado para fermentar', unit: null },
  [LOT_RULE_KEYS.maxLossPercent]: { label: 'Merma máxima tolerada al embotellar', unit: '%' },
  [LOT_RULE_KEYS.labLimits]: { label: 'Límites de laboratorio', unit: null },
}

// ---------------------------------------------------------------------------
// Violaciones (`ErrorDetail` ampliado, contrato §0)
// ---------------------------------------------------------------------------

type DetailExtras = Omit<Partial<ApiErrorDetail>, 'code' | 'message'>

/** Una violación con su código `TRC_…`: `rule`, `expected`, `actual` y `meta` solo si se indican. */
export function violation(code: TraceErrorCode | (string & {}), message: string, extras: DetailExtras = {}): ApiErrorDetail {
  const detail: ApiErrorDetail = { field: extras.field ?? null, message, code }
  if (extras.rule !== undefined) detail.rule = extras.rule
  if (extras.expected !== undefined) detail.expected = extras.expected
  if (extras.actual !== undefined) detail.actual = extras.actual
  if (extras.meta !== undefined) detail.meta = extras.meta
  return detail
}

/** `18.400` (miles con punto, como el ERP en es-BO). */
export function formatQuantity(value: number, decimals = 0): string {
  const fixed = value.toFixed(decimals)
  const [int, frac] = fixed.split('.') as [string, string | undefined]
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const trimmed = frac?.replace(/0+$/, '')
  return trimmed ? `${grouped},${trimmed}` : grouped
}
