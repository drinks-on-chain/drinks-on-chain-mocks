import { uid } from '../shared/uuid'

// Catálogo fijo de la red de prueba que no forma parte de los DTO.

/** Código de bodega (por clave legible) para `internationalLotCode` = `{BODEGA}-{AÑO}-{TIPO}-{SEQ}`. */
export const WINERY_CODES: Record<string, string> = {
  altos: 'ALT',
  cintiviejo: 'CVJ',
  guadalquivir: 'VGQ',
  uriondo: 'CUR',
}

/** Mismo mapa indexado por id de bodega (UUID v5 de `winery:<clave>`). */
export const WINERY_CODES_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(WINERY_CODES).map(([key, code]) => [uid(`winery:${key}`), code]),
)
