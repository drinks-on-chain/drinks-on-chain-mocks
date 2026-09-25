import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateErpFixtures } from '../src/erp/seed/generate'
import { PyRandom, pyRound } from '../src/erp/seed/py-random'
import { uid } from '../src/shared/uuid'

const root = join(import.meta.dirname, '..')
const referenceDir = join(root, 'test', 'reference', 'erp')
const fixturesDir = join(root, 'fixtures', 'erp')
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const roundTrip = (data: unknown): unknown => JSON.parse(JSON.stringify(data))

describe('PyRandom (compatible con random.Random de CPython)', () => {
  // Valores obtenidos con Python 3.13.
  it('semilla entera', () => {
    const r = new PyRandom(20260925)
    expect([r.randint(0, 200), r.randint(0, 200), r.randint(0, 200)]).toEqual([84, 33, 196])
    expect(r.random()).toBe(0.5101839014684227)
    expect(r.uniform(-1.5, 1.5)).toBe(-0.204972478014132)
    expect(r.choice([...'abcdef'])).toBe('f')
    expect(new PyRandom(0).random()).toBe(0.8444218515250481)
  })

  it('semilla de texto (SHA-512, versión 2)', () => {
    const r = new PyRandom('winery-wallet:altos')
    const alphabet = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567']
    expect(Array.from({ length: 10 }, () => r.choice(alphabet)).join('')).toBe('UV5LCBMX67')
  })

  it('round() de Python (empate al par sobre el valor binario exacto)', () => {
    expect(pyRound(2.675, 2)).toBe(2.67)
    expect(pyRound(1.0625, 3)).toBe(1.062)
    expect(pyRound(0.125, 2)).toBe(0.12)
    expect(pyRound(22.25, 1)).toBe(22.2)
    expect(pyRound(-2.5)).toBe(-2)
    expect(pyRound(3.5)).toBe(4)
    expect(pyRound(98.99999999999999)).toBe(99)
  })

  it('UUID v5 igual a uuid.uuid5', () => {
    expect(uid('winery:altos')).toBe('bd7bf10b-1768-51fa-aa4e-6299f374a153')
  })
})

describe('generador del ERP', () => {
  const set = generateErpFixtures()
  const names = Object.keys(set).sort()

  it('produce los mismos archivos que la referencia de Python', () => {
    const reference = readdirSync(referenceDir).filter((f) => f.endsWith('.json')).sort()
    expect(names).toEqual(reference)
  })

  it.each(names)('%s es igual (objeto a objeto) a la salida de generate.py', (name) => {
    const generated = roundTrip(set[name as keyof typeof set])
    expect(generated).toStrictEqual(readJson(join(referenceDir, name)))
  })

  it.each(names)('fixtures/erp/%s está al día con el generador', (name) => {
    const generated = roundTrip(set[name as keyof typeof set])
    expect(readJson(join(fixturesDir, name))).toStrictEqual(generated)
  })

  it('es determinista', () => {
    expect(roundTrip(generateErpFixtures())).toStrictEqual(roundTrip(set))
  })
})
