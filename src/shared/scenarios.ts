// Escenarios de los mocks (doc 08 §1.6). Se eligen, por orden de prioridad:
//   1. setScenario(nombre) en tiempo de ejecución (p. ej. desde la página /__mocks),
//   2. el parámetro `?mock=` de la URL del navegador (se guarda en localStorage),
//   3. localStorage (`doc-mocks:scenario`),
//   4. 'normal'.

/**
 * Todos los escenarios. La lista **crece** con las olas: para un panel usa `SCENARIOS` y
 * `SCENARIO_DESCRIPTIONS` (o `Partial<Record<ScenarioName, …>>`) en lugar de un
 * `Record<ScenarioName, …>` escrito a mano, que deja de compilar cuando se añade uno.
 */
export const SCENARIOS = [
  'normal',
  'empty',
  'error',
  'slow',
  'offline',
  'lote-en-reposo',
  'lote-listo',
  'lote-con-incidencia',
  'laboratorio-no-conforme',
  'pasaporte-saturado',
  // Ola 3: tokenización y cadena
  'identidad-preparandose',
  'emision-en-curso',
  'emision-fallida',
  'anclaje-pendiente',
  'faltante-botellas',
  'alerta-evento-inesperado',
  'cambios-pedidos',
] as const
export type ScenarioName = (typeof SCENARIOS)[number]

/** Escenarios que cambian **cómo responde** el backend simulado (los de 0.1; no tocan los datos). */
export const RESPONSE_SCENARIOS = ['normal', 'empty', 'error', 'slow', 'offline'] as const satisfies readonly ScenarioName[]
export type ResponseScenarioName = (typeof RESPONSE_SCENARIOS)[number]

export const SCENARIO_DESCRIPTIONS: Record<ScenarioName, string> = {
  normal: 'Datos completos de la red de prueba («Singani Gran Reserva 2026» con el expediente cerrado)',
  empty: 'Listas vacías (estados vacíos de las pantallas)',
  error: 'Error 500 con el envoltorio del backend (salvo /v1/auth)',
  slow: 'Respuestas con 2,5 s de retraso',
  offline: 'Error de red (sin conexión)',
  'lote-en-reposo': '«Singani Gran Reserva 2026» en reposo: faltan 10 días (embotellar → TRC_LOCK_NOT_RELEASED)',
  'lote-listo': '«Singani Gran Reserva 2026» con el reposo cumplido, listo para la vista previa y el embotellado',
  'lote-con-incidencia': 'CVJ-2026-SINGANI-002 con una incidencia de migración abierta (TRC_BOTTLING_EXCEEDS_VOLUME)',
  'laboratorio-no-conforme': '«Singani Gran Reserva 2026» embotellado con un análisis no conforme (el expediente no se puede cerrar)',
  'pasaporte-saturado': 'Pasaporte público: límite de 60 consultas por minuto superado (429 TOO_MANY_REQUESTS con Retry-After)',
  'identidad-preparandose': 'Bodega Altos de Calamuchita recién activada: su cuenta y su contrato en la red aún se están creando (aprobar → TOK_WINERY_CHAIN_NOT_READY)',
  'emision-en-curso': '«Singani Preventa 2026» recién aprobada: la emisión de sus 100 NFT avanza en la red (PENDING → CONFIRMED)',
  'emision-fallida': '«Singani Preventa 2026» con la emisión fallida (CHN_AUTH_FAILED): se reintenta desde el back office y se confirma',
  'anclaje-pendiente': '«Singani Gran Reserva 2026» certificado con el anclaje de su expediente aún en la red (al confirmarse pasa a ANCHORED)',
  'faltante-botellas': '«Singani El Portillo 2025» con 20 NFT más que botellas: cierre con faltante sin decidir',
  'alerta-evento-inesperado': 'Alerta CRITICAL UNEXPECTED_EVENT: un role_granted en el contrato de Cinti Viejo que no originó el sistema',
  'cambios-pedidos': '«Singani Preventa 2026» con cambios pedidos por operaciones («falta la nota de cata»): editar y reenviar',
}

/**
 * Escenarios de datos de la Ola 2: no cambian cómo responde el backend simulado sino en qué etapa
 * está el lote de demostración. Al elegir uno, la trazabilidad de la base en memoria se rehace
 * desde los fixtures (lo creado en la sesión se descarta; la identidad y el back office, no).
 */
export const DATA_SCENARIOS = [
  'lote-en-reposo',
  'lote-listo',
  'lote-con-incidencia',
  'laboratorio-no-conforme',
  'identidad-preparandose',
  'emision-en-curso',
  'emision-fallida',
  'anclaje-pendiente',
  'faltante-botellas',
  'alerta-evento-inesperado',
  'cambios-pedidos',
] as const satisfies readonly ScenarioName[]
export type DataScenarioName = (typeof DATA_SCENARIOS)[number]

export function isDataScenario(name: ScenarioName): name is DataScenarioName {
  return (DATA_SCENARIOS as readonly string[]).includes(name)
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
