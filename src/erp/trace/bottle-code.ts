import { sha256Hex } from '../../shared/crypto'

// Códigos de botella (contrato O2 §7.1, A-26): 8 caracteres del alfabeto Crockford (sin I, L, O,
// U): 7 de carga + 1 de control Luhn mod 32. Mismo cálculo que `domain/bottle-code.ts` del backend.
// En los mocks los 7 caracteres no son aleatorios sino deterministas (`mockBottleCode`), para que
// los fixtures y las pruebas conozcan los códigos sin guardarlos uno a uno.

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BASE = CROCKFORD_ALPHABET.length // 32
export const BOTTLE_CODE_LENGTH = 8

/** Carácter de control Luhn mod 32 de `payload` (7 caracteres del alfabeto). */
export function luhnMod32CheckChar(payload: string): string {
  let factor = 2
  let sum = 0
  for (let i = payload.length - 1; i >= 0; i--) {
    const point = CROCKFORD_ALPHABET.indexOf(payload[i]!)
    if (point < 0) throw new RangeError(`Carácter fuera del alfabeto: ${payload[i]}`)
    let addend = factor * point
    factor = factor === 2 ? 1 : 2
    addend = Math.floor(addend / BASE) + (addend % BASE)
    sum += addend
  }
  return CROCKFORD_ALPHABET[(BASE - (sum % BASE)) % BASE]!
}

/** ¿El último carácter es el control Luhn mod 32 de los anteriores? */
export function hasValidCheckChar(code: string): boolean {
  let factor = 1
  let sum = 0
  for (let i = code.length - 1; i >= 0; i--) {
    const point = CROCKFORD_ALPHABET.indexOf(code[i]!)
    if (point < 0) return false
    let addend = factor * point
    factor = factor === 2 ? 1 : 2
    addend = Math.floor(addend / BASE) + (addend % BASE)
    sum += addend
  }
  return sum % BASE === 0
}

/** Normalización al leer (§7.1): mayúsculas, sin espacios ni guiones, `O → 0`, `I`/`L → 1`. */
export function normalizeBottleCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/** ¿Tiene la forma de un código de botella (8 caracteres del alfabeto, ya normalizado), cuadre o no el control? */
export function looksLikeBottleCode(normalized: string): boolean {
  return normalized.length === BOTTLE_CODE_LENGTH && [...normalized].every((c) => CROCKFORD_ALPHABET.includes(c))
}

/** ¿Es un código de botella con forma y control válidos (ya normalizado)? */
export function isValidBottleCode(normalized: string): boolean {
  return looksLikeBottleCode(normalized) && hasValidCheckChar(normalized)
}

/** `XXXX-XXXX` para imprimir. */
export function formatBottleCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Hash de 53 bits (cyrb53): rápido y suficiente para repartir códigos de prueba. */
function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * Código de botella determinista de los mocks: el de la serie `serial` del lote `lotId`.
 * `generation` cambia cuando el código se sustituye (etiqueta dañada: misma serie, código nuevo).
 * El backend los genera con azar criptográfico; aquí basta con que sean estables y distintos.
 */
export function mockBottleCode(lotId: string, serial: number, generation = 0): string {
  let n = cyrb53(`bottle:${lotId}:${serial}:${generation}`)
  let payload = ''
  for (let i = 0; i < BOTTLE_CODE_LENGTH - 1; i++) {
    payload += CROCKFORD_ALPHABET[n % BASE]
    n = Math.floor(n / BASE)
  }
  return payload + luhnMod32CheckChar(payload)
}

/** Sal determinista de la hoja Merkle de una botella (16 bytes en hex, §10). */
export function mockBottleSalt(lotId: string, serial: number, generation = 0): string {
  const part = (seed: number) => cyrb53(`salt:${lotId}:${serial}:${generation}`, seed).toString(16).padStart(14, '0')
  return (part(1) + part(2) + part(3)).slice(0, 32)
}

// ---------------------------------------------------------------------------
// Raíz Merkle de los códigos del expediente (§10)
// ---------------------------------------------------------------------------

/** Algoritmo de la raíz: hojas `SHA-256("{serie}:{código}:{sal}")` ordenadas por serie. */
export const BOTTLE_MERKLE_ALGORITHM = 'sha256-merkle/serial-code-salt'

export interface MerkleLeafInput {
  serial: number
  code: string
  salt: string
}

export const merkleLeaf = (leaf: MerkleLeafInput): string => sha256Hex(`${leaf.serial}:${leaf.code}:${leaf.salt}`)

/** Nodo padre: SHA-256 de la concatenación en hexadecimal de sus dos hijos (izquierdo + derecho). */
export const merkleParent = (left: string, right: string): string => sha256Hex(left + right)

/** Niveles del árbol, de las hojas a la raíz. Un nodo sin pareja sube tal cual al nivel siguiente. */
export function merkleLevels(leaves: readonly string[]): string[][] {
  const levels: string[][] = [[...leaves]]
  while (levels.at(-1)!.length > 1) {
    const prev = levels.at(-1)!
    const next: string[] = []
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? merkleParent(prev[i]!, prev[i + 1]!) : prev[i]!)
    levels.push(next)
  }
  return levels
}

/** Raíz Merkle (sin hojas, el SHA-256 de la cadena vacía). */
export function merkleRoot(leaves: readonly string[]): string {
  return leaves.length === 0 ? sha256Hex('') : merkleLevels(leaves).at(-1)![0]!
}

export interface MerkleStep {
  /** Lado en el que está el hermano. */
  side: 'L' | 'R'
  hash: string
}

/** Prueba de pertenencia de la hoja `index`: los hermanos desde la hoja hasta la raíz. */
export function merkleProof(levels: readonly string[][], index: number): MerkleStep[] {
  const path: MerkleStep[] = []
  let i = index
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level]!
    const sibling = i % 2 === 0 ? i + 1 : i - 1
    if (sibling < nodes.length) path.push({ side: i % 2 === 0 ? 'R' : 'L', hash: nodes[sibling]! })
    i = Math.floor(i / 2)
  }
  return path
}

/** Recalcula la raíz desde una hoja y su prueba (lo que hace el visor para verificar una botella). */
export function merkleRootFromProof(leaf: string, path: readonly MerkleStep[]): string {
  return path.reduce((hash, step) => (step.side === 'L' ? merkleParent(step.hash, hash) : merkleParent(hash, step.hash)), leaf)
}
