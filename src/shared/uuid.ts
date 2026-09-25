// UUID v5 (RFC 4122, SHA-1) en TypeScript puro, sin dependencias de Node: lo usan el
// generador de fixtures y los handlers MSW en el navegador. Equivale a `uuid.uuid5` de Python.

/** Namespace fijo del proyecto (el mismo de `generate.py`). */
export const MOCKS_NAMESPACE = '6b2f4c1e-9c3a-4d5e-8f70-1a2b3c4d5e6f'

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n))
}

/** SHA-1 de un array de bytes. Devuelve 20 bytes. */
export function sha1(bytes: Uint8Array): Uint8Array {
  const ml = bytes.length
  const withPadding = ((ml + 9 + 63) >> 6) << 6
  const buf = new Uint8Array(withPadding)
  buf.set(bytes)
  buf[ml] = 0x80
  const view = new DataView(buf.buffer)
  const bitLen = ml * 8
  view.setUint32(withPadding - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(withPadding - 4, bitLen >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let off = 0; off < withPadding; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1)
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0
      e = d
      d = c
      c = rotl(b, 30) >>> 0
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const ov = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h))
  return out
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const encoder = new TextEncoder()

/** UUID v5 de `name` en `namespace` (por defecto, el del proyecto). */
export function uuidv5(name: string, namespace: string = MOCKS_NAMESPACE): string {
  const ns = uuidToBytes(namespace)
  const nameBytes = encoder.encode(name)
  const input = new Uint8Array(ns.length + nameBytes.length)
  input.set(ns)
  input.set(nameBytes, ns.length)
  const hash = sha1(input).slice(0, 16)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const h = toHex(hash)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Id determinista de los mocks a partir de una clave legible (`uid` de `generate.py`). */
export function uid(key: string): string {
  return uuidv5(key)
}

/** Hash hexadecimal determinista de 64 caracteres (para hashes simulados en los handlers). */
export function fakeHash64(key: string): string {
  return (toHex(sha1(encoder.encode(key))) + toHex(sha1(encoder.encode(`${key}#2`)))).slice(0, 64)
}

/** Dirección Stellar de prueba (`G` + 55 caracteres base32). No es una clave real. */
export function fakeStellarAddress(key: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bytes = [...sha1(encoder.encode(key)), ...sha1(encoder.encode(`${key}#2`)), ...sha1(encoder.encode(`${key}#3`))]
  return `G${bytes
    .slice(0, 55)
    .map((b) => alphabet[b % 32])
    .join('')}`
}
