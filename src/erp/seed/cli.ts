import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateBackofficeFixtures } from '../../backoffice/seed/generate'
import { generateErpFixtures } from './generate'

// `pnpm seed`: escribe fixtures/erp/*.json y fixtures/backoffice/*.json (JSON con 2 espacios y
// salto de línea final). Los de la Ola 1 parten de los del ERP (mismas bodegas y personas).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function write(domain: string, set: object) {
  const outDir = join(root, 'fixtures', domain)
  mkdirSync(outDir, { recursive: true })
  console.log(`Generando fixtures de ${domain} en`, outDir)
  for (const [name, data] of Object.entries(set)) {
    writeFileSync(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    const count = Array.isArray(data) ? String(data.length) : 'obj'
    console.log(`  ${name.padEnd(32)} ${count}`)
  }
}

const erp = generateErpFixtures()
write('erp', erp)
write('backoffice', generateBackofficeFixtures(erp))
console.log('Listo.')
