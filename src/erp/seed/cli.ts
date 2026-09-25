import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateErpFixtures } from './generate'

// `pnpm seed`: escribe fixtures/erp/*.json (JSON con 2 espacios y salto de línea final).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const outDir = join(root, 'fixtures', 'erp')
mkdirSync(outDir, { recursive: true })

console.log('Generando fixtures del ERP en', outDir)
const set = generateErpFixtures()
for (const [name, data] of Object.entries(set)) {
  writeFileSync(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  const count = Array.isArray(data) ? String(data.length) : 'obj'
  console.log(`  ${name.padEnd(32)} ${count}`)
}
console.log('Listo.')
