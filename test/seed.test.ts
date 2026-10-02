import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateBackofficeFixtures } from '../src/backoffice/seed/generate'
import { generateErpFixtures } from '../src/erp/seed/generate'
import { buildErpFixtureFiles } from '../src/erp/seed/trace'
import { generatePublicFixtures } from '../src/public/seed'
import { PyRandom, pyRound } from '../src/erp/seed/py-random'
import { uid } from '../src/shared/uuid'

const root = join(import.meta.dirname, '..')
const referenceDir = join(root, 'test', 'reference', 'erp')
const fixturesDir = join(root, 'fixtures', 'erp')
const publicDir = join(root, 'fixtures', 'public')
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

// Las filas base del ERP (los datos anteriores a la migración de la Ola 2) son iguales a las de
// `generate.py`. Lo que se escribe en `fixtures/erp/` son esas filas ya migradas más las colecciones
// de la Ola 2 (`buildErpFixtureFiles`, solo en TypeScript), y de ellas salen los de `fixtures/public/`.
describe('generador del ERP', () => {
  const set = generateErpFixtures()
  const names = Object.keys(set).sort()
  const files = buildErpFixtureFiles(set, generateBackofficeFixtures(set))
  const fileNames = Object.keys(files).sort()
  const publicFiles = generatePublicFixtures(files, generateBackofficeFixtures(set))

  it('produce los mismos archivos que la referencia de Python', () => {
    const reference = readdirSync(referenceDir).filter((f) => f.endsWith('.json')).sort()
    expect(names).toEqual(reference)
  })

  it.each(names)('%s es igual (objeto a objeto) a la salida de generate.py', (name) => {
    const generated = roundTrip(set[name as keyof typeof set])
    expect(generated).toStrictEqual(readJson(join(referenceDir, name)))
  })

  it('fixtures/erp tiene las filas del ERP y las colecciones de la Ola 2', () => {
    expect(readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()).toEqual(fileNames)
    expect(fileNames.filter((n) => !names.includes(n))).toEqual([
      'bottle-lots.json',
      'corrections.json',
      'lot-attachments.json',
      'lot-dossiers.json',
      'lot-events.json',
      'lots.json',
      'maturity-analyses.json',
      'phyto-decisions.json',
    ])
  })

  it.each(fileNames)('fixtures/erp/%s está al día con el generador', (name) => {
    const generated = roundTrip(files[name as keyof typeof files])
    expect(readJson(join(fixturesDir, name))).toStrictEqual(generated)
  })

  it.each(Object.keys(publicFiles))('fixtures/public/%s está al día con el generador', (name) => {
    const generated = roundTrip(publicFiles[name as keyof typeof publicFiles])
    expect(readJson(join(publicDir, name))).toStrictEqual(generated)
  })

  it('es determinista', () => {
    expect(roundTrip(generateErpFixtures())).toStrictEqual(roundTrip(set))
    expect(roundTrip(buildErpFixtureFiles(set, generateBackofficeFixtures(set)))).toStrictEqual(roundTrip(files))
  })
})
