#!/usr/bin/env node
// `pnpm openapi:pull -- <url|ruta>`: copia un OpenAPI 3 a openapi/erp.json y resume qué cambió.
//
//   pnpm openapi:pull -- https://136.243.223.39.sslip.io/docs-json
//   pnpm openapi:pull -- https://raw.githubusercontent.com/drinks-on-chain/drinks-on-chain-back/dev/openapi.json
//   pnpm openapi:pull -- ../drinks-on-chain-back/openapi.json
//
// Después: `pnpm test` (la prueba de contrato compara RouteSpec, fixtures y respuestas con el
// OpenAPI nuevo) y, si una operación «adelantada» ya llegó, bórrala de openapi/pendientes.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'openapi', 'erp.json')
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

const source = process.argv.slice(2).find((arg) => arg !== '--')
if (!source) {
  console.error('Uso: pnpm openapi:pull -- <url|ruta del openapi.json>')
  process.exit(1)
}

async function load(from) {
  if (/^https?:\/\//i.test(from)) {
    const res = await fetch(from, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`${from} respondió ${res.status} ${res.statusText}`)
    return res.json()
  }
  const path = resolve(process.cwd(), from)
  if (!existsSync(path)) throw new Error(`No existe ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function operations(spec) {
  const ops = new Set()
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) if (METHODS.includes(method)) ops.add(`${method.toUpperCase()} ${path}`)
  }
  return ops
}

try {
  const spec = await load(source)
  if (typeof spec?.openapi !== 'string' || !spec.openapi.startsWith('3.') || typeof spec.paths !== 'object') {
    throw new Error('El documento no es un OpenAPI 3 (faltan `openapi: 3.x` o `paths`)')
  }
  const before = existsSync(target) ? operations(JSON.parse(readFileSync(target, 'utf8'))) : new Set()
  const after = operations(spec)
  writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')

  const added = [...after].filter((op) => !before.has(op)).sort()
  const removed = [...before].filter((op) => !after.has(op)).sort()
  const schemas = Object.keys(spec.components?.schemas ?? {}).length
  console.log(`openapi/erp.json ← ${source}`)
  console.log(`  ${Object.keys(spec.paths).length} rutas, ${after.size} operaciones, ${schemas} esquemas (versión ${spec.info?.version ?? '?'})`)
  for (const op of added) console.log(`  + ${op}`)
  for (const op of removed) console.log(`  - ${op}`)
  if (!added.length && !removed.length) console.log('  Mismas operaciones que antes.')
  console.log('Siguiente paso: pnpm test (prueba de contrato) y revisar openapi/pendientes.json y docs/CONTRATO.md.')
} catch (err) {
  console.error(`openapi:pull: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
