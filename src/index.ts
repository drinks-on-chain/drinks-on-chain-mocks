// Entrada raíz `@drinks-on-chain/mocks`: esquemas zod, tipos, enumeraciones, envoltorio,
// forma de las listas, la vista derivada LotView (hasta H2), los esquemas de la Ola 1 (back office,
// bodegas, equipos, configuración, bitácora y segundo factor) y los de la Ola 2 (lote del servidor,
// códigos de botella, expediente, vistas y pasaporte público), con las utilidades del código de
// botella (normalizar, validar el control, formatear) y de su prueba Merkle. Apta para código de
// producción: no importa msw ni los fixtures.

export * from './shared/envelope'
export * from './shared/list'
export * from './erp/schemas'
export * from './erp/lot-view'
export * from './backoffice/schemas'
export * from './public/schemas'
export {
  BOTTLE_CODE_LENGTH,
  BOTTLE_MERKLE_ALGORITHM,
  CROCKFORD_ALPHABET,
  formatBottleCode,
  hasValidCheckChar,
  isValidBottleCode,
  looksLikeBottleCode,
  luhnMod32CheckChar,
  merkleLeaf,
  merkleParent,
  merkleRootFromProof,
  normalizeBottleCode,
  type MerkleStep,
} from './erp/trace/bottle-code'
