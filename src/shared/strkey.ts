import { fromHex, sha256, sha256Hex, toHex } from './crypto'

// Direcciones y hashes de la red Stellar con **forma válida** para los mocks de la Ola 3: StrKey de
// 56 caracteres con su byte de versión y su CRC16 (`G…` cuentas, `C…` contratos) y hashes de
// transacción en hex de 64. Se derivan de una clave legible con SHA-256 y un prefijo propio de los
// mocks, así que son deterministas y **no corresponden a ninguna cuenta ni contrato de testnet**
// (nadie tiene su clave privada y ninguna está fondeada).

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const VERSION = { G: 6 << 3, C: 2 << 3 } as const
export type StrKeyKind = keyof typeof VERSION

const encoder = new TextEncoder()

/** CRC16-XModem (el de StrKey). */
function crc16(bytes: Uint8Array): number {
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(text: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text) {
    const idx = BASE32.indexOf(ch)
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return new Uint8Array(out)
}

/** StrKey de prueba (`G…` o `C…`) derivada de una clave legible. */
export function mockStrKey(kind: StrKeyKind, key: string): string {
  const payload = sha256(encoder.encode(`drinks-on-chain/mocks/${kind}/${key}`))
  const body = new Uint8Array(33)
  body[0] = VERSION[kind]
  body.set(payload, 1)
  const crc = crc16(body)
  const full = new Uint8Array(35)
  full.set(body)
  full[33] = crc & 0xff
  full[34] = crc >>> 8
  return base32Encode(full)
}

/** Cuenta de prueba (`G…`, 56 caracteres). */
export const mockAccountAddress = (key: string): string => mockStrKey('G', key)
/** Contrato de prueba (`C…`, 56 caracteres). */
export const mockContractAddress = (key: string): string => mockStrKey('C', key)
/** Hash de transacción de prueba (hex de 64). */
export const mockTxHash = (key: string): string => sha256Hex(`drinks-on-chain/mocks/tx/${key}`)

/** ¿Es una StrKey bien formada (longitud, versión y CRC)? Con `kind`, además de ese tipo. */
export function isValidStrKey(address: string, kind?: StrKeyKind): boolean {
  if (!/^[GC][A-Z2-7]{55}$/.test(address)) return false
  if (kind && address[0] !== kind) return false
  const bytes = base32Decode(address)
  if (!bytes || bytes.length !== 35) return false
  if (bytes[0] !== VERSION[address[0] as StrKeyKind]) return false
  const crc = crc16(bytes.subarray(0, 33))
  return bytes[33] === (crc & 0xff) && bytes[34] === crc >>> 8
}

/** Hex → base64 (el memo del anclaje se muestra de las dos formas). */
export function hexToBase64(hex: string): string {
  const bytes = fromHex(hex)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += alphabet[a >> 2]
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : alphabet[c & 63]
  }
  return out
}

/** Base64 → hex. */
export function base64ToHex(b64: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = b64.replace(/=+$/, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 6) | alphabet.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return toHex(new Uint8Array(out))
}
