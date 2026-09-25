// Fechas de calendario en UTC como número de días desde 1970-01-01 (equivalente a `date`
// de Python). Formatos idénticos a `generate.py`: `YYYY-MM-DD` y `YYYY-MM-DDTHH:MM:SSZ`.

export type Day = number

const MS_PER_DAY = 86_400_000

/** Fecha de referencia de todos los mocks. */
export const REFERENCE_DAY = '2026-09-25'

export function day(year: number, month: number, dayOfMonth: number): Day {
  return Date.UTC(year, month - 1, dayOfMonth) / MS_PER_DAY
}

export function dayParts(d: Day): { year: number; month: number; day: number } {
  const dt = new Date(d * MS_PER_DAY)
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `date.isoformat()` → `YYYY-MM-DD`. */
export function isoDay(d: Day): string {
  const p = dayParts(d)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** `iso()` de `generate.py` → `YYYY-MM-DDTHH:MM:00Z`. */
export function isoAt(d: Day, hour = 12, minute = 0): string {
  return `${isoDay(d)}T${pad(hour)}:${pad(minute)}:00Z`
}

/** Día (UTC) de una fecha ISO o `YYYY-MM-DD` (`date.fromisoformat(s[:10])`). */
export function dayFromIso(s: string): Day {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) throw new RangeError(`Fecha inválida: ${s}`)
  return day(Number(m[1]), Number(m[2]), Number(m[3]))
}

/** Día UTC de un `Date` o de una cadena ISO. */
export function toDay(value: Date | string): Day {
  if (typeof value === 'string') return dayFromIso(value)
  return day(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
}

/** Suma meses como `generate.py` (día acotado a 28 para no desbordar el mes). */
export function addMonthsClamped(d: Day, months: number): Day {
  const p = dayParts(d)
  const idx = p.month - 1 + months
  return day(p.year + Math.floor(idx / 12), (idx % 12) + 1, Math.min(p.day, 28))
}

/** Normaliza una fecha de entrada (`YYYY-MM-DD` o ISO) a `YYYY-MM-DDTHH:MM:SSZ` en UTC. */
export function normalizeDateTime(input: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return `${input}T00:00:00Z`
  const ms = Date.parse(input)
  if (Number.isNaN(ms)) return input
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
