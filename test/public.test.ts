import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ErrorEnvelopeSchema,
  isValidBottleCode,
  luhnMod32CheckChar,
  merkleLeaf,
  merkleRootFromProof,
  PublicBottlePassportSchema,
  PublicCodePassportSchema,
  PublicCollectionSchema,
  PublicCollectionSummarySchema,
  PublicLotPassportSchema,
  PublicWineryProfileSchema,
  verifyMerkleProof,
  type Envelope,
  type Paged,
} from '../src'
import { erpFixtures, mockBottleCode, publicFixtures, SINGANI_CASE } from '../src/fixtures'
import { advanceMockClock, COLLECTIONS_DRAFT_CONTRACT, getErpDb, PUBLIC_LOOKUP_LIMIT, PUBLIC_ROUTE_SPECS, resetScenario, setScenario } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { migratedLotId } from '../src/erp/trace/backfill'
import { mockBottleSalt, merkleRoot } from '../src/erp/trace/bottle-code'
import { sha256Hex } from '../src/shared/crypto'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf } from './helpers'

// Dominio público de la Ola 2 (contrato §12): lo que consume el visor `/b/{código}` del Marketplace
// sin sesión. Pasaportes de lote y de botella, expediente canónico, adjuntos públicos, directorio de
// bodegas y el borrador del catálogo (§17.1). Más la coherencia de los fixtures con las reglas.

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
  resetScenario()
})
afterAll(() => server.close())

const CASE_CODE = 'CVJ-2026-SINGANI-004'
const caseSample = publicFixtures.bottleCodes.find((b) => b.lotCode === CASE_CODE)!
const codeOf = (serial: number, status = 'ACTIVE') => caseSample.codes.find((c) => c.serial === serial && c.status === status)!.code
const errorOf = (res: { json: Envelope<unknown> }) => ErrorEnvelopeSchema.parse(res.json).error
const enologa = 'mock.access.cvj_enologa'

describe('pasaportes públicos', () => {
  it('pasaporte de lote: solo datos registrados, reglas de la instantánea, línea de tiempo pública sin nombres y caché', async () => {
    const res = await call(`/v1/public/lots/${CASE_CODE}`)
    expect(res.status).toBe(200)
    // Certificado: caché de 1 h; el resto, 60 s.
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=600')
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/)
    const passport = PublicLotPassportSchema.parse(dataOf(res.json))
    expect(passport).toStrictEqual({ ...publicFixtures.passports[CASE_CODE], generatedAt: passport.generatedAt })
    expect(passport).toMatchObject({
      kind: 'LOT',
      name: 'Singani Gran Reserva 2026',
      // Ola 3: el expediente cerrado en H2 queda anclado por el relleno.
      stage: 'ANCHORED',
      winery: { slug: 'destileria-cinti-viejo', active: true },
      denomination: { applies: true, status: 'ELIGIBLE', legalException: false, rules: { minAltitudeMasl: 1600, requiredVarieties: ['Moscatel de Alejandría'] } },
      harvest: { phytosanitary: 'APPROVED', maturity: { brixDegrees: 23.4 } },
      aging: { status: 'NOT_APPLICABLE' },
      distillation: { status: 'RECORDED', heartAbvPercent: 60, restMinDays: 180, restUntil: '2026-09-20' },
      bottling: { bottles: 2950, formatCl: 75, finalAbv: 40 },
      lab: { status: 'CONFORMING' },
      rules: { origin: 'LOT_CREATION' },
      corrections: { count: 1 },
      dossier: { status: 'CLOSED', canonicalUrl: `/v1/public/lots/${CASE_CODE}/dossier`, anchor: { status: 'ANCHORED', network: 'TESTNET' } },
    })
    // S-21/S-22: roles en lugar de nombres, y ni pesos ni volúmenes intermedios.
    const text = JSON.stringify(passport)
    for (const hidden of ['Rosa Camargo', 'Lucía Rojas', '18400', '18.400', '12100', '12.100', 'membershipId', 'userId']) expect(text).not.toContain(hidden)
    expect(passport.timeline.map((e) => e.type)).toEqual(['HARVEST_WEIGHED', 'PHYTO_DECIDED', 'TANK_FILLED', 'FERMENTATION_STARTED', 'FERMENTATION_COMPLETED', 'DISTILLATION_STARTED', 'DISTILLATION_CLOSED', 'NFT_MINTED', 'COLLECTION_PUBLISHED', 'LOCK_RELEASED', 'BOTTLED', 'LAB_REGISTERED', 'DOSSIER_CLOSED', 'DOSSIER_ANCHORED', 'TOKENS_REDEEMABLE'])
    expect(passport.timeline[0]).toMatchObject({ summary: 'Uva recibida y pesada en la bodega', actorRole: 'OPERATOR', corrected: true })
    expect(passport.fermentation.treatments[0]).toEqual({ type: 'SO2_ADDITION', additive: 'Metabisulfito de potasio grado alimentario', regulatoryAuthCode: 'SENASAG-REG-ADD-2024-88', appliedAt: '2026-03-10T17:00:00Z' })
    // Sin distinguir mayúsculas.
    expect((await call(`/v1/public/lots/${CASE_CODE.toLowerCase()}`)).status).toBe(200)

    // Lote migrado sin laboratorio: lo que falta es «No registrado», nunca inventado (EA-05).
    const wine = await call('/v1/public/lots/CVJ-2026-WINE-003')
    expect(wine.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=600')
    expect(PublicLotPassportSchema.parse(dataOf(wine.json))).toMatchObject({
      stage: 'BOTTLED',
      denomination: { applies: false, rules: null },
      distillation: { status: 'NOT_APPLICABLE' },
      aging: { status: 'RECORDED', plannedMonths: 10 },
      lab: { status: 'NOT_RECORDED', laboratoryName: null, checks: [] },
      rules: { origin: 'MIGRATION' },
      dossier: { status: 'OPEN', hash: null, canonicalUrl: null },
    })
  })

  it('pasaporte de botella: «n.º 1 de 2.950», prueba Merkle frente a la raíz del expediente y código anulado', async () => {
    const dossier = erpFixtures.lotDossiers.find((d) => d.lotId === SINGANI_CASE.lotId)!
    for (const serial of [1, 17, 2950]) {
      const code = codeOf(serial)
      const passport = PublicBottlePassportSchema.parse(dataOf((await call(`/v1/public/bottles/${code}`)).json))
      expect(passport.bottle).toMatchObject({ code, codeFormatted: `${code.slice(0, 4)}-${code.slice(4)}`, serial, lotTotal: 2950, status: 'ACTIVE' })
      expect(passport.redemption).toBeNull()
      expect(passport.lot.lotCode).toBe(CASE_CODE)
      const proof = passport.bottle.merkleProof!
      expect(merkleRootFromProof(merkleLeaf({ serial, code, salt: proof.salt }), proof.path)).toBe(dossier.bottleCodes!.merkleRoot)
      // Con otra sal u otro código la prueba no cuadra.
      expect(merkleRootFromProof(merkleLeaf({ serial, code: codeOf(2), salt: proof.salt }), proof.path)).not.toBe(dossier.bottleCodes!.merkleRoot)
    }
    // El código original de la serie 17 se anuló y sustituyó antes del cierre: el visor avisa.
    const voided = PublicBottlePassportSchema.parse(dataOf((await call(`/v1/public/passports/${codeOf(17, 'VOIDED')}`)).json))
    expect(voided.bottle).toMatchObject({ serial: 17, status: 'VOIDED', merkleProof: null })
    expect(voided.lot.stage).toBe('ANCHORED')
    // Lote sin expediente cerrado: sin prueba todavía.
    const open = publicFixtures.bottleCodes.find((b) => b.lotCode === 'CVJ-2026-SINGANI-001')!
    expect(PublicBottlePassportSchema.parse(dataOf((await call(`/v1/public/bottles/${open.codes[0]!.code}`)).json)).bottle).toMatchObject({ serial: 1, lotTotal: 4080, merkleProof: null })
  })

  it('GET /v1/public/passports/{code} resuelve códigos de botella (normalizados) y de lote', async () => {
    const code = codeOf(1)
    const typed = [code, code.toLowerCase(), `${code.slice(0, 4)}-${code.slice(4)}`, ` ${code.slice(0, 4)} ${code.slice(4)} `]
    for (const input of typed) {
      const passport = PublicCodePassportSchema.parse(dataOf((await call(`/v1/public/passports/${encodeURIComponent(input)}`)).json))
      expect(passport.kind === 'BOTTLE' && passport.bottle.code).toBe(code)
    }
    const lot = PublicCodePassportSchema.parse(dataOf((await call(`/v1/public/passports/${CASE_CODE}`)).json))
    expect(lot.kind).toBe('LOT')
  })

  it('código mal formado → 422 PUB_CODE_MALFORMED; inexistente → 404 PUB_CODE_NOT_FOUND con caché corta', async () => {
    const code = codeOf(1)
    // Un carácter cambiado: el carácter de control ya no cuadra y no se consulta nada.
    const typo = `${code.slice(0, 3)}${code[3] === '2' ? '3' : '2'}${code.slice(4)}`
    for (const bad of [typo, 'ABC', 'UUUUUUUU', 'CVJ-2026-CIDER-001']) {
      const res = await call(`/v1/public/passports/${bad}`)
      expect(res.status, bad).toBe(422)
      expect(errorOf(res)).toMatchObject({ code: 'PUB_CODE_MALFORMED', details: [{ field: 'code' }] })
    }
    expect(errorOf(await call(`/v1/public/bottles/${CASE_CODE}`)).code).toBe('PUB_CODE_MALFORMED')
    expect(errorOf(await call(`/v1/public/lots/${code}`)).code).toBe('PUB_CODE_MALFORMED')

    // Bien formado pero no emitido.
    const payload = '0000000'
    const unknown = `${payload}${luhnMod32CheckChar(payload)}`
    expect(isValidBottleCode(unknown)).toBe(true)
    for (const path of [`/v1/public/bottles/${unknown}`, `/v1/public/passports/${unknown}`, '/v1/public/lots/CVJ-2026-SINGANI-999', '/v1/public/passports/XYZ-2026-WINE-001']) {
      const res = await call(path)
      expect(res.status, path).toBe(404)
      expect(errorOf(res).code).toBe('PUB_CODE_NOT_FOUND')
      expect(res.headers.get('cache-control')).toBe('public, max-age=30')
    }
    // Un lote que aún no se embotelló no tiene pasaporte, aunque exista.
    expect(erpFixtures.lots.some((l) => l.reference === 'CVJ-L2026-001' && l.lotCode === null)).toBe(true)
    // Los errores con forma imposible no cuentan como intentos de enumeración.
    expect(Object.values(getErpDb().publicMisses).flat()).toHaveLength(4)
  })

  it('enumeración (S-24): más de 20 códigos inexistentes en 10 min desde una IP → 429 PUB_TOO_MANY_LOOKUPS con Retry-After; otra IP no se ve afectada', async () => {
    const ip = { 'X-DOC-Client-IP': '203.0.113.7' }
    const miss = (n: number) => {
      const payload = n.toString(32).toUpperCase().padStart(7, '0').replace(/[ILOU]/g, '0')
      return `${payload}${luhnMod32CheckChar(payload)}`
    }
    for (let i = 0; i <= PUBLIC_LOOKUP_LIMIT.misses; i++) expect((await call(`/v1/public/bottles/${miss(i)}`, { headers: ip })).status).toBe(404)
    // A partir de aquí, ni siquiera un código válido responde desde esa IP.
    const blocked = await call(`/v1/public/bottles/${codeOf(1)}`, { headers: ip })
    expect(blocked.status).toBe(429)
    expect(errorOf(blocked).code).toBe('PUB_TOO_MANY_LOOKUPS')
    expect(Number(blocked.headers.get('retry-after'))).toBe(PUBLIC_LOOKUP_LIMIT.windowMs / 1000)
    expect((await call(`/v1/public/lots/${CASE_CODE}/dossier`, { headers: ip })).status).toBe(429)
    expect((await call(`/v1/public/bottles/${codeOf(1)}`, { headers: { 'X-Forwarded-For': '198.51.100.2, 10.0.0.1' } })).status).toBe(200)
    expect((await call(`/v1/public/bottles/${codeOf(1)}`)).status).toBe(200)
    // Pasada la ventana (reloj simulado) vuelve a responder.
    advanceMockClock(4 * 60_000)
    expect(Number((await call(`/v1/public/bottles/${codeOf(1)}`, { headers: ip })).headers.get('retry-after'))).toBe(360)
    advanceMockClock(6 * 60_000)
    expect((await call(`/v1/public/bottles/${codeOf(1)}`, { headers: ip })).status).toBe(200)
  })

  it('expediente público: los bytes canónicos reproducen la huella; con el expediente abierto no hay nada que servir', async () => {
    const dossier = erpFixtures.lotDossiers.find((d) => d.lotId === SINGANI_CASE.lotId)!
    const res = await fetch(`${API}/v1/public/lots/${CASE_CODE}/dossier`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const bytes = await res.text()
    expect(sha256Hex(bytes)).toBe(dossier.hash)
    // Sin envoltorio; JSON canónico: claves ordenadas y sin espacios.
    const doc = JSON.parse(bytes) as Record<string, unknown>
    expect(doc.success).toBeUndefined()
    expect(doc.schema).toBe('doc-dossier/1')
    expect(Object.keys(doc)).toEqual([...Object.keys(doc)].sort())
    expect(bytes).not.toMatch(/[\n\t]|": /)
    expect(bytes).toContain(dossier.bottleCodes!.merkleRoot)
    // Privacidad: ni nombres ni códigos de botella en claro.
    for (const hidden of ['Rosa Camargo', 'Lucía Rojas', codeOf(1), codeOf(2950)]) expect(bytes).not.toContain(hidden)
    // La huella no depende del momento de la consulta.
    advanceMockClock(3 * 86_400_000)
    expect(sha256Hex(await (await fetch(`${API}/v1/public/lots/${CASE_CODE}/dossier`)).text())).toBe(dossier.hash)
    // Y es la misma que ve la bodega.
    const own = await fetch(`${API}/v1/lots/${SINGANI_CASE.lotId}/dossier/canonical`, { headers: { Authorization: `Bearer ${enologa}` } })
    expect(await own.text()).toBe(bytes)

    const open = await call('/v1/public/lots/CVJ-2026-SINGANI-001/dossier')
    expect(open.status).toBe(404)
    expect(errorOf(open).code).toBe('PUB_CODE_NOT_FOUND')
  })

  it('adjuntos públicos: 302 a una URL firmada; los privados y los de otro lote → 404', async () => {
    const passport = PublicLotPassportSchema.parse(dataOf((await call(`/v1/public/lots/${CASE_CODE}`)).json))
    expect(passport.publicAttachments).toHaveLength(1)
    const label = passport.publicAttachments[0]!
    expect(label).toMatchObject({ kind: 'LABEL', url: `/v1/public/lots/${CASE_CODE}/attachments/${label.id}` })
    const res = await fetch(`${API}${label.url}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^\/mocks\/uploads\/org\/.+expires=.+signature=mock$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const privateOne = erpFixtures.lotAttachments.find((a) => a.lotId === SINGANI_CASE.lotId && a.visibility === 'PRIVATE')!
    expect((await fetch(`${API}/v1/public/lots/${CASE_CODE}/attachments/${privateOne.id}`, { redirect: 'manual' })).status).toBe(404)
    expect((await fetch(`${API}/v1/public/lots/CVJ-2026-SINGANI-001/attachments/${label.id}`, { redirect: 'manual' })).status).toBe(404)
  })

  it('el pasaporte refleja lo que cambia en el ERP: escenarios, anulaciones y bodega suspendida (S-23)', async () => {
    setScenario('laboratorio-no-conforme')
    const nonConforming = PublicLotPassportSchema.parse(dataOf((await call(`/v1/public/lots/${CASE_CODE}`)).json))
    expect(nonConforming).toMatchObject({ stage: 'BOTTLED', lab: { status: 'NON_CONFORMING' }, dossier: { status: 'OPEN', hash: null } })
    expect(nonConforming.lab.checks.find((c) => c.result === 'FAIL')).toMatchObject({ parameter: 'metanol' })
    setScenario('lote-en-reposo')
    // Sin embotellar no hay código de lote ni pasaporte.
    expect((await call(`/v1/public/lots/${CASE_CODE}`)).status).toBe(404)
    resetScenario()

    // Un código anulado **después** del cierre avisa «anulado» y conserva su prueba (entró en la raíz, S-14).
    const code = codeOf(3)
    await call(`/v1/bottle-codes/${code}/void`, { token: enologa, body: { reason: 'Botella rota en el almacén' } })
    const voided = PublicBottlePassportSchema.parse(dataOf((await call(`/v1/public/bottles/${code}`)).json)).bottle
    expect(voided.status).toBe('VOIDED')
    expect(verifyMerkleProof(merkleLeaf({ serial: 3, code, salt: voided.merkleProof!.salt }), voided.merkleProof!.path, erpFixtures.lotDossiers[0]!.bottleCodes!.merkleRoot)).toBe(true)

    const suspended = await call(`/v1/platform/wineries/${uid('winery:cintiviejo')}/suspend`, { token: 'mock.access.bo_admin', body: { reason: 'Revisión documental pendiente' } })
    expect(suspended.status).toBe(200)
    const passport = PublicLotPassportSchema.parse(dataOf((await call(`/v1/public/lots/${CASE_CODE}`)).json))
    expect(passport.winery).toMatchObject({ slug: 'destileria-cinti-viejo', active: false })
    const directory = dataOf((await call<Paged<{ slug: string }>>('/v1/public/wineries')).json)
    expect(directory.items.map((w) => w.slug)).toEqual(['altos-de-calamuchita'])
  })
})

describe('directorio de bodegas y borrador del catálogo', () => {
  it('GET /v1/public/wineries: solo bodegas activas, por nombre comercial, con filtros', async () => {
    const res = await call<Paged<unknown>>('/v1/public/wineries')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const page = dataOf(res.json)
    expect(page).toMatchObject({ total: 2, limit: 20, offset: 0 })
    const items = page.items.map((w) => PublicWineryProfileSchema.parse(w))
    expect(items).toStrictEqual(publicFixtures.wineries)
    expect(items.map((w) => w.tradeName)).toEqual(['Bodega Altos de Calamuchita', 'Destilería Cinti Viejo'])
    const slugs = async (query: string) => dataOf((await call<Paged<{ slug: string }>>(`/v1/public/wineries?${query}`)).json).items.map((w) => w.slug)
    expect(await slugs('category=DISTILLERY')).toEqual(['destileria-cinti-viejo'])
    expect(await slugs('region=tarija')).toEqual(['altos-de-calamuchita'])
    expect(await slugs('limit=1&offset=1')).toEqual(['destileria-cinti-viejo'])
    expect((await call('/v1/public/wineries?category=BAR')).status).toBe(422)
    // La ficha por slug de la Ola 1 sigue igual.
    expect(dataOf((await call('/v1/public/wineries/destileria-cinti-viejo')).json)).toStrictEqual(publicFixtures.wineries[1])
  })

  it('catálogo (BORRADOR §17.1, fuera del OpenAPI): lista y ficha con la cabecera X-Mock-Draft', async () => {
    expect(PUBLIC_ROUTE_SPECS.filter((r) => r.draft).map((r) => r.path)).toEqual(['/v1/public/collections', '/v1/public/collections/:slug'])
    const res = await call<Paged<unknown>>('/v1/public/collections')
    expect(res.headers.get('x-mock-draft')).toBe(COLLECTIONS_DRAFT_CONTRACT)
    const page = dataOf(res.json)
    const items = page.items.map((c) => PublicCollectionSummarySchema.parse(c))
    expect(page.total).toBe(publicFixtures.collections.length)
    expect(items.map((c) => [c.slug, c.status])).toEqual(publicFixtures.collections.map((c) => [c.slug, c.status]))
    // La fila no lleva la ficha.
    expect(page.items[0]).not.toHaveProperty('description')
    const slugs = async (query: string) => dataOf((await call<Paged<{ slug: string }>>(`/v1/public/collections?${query}`)).json).items.map((c) => c.slug)
    expect(await slugs('status=PRESALE')).toEqual(['singani-preventa-2026', 'singani-edicion-aniversario-2026', 'singani-el-molino-2026'])
    expect(await slugs('productType=WINE')).toEqual(['vino-la-compania-2025', 'vino-las-carreras-2025'])
    expect(await slugs('winery=altos-de-calamuchita')).toEqual(['vino-la-compania-2025', 'singani-el-portillo-2025'])
    expect(await slugs('q=gran reserva')).toEqual(['singani-gran-reserva-2026'])
    // Orden: por defecto las destacadas primero y, dentro, las más recientes.
    expect(items.map((c) => c.featured)).toEqual([true, true, true, false, false, false, false, false, false])
    // Ola 3: las colecciones reales publicadas (la preventa y la del lote anclado) van destacadas.
    expect(await slugs('featured=true')).toEqual(['singani-preventa-2026', 'singani-gran-reserva-2026', 'vino-la-compania-2025'])
    expect((await slugs('sort=featured')).join()).toBe(items.map((c) => c.slug).join())
    const byName = await slugs('sort=name')
    expect([byName.at(0), byName.at(-1)]).toEqual(['singani-canon-viejo-2025', 'vino-las-carreras-2025'])
    expect((await slugs('sort=newest')).slice(0, 3)).toEqual(['singani-preventa-2026', 'singani-edicion-aniversario-2026', 'singani-el-molino-2026'])
    // Por precio, las que aún no tienen precio van al final.
    expect(await slugs('sort=price-asc')).toEqual(['vino-la-compania-2025', 'vino-las-carreras-2025', 'singani-el-portillo-2025', 'singani-canon-viejo-2025', 'singani-el-molino-2026', 'singani-el-molino-2025', 'singani-gran-reserva-2026', 'singani-preventa-2026', 'singani-edicion-aniversario-2026'])
    expect((await slugs('sort=price-desc')).at(0)).toBe('singani-gran-reserva-2026')
    expect((await slugs('sort=price-desc')).at(-1)).toBe('singani-edicion-aniversario-2026')
    expect((await call('/v1/public/collections?sort=caro')).status).toBe(422)
    // No se ofrece un lote con el análisis no conforme ni los de una bodega que no está activa.
    expect(items.map((c) => c.slug)).not.toContain('tannat-la-angostura-2024')
    expect(items.some((c) => c.winery.slug === 'casa-uriondo')).toBe(false)

    const detail = await call('/v1/public/collections/singani-gran-reserva-2026')
    expect(detail.headers.get('x-mock-draft')).toBe(COLLECTIONS_DRAFT_CONTRACT)
    const collection = PublicCollectionSchema.parse(dataOf(detail.json))
    expect(collection).toStrictEqual(publicFixtures.collections.find((c) => c.slug === collection.slug))
    // Ola 3: la ficha sale de la colección real del lote (60 botellas tokenizadas, anclado → en venta).
    expect(collection).toMatchObject({ lotStage: 'ANCHORED', status: 'ON_SALE', saleState: 'ON_SALE', availability: { total: 60, available: 60 }, counts: { available: 60 }, price: { amountMinor: 28000, currency: 'BOB' }, lot: { lotCode: CASE_CODE } })
    // Preventa: lote en proceso, con su fecha estimada y sin código de lote todavía.
    const presale = PublicCollectionSchema.parse(dataOf((await call('/v1/public/collections/singani-el-molino-2026')).json))
    expect(presale).toMatchObject({ status: 'PRESALE', lotStage: 'DISTILLING', lot: { lotCode: null } })
    expect((await call('/v1/public/collections/no-existe')).status).toBe(404)
    // Las rutas del OpenAPI no llevan la cabecera.
    expect((await call('/v1/public/wineries')).headers.get('x-mock-draft')).toBeNull()
  })
})

describe('coherencia de los fixtures de la Ola 2', () => {
  const F = erpFixtures

  it('los lotes migrados tienen el mismo UUID v5 que la semilla del backend: uid("lot:" + pesaje)', () => {
    const migrated = F.lots.filter((l) => l.rules.origin === 'MIGRATION')
    expect(migrated).toHaveLength(12)
    for (const lot of migrated) {
      expect(lot.links.harvestBatchIds, lot.reference).toHaveLength(1)
      expect(lot.id).toBe(migratedLotId(lot.links.harvestBatchIds[0]!))
      expect(lot.id).toBe(uid(`lot:${lot.links.harvestBatchIds[0]}`))
    }
    // El lote del caso de demostración es nativo, con id estable.
    expect(SINGANI_CASE.lotId).toBe(F.lots.find((l) => l.name === SINGANI_CASE.name)!.id)
  })

  it('todos los lotes y etapas: cada registro apunta a un lote de su bodega y hay un lote en cada etapa de la demo', () => {
    const lots = new Map(F.lots.map((l) => [l.id, l]))
    const rows = [...F.harvestBatches, ...F.fermentationTanks, ...F.wineAging, ...F.productionBatches, ...F.bottling]
    for (const row of rows) {
      if (row.lotId === null) continue
      expect(lots.get(row.lotId)?.wineryId, row.id).toBe(row.wineryId)
    }
    for (const lab of F.labAnalyses) expect(lab.lotId).toBe(F.bottling.find((b) => b.id === lab.bottlingBatchId)!.lotId)
    expect(F.harvestBatches.filter((h) => h.lotId === null)).toHaveLength(1)
    expect(new Set(F.lots.map((l) => l.stage))).toEqual(new Set(['ORIGIN', 'HARVEST', 'FERMENTING', 'AGING', 'DISTILLING', 'RESTING', 'BOTTLED', 'ANCHORED', 'REJECTED', 'DISCARDED']))
    // Un embotellado por lote, y el código de lote solo existe tras embotellar.
    expect(new Set(F.bottling.map((b) => b.lotId)).size).toBe(F.bottling.length)
    for (const lot of F.lots) expect(lot.lotCode !== null, lot.reference).toBe(F.bottling.some((b) => b.lotId === lot.id))
    // La línea de tiempo de cada lote es consecutiva.
    for (const lot of F.lots) {
      const seqs = F.lotEvents.filter((e) => e.lotId === lot.id).map((e) => e.seq)
      expect(seqs, lot.reference).toEqual(seqs.map((_, i) => i + 1))
    }
    // Ningún lote de los fixtures nace con incidencias (las crea el escenario `lote-con-incidencia`).
    expect(F.lots.filter((l) => l.complianceIssuesOpen > 0)).toEqual([])
  })

  it('códigos de botella: 25.790 códigos válidos y únicos entre lotes; los 2.950 del caso con su raíz Merkle', () => {
    const all = new Set<string>()
    let total = 0
    for (const bl of F.bottleLots) {
      for (let serial = 1; serial <= bl.total; serial++) {
        const code = mockBottleCode(bl.lotId, serial, bl.generations[String(serial)] ?? 0)
        if (!isValidBottleCode(code)) throw new Error(`código inválido: ${code}`)
        all.add(code)
      }
      for (const v of bl.voided) all.add(v.code)
      total += bl.total + bl.voided.length
    }
    expect(total).toBe(4080 + 2140 + 3860 + 5320 + 4400 + 1040 + 1120 + 880 + 2950 + 1)
    expect(all.size).toBe(total)
    // Las muestras de `fixtures/public/bottle-codes.json` son esos mismos códigos.
    for (const sample of publicFixtures.bottleCodes) {
      const bl = F.bottleLots.find((b) => b.lotId === sample.lotId)!
      expect(sample.total).toBe(bl.total)
      for (const c of sample.codes) expect(all.has(c.code), c.code).toBe(true)
    }

    const bl = F.bottleLots.find((b) => b.lotId === SINGANI_CASE.lotId)!
    expect(bl).toMatchObject({ total: SINGANI_CASE.bottles, generations: { [SINGANI_CASE.replacedSerial]: 1 }, allVoided: null })
    const leaves = Array.from({ length: bl.total }, (_, i) => {
      const serial = i + 1
      const generation = bl.generations[String(serial)] ?? 0
      return merkleLeaf({ serial, code: mockBottleCode(bl.lotId, serial, generation), salt: mockBottleSalt(bl.lotId, serial, generation) })
    })
    const dossier = F.lotDossiers.find((d) => d.lotId === SINGANI_CASE.lotId)!
    expect(dossier.bottleCodes).toEqual({ count: 2950, merkleRoot: merkleRoot(leaves), algorithm: 'sha256-merkle/serial-code-salt' })
  })

  it('el caso del §18 cuadra con sus números: 18.400 kg → 12.100 L → 1.500 L al 60 % → 2.950 botellas de 75 cL al 40 %', () => {
    const lot = F.lots.find((l) => l.id === SINGANI_CASE.lotId)!
    const harvest = F.harvestBatches.find((h) => h.lotId === lot.id)!
    const tank = F.fermentationTanks.find((t) => t.lotId === lot.id)!
    const distillation = F.productionBatches.find((p) => p.lotId === lot.id)!
    const bottling = F.bottling.find((b) => b.lotId === lot.id)!
    const lab = F.labAnalyses.find((a) => a.lotId === lot.id)!
    expect(lot).toMatchObject({ wineryId: SINGANI_CASE.wineryId, stage: 'ANCHORED', lotCode: CASE_CODE, bottles: 2950, labStatus: 'CONFORMING', dossierStatus: 'CLOSED' })
    expect(lot.rules).toMatchObject({ singani: { minAltitudeMasl: 1600, minRestDays: 180 }, bottling: { maxLossPercent: 5 } })
    expect(harvest).toMatchObject({ id: SINGANI_CASE.harvestBatchId, netWeightKg: 18400, phytosanitaryStatus: 'APPROVED' })
    expect(tank).toMatchObject({ volumeFilledLiters: 12100, finalVolumeLiters: 12100, destinationType: 'SINGANI_DIST' })
    expect(distillation).toMatchObject({ inputVolumeLiters: 12100, headsLiters: 120, heartLiters: 1500, tailsLiters: 210, heartAbvPercent: 60, restStatus: 'BOTTLED' })
    expect(bottling).toMatchObject({ internationalLotCode: CASE_CODE, totalBottlesPackaged: 2950, packagingFormatCl: 75, finalAlcoholAbv: 40, waterDilutionLiters: 750, productType: 'SINGANI' })
    expect(bottling.balance).toMatchObject({ availableLiters: 1500, bottledLiters: 2212.5, lossLiters: 37.5, lossPercent: 1.67, pureAlcohol: { availableLiters: 900, bottledLiters: 885 } })
    expect(lab).toMatchObject({ conformityStatus: 'CONFORMING', methanolMg100mlAa: 46.5, copperContentMgL: 0.8, actualAlcoholAbv: 40.1 })
    // Reposo de 180 días cumplido antes de embotellar.
    const rested = (Date.parse(bottling.bottlingDate) - Date.parse(distillation.processEndDate!)) / 86_400_000
    expect(rested).toBeGreaterThanOrEqual(180)
  })
})
