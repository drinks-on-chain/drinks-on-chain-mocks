import type { SettingAppliesAt, SettingLevels, SettingType } from './schemas/settings'

// Catálogo de parámetros configurables (docs-back/05 §4, claves tal cual). Los valores de
// enumeración y las unidades son una propuesta de los mocks (docs/CONTRATO.md §6).

export interface SettingCatalogEntry {
  key: string
  description: string
  type: SettingType
  enumValues?: string[]
  unit?: string
  levels: SettingLevels
  appliesAt: SettingAppliesAt
  default: unknown
  min?: number
  max?: number
  /** Piso legal (A-31): número (un valor menor es más laxo) o lista (un elemento fuera de ella es más laxo). */
  legalMinimum?: number | string[] | null
}

/**
 * Límites de laboratorio por defecto ("norma vigente"), los mismos que `settings.catalog.ts` del
 * backend (metanol < 200 mg/100 ml de alcohol anhidro). Pendientes de confirmar contra la norma.
 */
export const DEFAULT_LAB_LIMITS = {
  metanol: { max: 200, unidad: 'mg/100 ml a.a.' },
  cobre: { max: 6, unidad: 'mg/l' },
  acidezVolatil: { max: 1.2, unidad: 'g/l' },
}

export const SETTINGS_CATALOG: readonly SettingCatalogEntry[] = [
  {
    key: 'trazabilidad.singani.altitudMinimaMsnm',
    description: 'Altitud mínima de la parcela para D.O. Singani',
    type: 'NUMBER',
    unit: 'msnm',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'LOT',
    default: 1600,
    min: 0,
    max: 5000,
    legalMinimum: 1600,
  },
  {
    key: 'trazabilidad.singani.variedadesExigidas',
    description: 'Cepas admitidas para D.O. Singani',
    type: 'LIST',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'LOT',
    default: ['Moscatel de Alejandría'],
    legalMinimum: ['Moscatel de Alejandría'],
  },
  {
    key: 'trazabilidad.singani.reposoMinimoDias',
    description: 'Reposo mínimo tras la destilación',
    type: 'NUMBER',
    unit: 'días',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'LOT',
    default: 180,
    min: 0,
    max: 3650,
    legalMinimum: 180,
  },
  {
    key: 'trazabilidad.vino.crianzaMinimaMeses',
    description: 'Mínimo de meses de crianza que puede fijar el enólogo',
    type: 'NUMBER',
    unit: 'meses',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'LOT',
    default: 0,
    min: 0,
    max: 120,
  },
  {
    key: 'trazabilidad.fitosanitario.exigirAprobado',
    description: 'Exigir dictamen aprobado para fermentar',
    type: 'BOOLEAN',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'LOT',
    default: true,
  },
  {
    key: 'trazabilidad.embotellado.mermaMaximaPorcentaje',
    description: 'Merma tolerada entre litros disponibles y embotellados',
    type: 'NUMBER',
    unit: '%',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'LOT',
    default: 5,
    min: 0,
    max: 100,
  },
  {
    key: 'trazabilidad.excepcionMinimoLegal',
    description:
      'Autoriza a una bodega a configurar reglas normativas por debajo del mínimo legal (A-31); solo administración, con motivo',
    type: 'BOOLEAN',
    levels: 'WINERY',
    appliesAt: 'LOT',
    default: false,
  },
  {
    key: 'trazabilidad.laboratorio.limites',
    description: 'Límites de metanol, cobre y otros parámetros con su unidad',
    type: 'OBJECT',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'LOT',
    default: DEFAULT_LAB_LIMITS,
  },
  {
    key: 'precio.politica',
    description: 'Cómo se sugiere el precio de preventa. Estructura lista; la política se define más adelante (A-32)',
    type: 'OBJECT',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'COLLECTION',
    default: null,
  },
  {
    key: 'compra.maxBotellasPorCompra',
    description: 'Máximo por pedido; vacío = ilimitado',
    type: 'NUMBER_OR_UNLIMITED',
    unit: 'botellas',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 10,
    min: 1,
    max: 1000,
  },
  {
    key: 'compra.minutosReserva',
    description: 'Tiempo que un pedido reserva los NFT mientras se paga',
    type: 'NUMBER',
    unit: 'minutos',
    levels: 'GLOBAL',
    appliesAt: 'IMMEDIATE',
    default: 30,
    min: 5,
    max: 240,
  },
  {
    key: 'canje.pase.caducidadHoras',
    description: 'Caducidad del pase de canje',
    type: 'NUMBER',
    unit: 'horas',
    levels: 'GLOBAL',
    appliesAt: 'IMMEDIATE',
    default: 24,
    min: 1,
    max: 720,
  },
  {
    key: 'canje.ventanaDias',
    description: 'Días para canjear desde que el NFT es canjeable',
    type: 'NUMBER',
    unit: 'días',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 30,
    min: 1,
    max: 365,
  },
  {
    key: 'canje.ventanaVencida.accion',
    description: 'Qué pasa con un NFT cuando vence su ventana de canje (A-29): quemar, extender o compensar',
    type: 'ENUM',
    enumValues: ['BURN', 'EXTEND', 'COMPENSATE'],
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 'BURN',
  },
  {
    key: 'canje.ventanaVencida.diasExtension',
    description: 'Días que se añaden si la acción es extender',
    type: 'NUMBER',
    unit: 'días',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 15,
    min: 1,
    max: 180,
  },
  {
    key: 'canje.ventanaVencida.diasAviso',
    description: 'Días antes del vencimiento en que se avisa por correo',
    type: 'NUMBER',
    unit: 'días',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 7,
    min: 0,
    max: 60,
  },
  {
    key: 'canje.codigoBotella.modo',
    description: 'Registro del código de botella en el canje: desactivado, opcional u obligatorio',
    type: 'ENUM',
    enumValues: ['DISABLED', 'OPTIONAL', 'REQUIRED'],
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 'OPTIONAL',
  },
  {
    key: 'canje.entregaAsistida.maxPorClienteMes',
    description: 'Límite de entregas asistidas por consumidor',
    type: 'NUMBER',
    levels: 'GLOBAL',
    appliesAt: 'IMMEDIATE',
    default: 2,
    min: 0,
    max: 20,
  },
  {
    key: 'puntos.bodegaPuedeHabilitar',
    description: 'Si la bodega puede crear sus puntos de canje',
    type: 'BOOLEAN',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: false,
  },
  {
    key: 'puntos.maxPorBodega',
    description: 'Máximo de puntos que puede crear una bodega',
    type: 'NUMBER',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 3,
    min: 0,
    max: 50,
  },
  {
    key: 'puntos.maxCajerosPorPunto',
    description: 'Máximo de cajeros por punto',
    type: 'NUMBER',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 5,
    min: 1,
    max: 50,
  },
  {
    key: 'equipo.maxColaboradoresPorBodega',
    description: 'Máximo de colaboradores de una bodega (miembros activos + invitaciones pendientes); vacío = ilimitado',
    type: 'NUMBER_OR_UNLIMITED',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: null,
    min: 1,
    max: 500,
  },
  {
    key: 'tokenizacion.requiereAprobacion',
    description: 'La tokenización necesita aprobación del back office',
    type: 'BOOLEAN',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: true,
  },
  {
    key: 'invitacion.caducidadHoras',
    description: 'Caducidad de las invitaciones',
    type: 'NUMBER',
    unit: 'horas',
    levels: 'GLOBAL',
    appliesAt: 'IMMEDIATE',
    default: 72,
    min: 1,
    max: 720,
  },
  {
    key: 'campanas.agradecimiento.activa',
    description: 'Mensaje de agradecimiento tras el canje',
    type: 'BOOLEAN',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: true,
  },
  {
    key: 'campanas.recordatorioResena.dias',
    description: 'Días tras el canje para recordar la reseña; vacío = desactivado',
    type: 'NUMBER_OR_UNLIMITED',
    unit: 'días',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: 7,
    min: 1,
    max: 90,
  },
  {
    key: 'campanas.promociones.activas',
    description: 'Envío de promociones',
    type: 'BOOLEAN',
    levels: 'GLOBAL_AND_WINERY',
    appliesAt: 'IMMEDIATE',
    default: false,
  },
]

/** Entrada del catálogo por clave. */
export function settingEntry(key: string): SettingCatalogEntry | undefined {
  return SETTINGS_CATALOG.find((s) => s.key === key)
}
