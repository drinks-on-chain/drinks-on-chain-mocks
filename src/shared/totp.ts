import { hmacSha1 } from './crypto'

// TOTP (RFC 6238: HMAC-SHA1, pasos de 30 s, 6 dígitos) para el segundo factor del personal de
// plataforma (contrato de la Ola 1 §1). Usa la hora REAL (no el reloj de los mocks) para que una
// app de autenticación o una prueba e2e generen el mismo código que aceptan los handlers.

/**
 * Secreto TOTP de demo (base32) del personal interno de los fixtures y de toda inscripción hecha
 * en los mocks. Público a propósito: solo sirve contra los mocks.
 */
export const DEMO_TOTP_SECRET = 'DRINKSONCHAINDEMOTOTPKEY'

/**
 * Atajo de los mocks: este código se acepta siempre como TOTP válido. No existe en el backend real;
 * úsalo solo en demos (las e2e deberían generar el código con `generateTotp`).
 */
export const MOCK_TOTP_BYPASS_CODE = '000000'

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
const ISSUER = 'Drinks on Chain'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decodifica base32 (RFC 4648, sin relleno; ignora espacios, guiones y mayúsculas/minúsculas). */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch)
    if (idx < 0) throw new RangeError(`Carácter base32 inválido: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** Código TOTP de un secreto base32 en un instante (ms; por defecto, ahora). */
export function generateTotp(secret: string, timeMs: number = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS)
  const msg = new Uint8Array(8)
  const view = new DataView(msg.buffer)
  view.setUint32(0, Math.floor(counter / 0x100000000))
  view.setUint32(4, counter >>> 0)
  const hash = hmacSha1(base32Decode(secret), msg)
  const offset = hash[hash.length - 1]! & 0x0f
  const binary =
    ((hash[offset]! & 0x7f) << 24) | (hash[offset + 1]! << 16) | (hash[offset + 2]! << 8) | hash[offset + 3]!
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** ¿Es `code` válido para el secreto en `timeMs` ± `window` pasos de 30 s? */
export function verifyTotp(secret: string, code: string, timeMs: number = Date.now(), window = 1): boolean {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  for (let i = -window; i <= window; i++) {
    if (generateTotp(secret, timeMs + i * TOTP_PERIOD_SECONDS * 1000) === clean) return true
  }
  return false
}

/** URL `otpauth://` para el código QR de una app de autenticación. */
export function otpauthUrl(secret: string, account: string): string {
  const label = encodeURIComponent(`${ISSUER}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`
}
