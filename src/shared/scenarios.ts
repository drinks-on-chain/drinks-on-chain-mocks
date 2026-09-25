// Escenarios de los mocks (doc 08 §1.6). Se eligen, por orden de prioridad:
//   1. setScenario(nombre) en tiempo de ejecución (p. ej. desde la página /__mocks),
//   2. el parámetro `?mock=` de la URL del navegador (se guarda en localStorage),
//   3. localStorage (`doc-mocks:scenario`),
//   4. 'normal'.

export const SCENARIOS = ['normal', 'empty', 'error', 'slow', 'offline'] as const
export type ScenarioName = (typeof SCENARIOS)[number]

export const SCENARIO_DESCRIPTIONS: Record<ScenarioName, string> = {
  normal: 'Datos completos de la red de prueba',
  empty: 'Listas vacías (estados vacíos de las pantallas)',
  error: 'Error 500 con el envoltorio del backend (salvo /v1/auth)',
  slow: 'Respuestas con 2,5 s de retraso',
  offline: 'Error de red (sin conexión)',
}

/** Retraso extra del escenario `slow`, en milisegundos. */
export const SLOW_SCENARIO_DELAY_MS = 2500

export const SCENARIO_STORAGE_KEY = 'doc-mocks:scenario'
export const SCENARIO_QUERY_PARAM = 'mock'

let override: ScenarioName | null = null

export function isScenarioName(value: unknown): value is ScenarioName {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value)
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function queryScenario(): ScenarioName | null {
  try {
    if (typeof location === 'undefined') return null
    const value = new URLSearchParams(location.search).get(SCENARIO_QUERY_PARAM)
    return isScenarioName(value) ? value : null
  } catch {
    return null
  }
}

/** Escenario activo. */
export function getScenario(): ScenarioName {
  if (override) return override
  const fromQuery = queryScenario()
  try {
    if (fromQuery) {
      storage()?.setItem(SCENARIO_STORAGE_KEY, fromQuery)
      return fromQuery
    }
    const stored = storage()?.getItem(SCENARIO_STORAGE_KEY)
    return isScenarioName(stored) ? stored : 'normal'
  } catch {
    // almacenamiento bloqueado: vale el parámetro de la URL o el valor por defecto
    return fromQuery ?? 'normal'
  }
}

/** Cambia el escenario (y lo guarda en localStorage en el navegador). */
export function setScenario(name: ScenarioName): void {
  if (!isScenarioName(name)) throw new TypeError(`Escenario desconocido: ${String(name)}`)
  override = name
  try {
    storage()?.setItem(SCENARIO_STORAGE_KEY, name)
  } catch {
    // almacenamiento no disponible (modo privado): basta con el valor en memoria
  }
}

/** Vuelve al escenario por defecto y borra el guardado. */
export function resetScenario(): void {
  override = null
  try {
    storage()?.removeItem(SCENARIO_STORAGE_KEY)
  } catch {
    // sin almacenamiento
  }
}

/** Latencia simulada: un número fijo o un intervalo [mín, máx] en milisegundos. */
export type LatencyOption = number | readonly [number, number]

/** Por defecto 200–400 ms en el navegador y 0 en Node (pruebas). */
export function defaultLatency(): LatencyOption {
  return typeof window === 'undefined' ? 0 : [200, 400]
}

export function pickLatency(latency: LatencyOption): number {
  if (typeof latency === 'number') return Math.max(0, latency)
  const [min, max] = latency
  return Math.max(0, Math.round(min + Math.random() * (max - min)))
}
