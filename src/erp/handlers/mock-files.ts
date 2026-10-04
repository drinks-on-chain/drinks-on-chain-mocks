import { http, HttpResponse, type HttpHandler } from 'msw'
import { activeCodes, bottleCodesCsv } from '../trace/bottling'
import { bottleLotOf, lotBottling } from '../trace/state'
import { getErpDb } from './db'
import { traceCtx } from './trace-context'

// Archivos de demostración de `/mocks/uploads/…`. Los fixtures y las URL firmadas de los mocks
// apuntan ahí (logotipos, etiquetas, imágenes del catálogo, informes en PDF, el ZIP de códigos de
// botella); la app no tiene esos archivos, así que los handlers los sirven de verdad: una imagen
// SVG, un PDF de una página o el ZIP de la exportación. Así ninguna imagen de los fixtures queda
// rota con MSW activo. Se desactiva con la opción `uploads: 'passthrough'` (la app sirve los suyos
// desde `public/mocks/uploads/`).

const encoder = new TextEncoder()

/** Texto estable → entero (para variar el dibujo sin azar). */
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

const xml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** Nombre legible de un archivo: `singani-gran-reserva-2026-2.jpg` → «Singani Gran Reserva 2026». */
function titleOf(file: string): string {
  const stem = file.replace(/\.[a-z0-9]+$/i, '').replace(/-\d$/, '')
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

const PAPER = '#fdfcf5'
const INK = '#2b2620'
const GOLD = '#a8843a'

/** Logotipo de demostración: monograma en un sello. */
function logoSvg(file: string): string {
  const title = titleOf(file)
  const initials = title
    .split(' ')
    .map((w) => w.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="${xml(title)}"><rect width="256" height="256" fill="${PAPER}"/><circle cx="128" cy="128" r="104" fill="none" stroke="${GOLD}" stroke-width="3"/><circle cx="128" cy="128" r="94" fill="none" stroke="${GOLD}" stroke-width="1"/><text x="128" y="156" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="84" fill="${INK}">${xml(initials)}</text></svg>`
}

/** Imagen de demostración de una colección o de una etiqueta: botella sobre papel, con su nombre. */
function bottleSvg(file: string): string {
  const title = titleOf(file)
  const seed = hash(file)
  const glass = ['#3d4a3a', '#4a3a2e', '#2f3b46', '#5a4a2a'][seed % 4] as string
  const tilt = (seed % 7) - 3
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 800" width="640" height="800" role="img" aria-label="${xml(title)}"><rect width="640" height="800" fill="${PAPER}"/><rect x="24" y="24" width="592" height="752" fill="none" stroke="${GOLD}" stroke-width="2"/><g transform="rotate(${tilt} 320 420)"><path d="M292 120h56v120c0 30 44 52 44 110v290c0 16-12 28-28 28h-88c-16 0-28-12-28-28V350c0-58 44-80 44-110z" fill="${glass}"/><rect x="286" y="104" width="68" height="28" rx="4" fill="${GOLD}"/><rect x="262" y="400" width="116" height="150" fill="${PAPER}" stroke="${GOLD}" stroke-width="2"/><line x1="278" y1="440" x2="362" y2="440" stroke="${GOLD}" stroke-width="2"/><line x1="278" y1="510" x2="362" y2="510" stroke="${GOLD}" stroke-width="1"/></g><text x="320" y="732" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="30" fill="${INK}">${xml(title)}</text><text x="320" y="762" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="16" fill="${GOLD}" letter-spacing="3">IMAGEN DE DEMOSTRACIÓN</text></svg>`
}

/** PDF mínimo de una página (texto en Helvetica, WinAnsi) con el nombre del documento. */
export function demoPdf(title: string): Uint8Array {
  // Solo Latin-1: las tildes van como escapes octales de WinAnsi.
  const latin1 = (text: string) =>
    [...text]
      .map((ch) => {
        const code = ch.charCodeAt(0)
        if (ch === '(' || ch === ')' || ch === '\\') return `\\${ch}`
        if (code < 128) return ch
        return code < 256 ? `\\${code.toString(8).padStart(3, '0')}` : '?'
      })
      .join('')
  const stream = `BT /F1 20 Tf 72 720 Td (${latin1(title)}) Tj 0 -30 Td /F1 12 Tf (Documento de demostraci\\363n de los mocks de Drinks on Chain.) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  // Todo el contenido es ASCII: un byte por carácter.
  return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0))
}

let crcTable: Uint32Array | null = null
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP sin compresión (método «almacenar») de unos archivos de texto con nombres UTF-8. */
export function storeZip(files: readonly { name: string; content: string }[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const data = encoder.encode(file.content)
    const crc = crc32(data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // versión necesaria
    lv.setUint16(6, 0x0800, true) // nombres en UTF-8
    lv.setUint16(8, 0, true) // sin compresión
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const entry = new Uint8Array(46 + name.length)
    const ev = new DataView(entry.buffer)
    ev.setUint32(0, 0x02014b50, true)
    ev.setUint16(4, 20, true)
    ev.setUint16(6, 20, true)
    ev.setUint16(8, 0x0800, true)
    ev.setUint32(16, crc, true)
    ev.setUint32(20, data.length, true)
    ev.setUint32(24, data.length, true)
    ev.setUint16(28, name.length, true)
    ev.setUint32(42, offset, true)
    entry.set(name, 46)
    chunks.push(local, data)
    central.push(entry)
    offset += local.length + data.length
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const dv = new DataView(end.buffer)
  dv.setUint32(0, 0x06054b50, true)
  dv.setUint16(8, files.length, true)
  dv.setUint16(10, files.length, true)
  dv.setUint32(12, centralSize, true)
  dv.setUint32(16, offset, true)
  const out = new Uint8Array(offset + centralSize + 22)
  let at = 0
  for (const part of [...chunks, ...central, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * ZIP de una exportación de códigos de botella (`exports/bottle-codes/{bodega}/{exportId}.zip`).
 * El del backend lleva `codigos.csv` y una imagen de QR por código (`qr/{serial}-{code}.svg|png`);
 * el de los mocks, el mismo `codigos.csv` y un `LEEME.txt`: las imágenes de QR no se simulan.
 */
function bottleExportZip(wineryId: string, exportId: string): Uint8Array | null {
  const db = getErpDb()
  const record = db.bottleExports.find((e) => e.exportId === exportId && e.format === 'ZIP' && e.status === 'READY')
  const lot = record ? db.lots.find((l) => l.id === record.lotId && l.wineryId === wineryId) : undefined
  const bl = lot ? bottleLotOf(db, lot.id) : null
  const bottling = lot ? lotBottling(db, lot.id) : null
  if (!record || !lot || !bl || !bottling) return null
  const ctx = traceCtx(null)
  const codes = activeCodes(bl, record.fromSerial, record.toSerial)
  const extension = record.imageFormat === 'PNG' ? 'png' : 'svg'
  return storeZip([
    { name: 'codigos.csv', content: bottleCodesCsv(ctx, lot, bottling.bottlingDate, codes) },
    {
      name: 'LEEME.txt',
      content: `Exportación de demostración de los mocks de Drinks on Chain.\r\n\r\nEl ZIP del backend lleva, además de codigos.csv, una imagen de QR por código activo del rango:\r\nqr/{serial}-{code}.${extension} (p. ej. qr/${codes[0]?.serial ?? 1}-${codes[0]?.code ?? 'K7M2Q9XA'}.${extension}).\r\nLos mocks no generan las imágenes: cada QR codifica la columna qrUrl de codigos.csv.\r\n`,
    },
  ])
}

const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i
const binary = (body: Uint8Array, contentType: string, extra: Record<string, string> = {}) =>
  new HttpResponse(body.buffer as ArrayBuffer, { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extra } })

/** Respuesta del archivo de demostración de una clave (`logos/altos.png`, `org/…/informe.pdf`…), o `null` si no hay ninguno. */
export function mockFileResponse(key: string): Response | null {
  const file = key.split('/').at(-1) ?? ''
  const zip = /^exports\/bottle-codes\/([^/]+)\/([^/]+)\.zip$/.exec(key)
  if (zip) {
    const body = bottleExportZip(zip[1]!, zip[2]!)
    return body ? binary(body, 'application/zip', { 'Content-Disposition': `attachment; filename="${file}"` }) : null
  }
  if (IMAGE.test(file)) {
    const svg = /(^|\/)logos\//.test(key) ? logoSvg(file) : bottleSvg(file)
    return new HttpResponse(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } })
  }
  if (/\.pdf$/i.test(file)) return binary(demoPdf(titleOf(file)), 'application/pdf', { 'Content-Disposition': `inline; filename="${file}"` })
  return null
}

// Handlers de la ruta `/mocks/uploads/…` de cualquier origen: sirven los archivos de demostración.
export function buildMockFileHandlers(): HttpHandler[] {
  return [
    http.get('*/mocks/uploads/*', ({ request }) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      const key = pathname.slice(pathname.indexOf('/mocks/uploads/') + '/mocks/uploads/'.length)
      return mockFileResponse(key) ?? new HttpResponse(null, { status: 404 })
    }),
  ]
}
