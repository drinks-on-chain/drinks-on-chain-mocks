import type { ChainCtx } from '../../chain/engine'
import type { ChainNotice } from '../../chain/state'
import { buildChainFixtureFiles, withTokenizationMails } from '../../tokenization/fixture-files'
import type { TraceState } from '../trace/state'
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
const capture: { state?: TraceState; ctx?: ChainCtx; notices?: ChainNotice[] } = {}
const erp = buildErpFixtureFiles(base, backoffice, capture)
const ola3 = buildChainFixtureFiles(capture.state!, capture.ctx!)
// Los correos de la tokenización (Ola 3) se suman al buzón de la Ola 1.
backoffice['mailbox.json'] = withTokenizationMails(backoffice['mailbox.json'], capture.notices ?? [], { chain: capture.state!.chain, wineries: capture.state!.wineries, lots: capture.state!.lots, users: base['users.json'] })
write('erp', erp)
write('backoffice', backoffice)
write('chain', ola3.chain)
write('tokenization', ola3.tokenization)
write('public', generatePublicFixtures(erp, backoffice, capture.state!.chain))
console.log('Listo.')
