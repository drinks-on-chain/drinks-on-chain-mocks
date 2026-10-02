// Entrada raíz `@drinks-on-chain/mocks`: esquemas zod, tipos, enumeraciones, envoltorio,
// forma de las listas, los esquemas de la Ola 1 (back office,
// bodegas, equipos, configuración, bitácora y segundo factor) y los de la Ola 2 (lote del servidor,
// códigos de botella, expediente, vistas y pasaporte público), con las utilidades del código de
// botella (normalizar, validar el control, formatear) y de su prueba Merkle. Apta para código de
// producción: no importa msw ni los fixtures.

export * from './shared/envelope'
export * from './shared/list'
export * from './erp/schemas'
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
  merkleRoot,
  merkleRootFromProof,
  normalizeBottleCode,
  verifyMerkleProof,
  type MerkleLeafInput,
  type MerkleStep,
} from './erp/trace/bottle-code'
// SHA-256 síncrono (texto UTF-8 → hexadecimal): la huella del expediente es `sha256Hex(bytes canónicos)`.
export { canonicalJson, sha256Hex } from './shared/crypto'
