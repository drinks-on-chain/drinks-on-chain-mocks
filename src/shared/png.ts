// PNG mínimo en TypeScript puro (sin dependencias): RGB de 8 bits con bloques «stored» de deflate.
// Lo usa la imagen de demostración de las colecciones (`GET /v1/public/collections/images/{id}`),
// que el OpenAPI declara como bytes `image/png|jpeg|webp|gif`.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** zlib sin comprimir: cabecera, bloques «stored» de hasta 65.535 bytes y Adler-32. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  out[0] = 0x78
  out[1] = 0x01
  let pos = 2
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535))
    out[pos++] = i === blocks - 1 ? 1 : 0
    out[pos++] = part.length & 0xff
    out[pos++] = part.length >>> 8
    out[pos++] = ~part.length & 0xff
    out[pos++] = (~part.length >>> 8) & 0xff
    out.set(part, pos)
    pos += part.length
  }
  new DataView(out.buffer).setUint32(pos, adler32(raw))
  return out
}

export type Rgb = readonly [number, number, number]

/** Codifica una imagen RGB: `pixel(x, y)` da el color de cada punto. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3))
  let pos = 0
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[pos++] = r
      raw[pos++] = g
      raw[pos++] = b
    }
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = 2
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

const PAPER: Rgb = [0xfd, 0xfc, 0xf5]
const GOLD: Rgb = [0xb0, 0x8d, 0x3c]
const GLASS: readonly Rgb[] = [
  [0x3b, 0x2a, 0x1a],
  [0x4a, 0x1f, 0x24],
  [0x2f, 0x3b, 0x2a],
  [0x5a, 0x45, 0x20],
]

/** Imagen de demostración de una colección (120 × 150): una botella sobre papel, con el tono según la semilla. */
export function demoBottlePng(seed: string): Uint8Array {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const glass = GLASS[h % GLASS.length]!
  const W = 120
  const H = 150
  return encodePng(W, H, (x, y) => {
    if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) return GOLD
    const cx = Math.abs(x - W / 2)
    if (y >= 22 && y < 28 && cx < 8) return GOLD
    if (y >= 28 && y < 56 && cx < 6) return glass
    if (y >= 56 && y < 68 && cx < 6 + (y - 56) * 1.3) return glass
    if (y >= 68 && y < 132 && cx < 22) return y >= 84 && y < 114 && cx < 19 ? (y === 84 || y === 113 || cx >= 18 ? GOLD : PAPER) : glass
    return PAPER
  })
}
