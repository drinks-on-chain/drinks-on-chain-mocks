import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateBackofficeFixtures } from '../../backoffice/seed/generate'
import { generatePublicFixtures } from '../../public/seed'
import { generateErpFixtures } from './generate'
import { buildErpFixtureFiles } from './trace'

// `pnpm seed`: escribe fixtures/erp/*.json, fixtures/backoffice/*.json y fixtures/public/*.json
// (JSON con 2 espacios y salto de línea final). Los de la Ola 1 parten de las filas base del ERP
// (mismas bodegas y personas); los de la Ola 2 (lotes, línea de tiempo, códigos de botella,
// expediente) y los públicos, de esas filas migradas con la configuración del back office.

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

const base = generateErpFixtures()
const backoffice = generateBackofficeFixtures(base)
const erp = buildErpFixtureFiles(base, backoffice)
write('erp', erp)
write('backoffice', backoffice)
write('public', generatePublicFixtures(erp, backoffice))
console.log('Listo.')
