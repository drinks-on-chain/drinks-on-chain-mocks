// Fechas de calendario de la producción (contrato O2 §0): se interpretan en America/La_Paz
// (UTC−4, sin horario de verano) y viajan como `YYYY-MM-DD`. Los campos de solo fecha que los
// fixtures guardan como `YYYY-MM-DDT00:00:00Z` (embotellado, fin de destilación, candados) se leen
// por sus diez primeros caracteres, como las columnas `@db.Date` del backend.

/** Desfase de America/La_Paz respecto a UTC, en horas. */
export const LA_PAZ_UTC_OFFSET_HOURS = -4

const YMD = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000

/** Día de calendario en La Paz de un instante (ISO, `Date` o milisegundos). */
export function laPazDate(instant: string | number | Date): string {
  const ms = typeof instant === 'number' ? instant : instant instanceof Date ? instant.getTime() : Date.parse(instant)
  return new Date(ms + LA_PAZ_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` de un campo de solo fecha guardado como medianoche UTC. */
export function dateOnly(value: string): string {
  return value.slice(0, 10)
}

/** Día de una fecha enviada por el cliente: `YYYY-MM-DD` tal cual; un instante, su día en La Paz. */
export function calendarDay(value: string): string {
  return dayOf(value)
}

/**
 * Día de un valor guardado: un campo de solo fecha (`YYYY-MM-DD` o medianoche UTC) se lee tal cual;
 * un instante con hora, por su día en La Paz.
 */
export function dayOf(value: string): string {
  return YMD.test(value) || /T00:00:00(\.000)?Z$/.test(value) ? value.slice(0, 10) : laPazDate(value)
}

/** Campo de solo fecha tal como lo guardan los mocks (`YYYY-MM-DDT00:00:00Z`). */
export function toDateField(ymd: string): string {
  return `${ymd}T00:00:00Z`
}

function toUtc(ymd: string): number {
  if (!YMD.test(ymd)) throw new RangeError(`Fecha inválida: ${ymd}`)
  return Date.parse(`${ymd}T00:00:00.000Z`)
}

/** `ymd` + `days` días. */
export function addDaysYmd(ymd: string, days: number): string {
  return new Date(toUtc(ymd) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

/** `ymd` + `months` meses de calendario; si el día no existe en el mes de destino, su último día. */
export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const month = total % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(d, lastDay))).toISOString().slice(0, 10)
}

/** Días de `from` a `to` (negativo si `to` es anterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY)
}

/** La más tardía de dos fechas `YYYY-MM-DD` (ignora `null`). */
export function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a >= b ? a : b
}

/** Instante ISO sin milisegundos (formato de los fixtures). */
export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
