import { createHash } from 'node:crypto'

// Mersenne Twister compatible bit a bit con `random.Random` de CPython 3.x (versión de
// semilla 2). Implementa lo que usa `generate.py`: semilla entera o de texto, random(),
// getrandbits(), _randbelow(), randint(), randrange(), uniform() y choice().
// Solo para el generador (usa node:crypto para el SHA-512 de las semillas de texto).

const N = 624
const M = 397
const MATRIX_A = 0x9908b0df
const UPPER_MASK = 0x80000000
const LOWER_MASK = 0x7fffffff

export class PyRandom {
  private mt = new Uint32Array(N)
  private mti = N + 1

  constructor(seed: number | string) {
    this.seed(seed)
  }

  /** `random.seed(a)` con `version=2`. */
  seed(a: number | string): void {
    let n: bigint
    if (typeof a === 'string') {
      // Python: a = int.from_bytes(a.encode() + sha512(a.encode()).digest())  (big endian)
      const bytes = Buffer.from(a, 'utf8')
      const digest = createHash('sha512').update(bytes).digest()
      const all = Buffer.concat([bytes, digest])
      n = all.length === 0 ? 0n : BigInt(`0x${all.toString('hex')}`)
    } else {
      if (!Number.isInteger(a)) throw new TypeError('PyRandom: solo semillas enteras o de texto')
      n = BigInt(Math.abs(a))
    }
    // CPython: palabras de 32 bits en little endian del valor absoluto (al menos una).
    const key: number[] = []
    while (n > 0n) {
      key.push(Number(n & 0xffffffffn))
      n >>= 32n
    }
    if (key.length === 0) key.push(0)
    this.initByArray(key)
  }

  private initGenrand(s: number): void {
    const mt = this.mt
    mt[0] = s >>> 0
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30)
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0
    }
    this.mti = N
  }

  private initByArray(key: number[]): void {
    const mt = this.mt
    this.initGenrand(19650218)
    let i = 1
    let j = 0
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30)
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1664525)) >>> 0) + key[j]! + j
      i++
      j++
      if (i >= N) {
        mt[0] = mt[N - 1]!
        i = 1
      }
      if (j >= key.length) j = 0
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30)
      mt[i] = ((mt[i]! ^ Math.imul(prev, 1566083941)) >>> 0) - i
      i++
      if (i >= N) {
        mt[0] = mt[N - 1]!
        i = 1
      }
    }
    mt[0] = 0x80000000
  }

  /** genrand_uint32 */
  private next32(): number {
    const mt = this.mt
    if (this.mti >= N) {
      let kk = 0
      let y: number
      for (; kk < N - M; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)
        mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK)
        mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)
      }
      y = (mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK)
      mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)
      this.mti = 0
    }
    let y = mt[this.mti++]!
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    y ^= y >>> 18
    return y >>> 0
  }

  /** Float en [0, 1) con 53 bits, como `random.random()`. */
  random(): number {
    const a = this.next32() >>> 5
    const b = this.next32() >>> 6
    return (a * 67108864 + b) * (1 / 9007199254740992)
  }

  /** `getrandbits(k)` para 0 ≤ k ≤ 32 (lo único que necesita el generador). */
  getrandbits(k: number): number {
    if (k < 0 || k > 32 || !Number.isInteger(k)) throw new RangeError('PyRandom.getrandbits: 0 ≤ k ≤ 32')
    if (k === 0) return 0
    return this.next32() >>> (32 - k)
  }

  /** `_randbelow_with_getrandbits(n)`. */
  randbelow(n: number): number {
    if (n <= 0) throw new RangeError('PyRandom.randbelow: n > 0')
    const k = 32 - Math.clz32(n) // n.bit_length()
    let r = this.getrandbits(k)
    while (r >= n) r = this.getrandbits(k)
    return r
  }

  randrange(start: number, stop: number): number {
    const width = stop - start
    if (width <= 0) throw new RangeError('PyRandom.randrange: rango vacío')
    return start + this.randbelow(width)
  }

  /** `randint(a, b)`, ambos incluidos. */
  randint(a: number, b: number): number {
    return this.randrange(a, b + 1)
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random()
  }

  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new RangeError('PyRandom.choice: secuencia vacía')
    return seq[this.randbelow(seq.length)]!
  }
}

/**
 * `round(x, ndigits)` de Python: redondeo correcto del valor binario exacto, con empate al par.
 * Con `ndigits = 0` equivale a `round(x)` (devuelve un entero).
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x
  const neg = x < 0 || Object.is(x, -0)
  const exact = Math.abs(x).toFixed(100) // expansión decimal exacta del double
  const [intPart = '0', frac = ''] = exact.split('.')
  const kept = intPart + frac.slice(0, ndigits)
  const rest = frac.slice(ndigits)
  const first = rest.charCodeAt(0) - 48
  const tail = /[1-9]/.test(rest.slice(1))
  const lastDigit = kept.charCodeAt(kept.length - 1) - 48
  const up = first > 5 || (first === 5 && (tail || lastDigit % 2 === 1))
  let digits = BigInt(kept)
  if (up) digits += 1n
  const s = digits.toString().padStart(ndigits + 1, '0')
  const text = ndigits > 0 ? `${s.slice(0, s.length - ndigits)}.${s.slice(s.length - ndigits)}` : s
  const value = Number(text)
  return neg ? -value : value
}
