import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  BottleCodeExportSchema,
  BottleUnitSchema,
  BOTTLE_ZIP_MAX_CODES,
  CANONICAL_DOSSIER_KEYS,
  CanonicalDossierSchema,
  canonicalJson,
  ErrorEnvelopeSchema,
  FermentationTankDetailSchema,
  LotGraphSchema,
  LotSchema,
  merkleLeaf,
  merkleParent,
  merkleRoot,
  merkleRootFromProof,
  PublicBottlePassportSchema,
  PublicLotPassportSchema,
  sha256Hex,
  verifyMerkleProof,
  type ApiErrorDetail,
  type Envelope,
  type Lot,
  type Paged,
} from '../src'
import { erpFixtures, PASSPORT_CASES, publicFixtures, SINGANI_CASE } from '../src/fixtures'
import { advanceMockClock, createMockHandlers, PUBLIC_RATE_LIMIT, RESPONSE_SCENARIOS, resetScenario, SCENARIO_DESCRIPTIONS, SCENARIOS, setScenario } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf } from './helpers'

// Precisiones del backend con la Etapa 2 completa (mocks 0.5.0-rc.2; `docs/CONTRATO.md` §11):
// marcas de corrección y registros anulados, volúmenes e historial del tanque, exportaciones de
// códigos de botella, expediente canónico y raíz Merkle, escrituras tras el cierre, pasaporte
// público y los archivos de `/mocks/uploads`.

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
  resetScenario()
})
afterAll(() => server.close())

const DAY_MS = 86_400_000
const F = erpFixtures
const CINTI = uid('winery:cintiviejo')
const ALTOS = uid('winery:altos')
const as = (key: string) => `mock.access.${key}`
const enologa = as('cvj_enologa')
const operario = as('cvj_operario')
const agronomo = as('cvj_agronomo')
const T = (key: string) => uid(`terroir:${key}`)
const file = (wineryId: string, name: string) => `org/${wineryId}/docs/2026/09/${name}`
const CASE_CODE = PASSPORT_CASES.certified

function failure(res: { status: number; json: Envelope<unknown> }): { status: number; code: string; message: string; details: ApiErrorDetail[] } {
  const { error } = ErrorEnvelopeSchema.parse(res.json)
  return { status: res.status, code: error.code, message: error.message, details: error.details ?? [] }
}
const post = <R = Record<string, unknown>>(path: string, token: string, body: unknown = {}) => call<R>(path, { token, body })
const get = async <R = Record<string, unknown>>(path: string, token: string) => dataOf((await call<R>(path, { token })).json)
const lotOf = async (id: string, token = enologa): Promise<Lot> => LotSchema.parse(await get(`/v1/lots/${id}`, token))
const lotByCode = (code: string) => F.lots.find((l) => l.lotCode === code)!
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

describe('marcas de corrección y registros anulados (§9)', () => {
  it('una lectura anulada se devuelve marcada, no cuenta en las métricas del tanque y marca el tanque como corregido', async () => {
    const lot = F.lots.find((l) => l.wineryId === ALTOS && l.name === 'Moscatel Los Sauces 2026')!
    const tank = F.fermentationTanks.find((t) => t.lotId === lot.id)!
    const token = as('altos_enologa')
    const before = FermentationTankDetailSchema.parse(await get(`/v1/fermentation-tanks/${tank.id}`, token))
    expect(before).toMatchObject({ correctedFields: [], voided: false, correctionIds: [] })
    expect(before.logs!.every((l) => l.voided === false && l.voidedAt === null)).toBe(true)
    // La última lectura (33,4 °C) dispara la alerta del panel; se anula por errónea.
    const hot = before.logs!.at(-1)!
    expect(hot.temperatureCelsius).toBe(33.4)
    const dashboard = async () => (await get<{ fermentationAlerts: { tankCode: string; kind: string }[] }>('/v1/traceability/dashboard', token)).fermentationAlerts.filter((a) => a.tankCode === tank.tankCode)
    expect(await dashboard()).toMatchObject([{ kind: 'HIGH_TEMPERATURE' }])
    const voided = await post<{ id: string; changes: unknown[] }>(`/v1/lots/${lot.id}/corrections`, token, { target: { type: 'FERMENTATION_LOG', id: hot.id }, kind: 'VOID', reason: 'Sonda descalibrada: lectura errónea' })
    expect(voided.status).toBe(201)
    // Una anulación no lleva cambios de campos.
    expect(dataOf(voided.json).changes).toEqual([])
    const after = FermentationTankDetailSchema.parse(await get(`/v1/fermentation-tanks/${tank.id}`, token))
    expect(after.logs).toHaveLength(before.logs!.length)
    expect(after.logs!.at(-1)).toMatchObject({ id: hot.id, voided: true, voidedAt: '2026-09-25T12:01:00Z', correctionIds: [dataOf(voided.json).id] })
    // La lectura anulada deja de contar: ya no hay alerta de temperatura y, como la anterior es de hace
    // más de 48 h, el panel avisa de que el tanque está sin lecturas. El grafo tampoco la cuenta.
    expect(await dashboard()).toMatchObject([{ kind: 'NO_READING', value: 30.6 }])
    const node = LotGraphSchema.parse(await get(`/v1/lots/${lot.id}/graph`, token)).nodes.find((n) => n.id === tank.id)!
    expect(node.corrected).toBe(true)
    expect(Object.fromEntries(node.metrics.map((m) => [m.key, m.value]))).toMatchObject({ readings: before.logs!.length - 1, lastTemperatureC: 30.6 })
    // Anular dos veces → 409 CONFLICT.
    expect(failure(await post(`/v1/lots/${lot.id}/corrections`, token, { target: { type: 'FERMENTATION_LOG', id: hot.id }, kind: 'VOID', reason: 'Otra vez la misma lectura' }))).toMatchObject({ status: 409, code: 'CONFLICT' })
  })

  it('anular el análisis de laboratorio vigente devuelve la vigencia al anterior; el anulado sigue en la lista y en el grafo (VOIDED)', async () => {
    setScenario('laboratorio-no-conforme')
    const lotId = SINGANI_CASE.lotId
    const reanalysis = dataOf((await post<{ id: string }>(`/v1/lots/${lotId}/lab-analyses`, enologa, { certifiedLaboratoryName: 'Laboratorio ISO 17025', accreditedLabCertificationCode: 'LAB-2', testPerformedAt: '2026-09-25', actualAlcoholAbv: 40, totalAcidityTartaricGl: 4.6, volatileAcidityAceticGl: 0.2, methanolMg100mlAa: 52, copperContentMgL: 0.6, laboratoryReportKey: file(CINTI, 'reanalisis.pdf') })).json)
    expect((await lotOf(lotId)).labStatus).toBe('CONFORMING')
    expect((await post(`/v1/lots/${lotId}/corrections`, enologa, { target: { type: 'LAB_ANALYSIS', id: reanalysis.id }, kind: 'VOID', reason: 'Informe de otra partida cargado por error' })).status).toBe(201)
    // El lote vuelve al análisis anterior (no conforme).
    expect((await lotOf(lotId)).labStatus).toBe('NON_CONFORMING')
    const labs = dataOf((await call<Paged<{ id: string; current: boolean; voided: boolean; voidedAt: string | null; supersededAt: string | null }>>(`/v1/lots/${lotId}/lab-analyses`, { token: operario })).json).items
    expect(labs.map((l) => [l.current, l.voided, l.voidedAt !== null, l.supersededAt !== null])).toEqual([
      [false, true, true, false],
      [true, false, false, false],
    ])
    const statuses = LotGraphSchema.parse(await get(`/v1/lots/${lotId}/graph`, enologa)).nodes.filter((n) => n.type === 'LAB_ANALYSIS').map((n) => n.status)
    expect(statuses.sort()).toEqual(['NON_CONFORMING', 'VOIDED'])
    // En el pasaporte no sale como vigente ni en la línea de tiempo.
    const passport = PublicLotPassportSchema.parse(dataOf((await call(`/v1/public/lots/${CASE_CODE}`)).json))
    expect(passport.lab.status).toBe('NON_CONFORMING')
    expect(passport.timeline.filter((e) => e.type === 'LAB_REGISTERED')).toHaveLength(1)
    expect(passport.corrections.count).toBe(2)
  })

  it('dictamen: se anula mientras la uva no entró a un tanque (un lote REJECTED vuelve a abrirse); con la uva en tanque → 409 TRC_PHYTO_DECISION_FINAL', async () => {
    const rejected = F.lots.find((l) => l.wineryId === ALTOS && l.stage === 'REJECTED')!
    const harvest = F.harvestBatches.find((h) => h.lotId === rejected.id)!
    const decision = F.phytoDecisions.find((d) => d.harvestBatchId === harvest.id)!
    const token = as('altos_agronomo')
    // Un lote rechazado solo admite anular un dictamen.
    expect(failure(await post(`/v1/lots/${rejected.id}/corrections`, as('altos_operario'), { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'AMEND', changes: { grossWeightKg: 1 }, reason: 'No se corrige un lote rechazado' }))).toMatchObject({
      status: 409,
      code: 'TRC_LOT_TERMINAL',
      details: [{ meta: { stage: 'REJECTED' } }],
    })
    expect((await post(`/v1/lots/${rejected.id}/corrections`, token, { target: { type: 'PHYTO_DECISION', id: decision.id }, kind: 'VOID', reason: 'Rechazo dictado sobre el pesaje equivocado' })).status).toBe(201)
    expect(await lotOf(rejected.id, token)).toMatchObject({ stage: 'HARVEST', phyto: { pending: 1, rejected: 0 } })
    const view = await get<{ phytosanitaryStatus: string; phytoDecisions: { voided: boolean }[] }>(`/v1/harvest-batches/${harvest.id}`, token)
    expect(view).toMatchObject({ phytosanitaryStatus: 'PENDING_INSPECTION', phytoDecisions: [{ voided: true }] })
    // Con la uva ya en un tanque el dictamen no se anula.
    const inTank = F.harvestBatches.find((h) => h.lotId === SINGANI_CASE.lotId)!
    const resting = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'RESTING')!
    const restingHarvest = F.harvestBatches.find((h) => h.lotId === resting.id)!
    const restingDecision = F.phytoDecisions.find((d) => d.harvestBatchId === restingHarvest.id)!
    expect(inTank).toBeDefined()
    expect(failure(await post(`/v1/lots/${resting.id}/corrections`, agronomo, { target: { type: 'PHYTO_DECISION', id: restingDecision.id }, kind: 'VOID', reason: 'Se quiere deshacer el dictamen' }))).toMatchObject({ status: 409, code: 'TRC_PHYTO_DECISION_FINAL' })
    // Una parcela no se corrige por la ruta del lote, y una corrección que no cambia nada no se registra.
    expect(failure(await post(`/v1/lots/${resting.id}/corrections`, agronomo, { target: { type: 'TERROIR', id: T('cvj_01') }, kind: 'AMEND', changes: { altitudeMasl: 2000 }, reason: 'Por la ruta equivocada' })).details[0]!.field).toBe('target.type')
    expect(failure(await post(`/v1/lots/${resting.id}/corrections`, operario, { target: { type: 'HARVEST_BATCH', id: restingHarvest.id }, kind: 'AMEND', changes: { grossWeightKg: restingHarvest.grossWeightKg }, reason: 'Mismo valor que ya tenía' }))).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      details: [{ field: 'changes' }],
    })
  })

  it('corrección que incumple una regla de un embotellado ya hecho: se registra y abre una incidencia CORRECTION que bloquea el cierre', async () => {
    const lot = lotByCode(PASSPORT_CASES.bottled)
    const productionId = lot.links.productionBatchIds[0]!
    const production = await get<{ heartLiters: number | null; outputVolumeLiters: number | null }>(`/v1/production-batches/${productionId}`, enologa)
    const heart = (production.heartLiters ?? production.outputVolumeLiters)!
    const amend = (heartLiters: number, reason: string) => post<{ id: string }>(`/v1/lots/${lot.id}/corrections`, enologa, { target: { type: 'PRODUCTION_BATCH', id: productionId }, kind: 'AMEND', changes: { heartLiters }, reason })
    // El corazón era menor de lo anotado: las botellas ya hechas superan el volumen. No se puede deshacer.
    const recorded = await amend(heart / 2, 'El corazón se midió mal: el depósito tenía la mitad')
    expect(recorded.status).toBe(201)
    const withIssue = await lotOf(lot.id)
    expect(withIssue.complianceIssuesOpen).toBeGreaterThan(0)
    expect(withIssue.complianceIssues.every((i) => i.source === 'CORRECTION')).toBe(true)
    // Con la mitad de corazón, el alcohol puro embotellado supera el disponible.
    expect(withIssue.complianceIssues.map((i) => i.code)).toContain('TRC_ALCOHOL_BALANCE_EXCEEDED')
    const close = failure(await post(`/v1/lots/${lot.id}/dossier/close`, enologa, { confirm: true }))
    expect(close).toMatchObject({ status: 422, code: 'TRC_DOSSIER_NOT_READY' })
    const blocked = close.details.find((d) => d.meta?.requirement === 'NO_OPEN_COMPLIANCE_ISSUES')!
    expect(blocked.meta!.issueIds).toEqual(withIssue.complianceIssues.map((i) => i.id))
    expect(await get(`/v1/production-batches/${productionId}`, enologa)).toMatchObject({ heartLiters: heart / 2, correctedFields: ['heartLiters'], correctionIds: [dataOf(recorded.json).id] })
    // Corregir de nuevo al valor bueno resuelve las incidencias.
    expect((await amend(heart, 'Se confirma la medición original con el aforo del depósito')).status).toBe(201)
    const fixed = await lotOf(lot.id)
    expect(fixed.complianceIssuesOpen).toBe(0)
    expect(fixed.complianceIssues.every((i) => i.resolvedAt !== null)).toBe(true)
    // Lo que aún se puede evitar sí se rechaza (cortes mayores que la entrada).
    const breaks = failure(await amend(1_000_000, 'Un corazón imposible para esa entrada'))
    expect(breaks).toMatchObject({ status: 422, code: 'TRC_CORRECTION_BREAKS_RULES' })
    expect(breaks.details.map((d) => d.code)).toContain('TRC_MASS_BALANCE_EXCEEDED')
  })
})

describe('tanque: lo que le queda, merma de trasiego e historial (§4.2)', () => {
  it('availableLiters, transferLossLiters y transitions; closeTank; un tanque transferido ya no es origen; el de un lote descartado se limpia', async () => {
    const lot = dataOf((await post<{ id: string }>('/v1/lots', enologa, { name: 'Singani de pruebas 2026', harvestYear: 2026, productType: 'SINGANI' })).json)
    const harvest = dataOf((await post<{ id: string }>('/v1/harvest-batches', operario, { lotId: lot.id, terroirId: T('cvj_04'), intakeDate: '2026-09-25', grossWeightKg: 9150, tareWeightKg: 150 })).json)
    await post(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, agronomo, { decision: 'APPROVED' })
    const created = FermentationTankDetailSchema.parse(dataOf((await post('/v1/fermentation-tanks', enologa, { lotId: lot.id, inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-50', capacityLiters: 8000, volumeFilledLiters: 6000, startDate: '2026-09-25' })).json))
    expect(created).toMatchObject({ status: 'FILLING', availableLiters: 6000, transferLossLiters: null })
    expect(created.transitions).toMatchObject([{ status: 'FILLING', at: '2026-09-25T00:00:00Z', by: { role: 'ENOLOGIST' } }])
    await post(`/v1/fermentation-tanks/${created.id}/start`, enologa)
    const completed = FermentationTankDetailSchema.parse(dataOf((await post(`/v1/fermentation-tanks/${created.id}/complete`, enologa, { endDate: '2026-09-25', finalVolumeLiters: 5800, destination: 'SINGANI_DIST' })).json))
    expect(completed).toMatchObject({ status: 'COMPLETED', availableLiters: 5800, transferLossLiters: null })
    expect(completed.transitions!.map((t) => t.status)).toEqual(['FILLING', 'FERMENTING', 'COMPLETED'])
    // Una destilación parcial deja el resto disponible; con `closeTank` el resto es la merma de trasiego.
    const distill = (body: Record<string, unknown>) => post('/v1/production-batches/distillation', enologa, { fermentationTankId: created.id, equipmentIdentifier: 'AL-01', processStartDate: '2026-09-25', ...body })
    expect((await distill({ inputVolumeLiters: 3000 })).status).toBe(201)
    expect(await get(`/v1/fermentation-tanks/${created.id}`, enologa)).toMatchObject({ status: 'COMPLETED', availableLiters: 2800, transferLossLiters: null })
    expect((await distill({ inputVolumeLiters: 2700, closeTank: true })).status).toBe(201)
    const transferred = FermentationTankDetailSchema.parse(await get(`/v1/fermentation-tanks/${created.id}`, enologa))
    expect(transferred).toMatchObject({ status: 'TRANSFERRED', availableLiters: 0, transferLossLiters: 100 })
    expect(transferred.transitions!.at(-1)).toMatchObject({ status: 'TRANSFERRED', by: { role: 'ENOLOGIST' } })
    // También en la lista.
    const listed = dataOf((await call<Paged<{ id: string; transferLossLiters: number | null }>>('/v1/fermentation-tanks?limit=100', { token: enologa })).json).items.find((t) => t.id === created.id)!
    expect(listed.transferLossLiters).toBe(100)
    expect(failure(await distill({ inputVolumeLiters: 50 }))).toMatchObject({ status: 409, code: 'TRC_TANK_NOT_COMPLETED', details: [{ field: 'fermentationTankId', meta: { status: 'TRANSFERRED' } }] })
    expect(dataOf((await post(`/v1/fermentation-tanks/${created.id}/clean`, enologa)).json)).toMatchObject({ status: 'CLEANED', availableLiters: 0, transferLossLiters: 100 })

    // Un tanque migrado no guarda su historial: su único punto conocido es el llenado.
    const migrated = F.fermentationTanks.find((t) => t.wineryId === CINTI && t.tankCode === 'TK-08')!
    expect((await get<{ transitions: unknown[] }>(`/v1/fermentation-tanks/${migrated.id}`, enologa)).transitions).toEqual([{ status: 'FERMENTING', at: migrated.startDate, by: null }])

    // El tanque de un lote descartado se limpia desde cualquier estado (si no, quedaría ocupado para siempre).
    const altos = as('altos_enologa')
    const discardedLot = F.lots.find((l) => l.wineryId === ALTOS && l.stage === 'FERMENTING' && l.productType === null)!
    const fermenting = F.fermentationTanks.find((t) => t.lotId === discardedLot.id)!
    expect(failure(await post(`/v1/fermentation-tanks/${fermenting.id}/clean`, altos))).toMatchObject({ status: 409, code: 'TRC_TANK_INVALID_TRANSITION', details: [{ meta: { from: 'FERMENTING', to: 'CLEANED', allowedFrom: 'TRANSFERRED' } }] })
    await post(`/v1/lots/${discardedLot.id}/discard`, as('altos_admin'), { reason: 'Fermentación detenida' })
    expect(dataOf((await post(`/v1/fermentation-tanks/${fermenting.id}/clean`, altos)).json)).toMatchObject({ status: 'CLEANED' })
  })

  it('descartar una fuente deja un evento interno LOT_DISCARDED con data.scope SOURCE', async () => {
    const lot = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'DISTILLING')!
    const production = F.productionBatches.find((p) => p.lotId === lot.id)!
    expect(dataOf((await post(`/v1/production-batches/${production.id}/discard`, enologa, { reason: 'Destilado con olor a quemado' })).json)).toMatchObject({ restStatus: 'DISCARDED' })
    const events = (await get<{ events: { type: string; visibility: string; data: Record<string, unknown>; resource: { id: string } }[] }>(`/v1/lots/${lot.id}/timeline`, enologa)).events
    expect(events.at(-1)).toMatchObject({ type: 'LOT_DISCARDED', visibility: 'INTERNAL', data: { scope: 'SOURCE', sourceType: 'PRODUCTION_BATCH' }, resource: { id: production.id } })
    // El lote no queda descartado: solo su fuente.
    expect((await lotOf(lot.id)).stage).not.toBe('DISCARDED')
    expect(failure(await post(`/v1/production-batches/${production.id}/discard`, enologa, { reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'TRC_INVALID_STAGE' })
  })
})

describe('códigos de botella: búsqueda y exportaciones (§7.2)', () => {
  const lotId = SINGANI_CASE.lotId
  const sample = publicFixtures.bottleCodes.find((b) => b.lotCode === CASE_CODE)!
  const first = sample.codes.find((c) => c.serial === 1)!.code

  it('q busca por fragmento del código tal como se teclea o por la serie exacta', async () => {
    const search = async (q: string) => dataOf((await call<Paged<unknown>>(`/v1/lots/${lotId}/bottle-codes?q=${encodeURIComponent(q)}`, { token: enologa })).json).items.map((u) => BottleUnitSchema.parse(u))
    expect((await search(first)).map((u) => u.code)).toEqual([first])
    // Se normaliza como al leer: minúsculas, guion, `O → 0`, `I`/`L → 1`.
    expect((await search(`${first.slice(0, 4).toLowerCase()}-${first.slice(4)}`)).map((u) => u.code)).toEqual([first])
    const fragment = first.slice(2, 7)
    expect((await search(fragment)).every((u) => u.code.includes(fragment))).toBe(true)
    // La serie exacta: la 17 tiene el código anulado y su sustituto (primero el anulado).
    expect((await search('17')).filter((u) => u.serial === 17).map((u) => u.status)).toEqual(['VOIDED', 'ACTIVE'])
    // Caracteres fuera del alfabeto y sin ser una serie: sin resultados.
    expect(await search('¿?')).toEqual([])
    expect(failure(await call(`/v1/lots/${lotId}/bottle-codes?q=${'A'.repeat(21)}`, { token: enologa })).details[0]!.field).toBe('q')
  })

  it('CSV: cabecera del contrato, solo códigos activos, UTF-8 con BOM, CRLF y la exportación registrada', async () => {
    // Una baja sin sustituto: ese código ya no se imprime.
    const second = sample.codes.find((c) => c.serial === 2)!.code
    await post(`/v1/bottle-codes/${second}/void`, enologa, { reason: 'Botella rota en el almacén' })
    const res = await fetch(`${API}/v1/lots/${lotId}/bottle-codes/export?fromSerial=1&toSerial=20`, { headers: { Authorization: `Bearer ${enologa}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="codigos-${CASE_CODE}-1-20.csv"`)
    expect(res.headers.get('x-export-rows')).toBe('19')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1)
    const lines = text.split('\r\n')
    expect(lines.at(-1)).toBe('')
    expect(lines[0]).toBe('serial,code,codeFormatted,qrUrl,lotCode,lotName,productType,bottlingDate')
    expect(lines.slice(1, -1)).toHaveLength(19)
    expect(lines.slice(1, -1).map((l) => Number(l.split(',')[0]))).toEqual([1, ...Array.from({ length: 18 }, (_, i) => i + 3)])
    // De la serie sustituida sale el sustituto, no el anulado.
    const replaced = sample.codes.filter((c) => c.serial === 17)
    expect(text).toContain(replaced.find((c) => c.status === 'ACTIVE')!.code)
    expect(text).not.toContain(replaced.find((c) => c.status === 'VOIDED')!.code)
    // La exportación queda registrada con su formato y su rango, y suma en cada código.
    const exported = BottleCodeExportSchema.parse(await get(`/v1/lots/${lotId}/bottle-codes/exports/${res.headers.get('x-export-id')}`, enologa))
    expect(exported).toMatchObject({ status: 'READY', format: 'CSV', fromSerial: 1, toSerial: 20, rows: 19, downloadUrl: null, createdBy: { role: 'ENOLOGIST' } })
    const unit = BottleUnitSchema.parse(dataOf((await call<Paged<unknown>>(`/v1/lots/${lotId}/bottle-codes?fromSerial=1&toSerial=1`, { token: enologa })).json).items[0])
    expect(unit.exportsCount).toBe(2)
    // Un rango sin códigos activos no se exporta.
    expect(failure(await call(`/v1/lots/${lotId}/bottle-codes/export?fromSerial=2&toSerial=2`, { token: enologa }))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'fromSerial', message: 'No hay códigos activos en ese rango de series' }] })
  })

  it('ZIP: PENDING → READY con formato y rango, y el archivo se descarga de verdad (codigos.csv)', async () => {
    const requested = dataOf((await post<{ exportId: string }>(`/v1/lots/${lotId}/bottle-codes/exports`, enologa, { format: 'ZIP', fromSerial: 1, toSerial: 100, qr: { imageFormat: 'PNG', sizePx: 1024 } })).json)
    const url = `/v1/lots/${lotId}/bottle-codes/exports/${requested.exportId}`
    expect(BottleCodeExportSchema.parse(await get(url, enologa))).toMatchObject({ status: 'PENDING', format: 'ZIP', fromSerial: 1, toSerial: 100, rows: 100, downloadUrl: null })
    const ready = BottleCodeExportSchema.parse(await get(url, enologa))
    expect(ready).toMatchObject({ status: 'READY', expiresAt: '2026-10-02T12:01:00Z' })
    // Fuera del prefijo `org/…` de las subidas.
    expect(ready.downloadUrl).toMatch(new RegExp(`^/mocks/uploads/exports/bottle-codes/${CINTI}/${requested.exportId}\\.zip\\?expires=\\d+&signature=mock$`))
    const zip = await fetch(`${API}${ready.downloadUrl}`)
    expect(zip.status).toBe(200)
    expect(zip.headers.get('content-type')).toBe('application/zip')
    const bytes = Buffer.from(await zip.arrayBuffer())
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004')
    expect(bytes.subarray(30, 41).toString('utf8')).toBe('codigos.csv')
    const content = bytes.toString('utf8')
    expect(content).toContain(`1,${first},${first.slice(0, 4)}-${first.slice(4)},`)
    expect(content.match(/\r\n\d+,/g)).toHaveLength(100)
    // Caduca a los 7 días: la URL deja de darse (la fila se conserva).
    advanceMockClock(8 * DAY_MS)
    expect(BottleCodeExportSchema.parse(await get(url, enologa))).toMatchObject({ status: 'READY', downloadUrl: null })
  })

  it(`ZIP: como máximo ${BOTTLE_ZIP_MAX_CODES.toLocaleString('es')} códigos por exportación; un lote mayor se exporta por rangos`, async () => {
    const token = as('altos_enologa')
    const harvest = dataOf((await post<{ id: string; lotId: string }>('/v1/harvest-batches', token, { newLot: { name: 'Tannat de volumen 2026', harvestYear: 2026, productType: 'WINE' }, terroirId: T('altos_01'), intakeDate: '2026-09-25', grossWeightKg: 25100, tareWeightKg: 100 })).json)
    await post(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, as('altos_agronomo'), { decision: 'APPROVED' })
    const tank = dataOf((await post<{ id: string }>('/v1/fermentation-tanks', token, { inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-60', volumeFilledLiters: 16000, startFermentation: true, startDate: '2026-09-25' })).json)
    await post(`/v1/fermentation-tanks/${tank.id}/complete`, token, { endDate: '2026-09-25', finalVolumeLiters: 15800, destination: 'WINE_AGING' })
    expect((await post('/v1/wine-aging', token, { fermentationTankId: tank.id, containerType: 'Depósito', volumeLiters: 15600, plannedMonths: 1 })).status).toBe(201)
    advanceMockClock(31 * DAY_MS)
    const bottled = await post(`/v1/lots/${harvest.lotId}/bottling`, token, { bottlingDate: '2026-10-26', packagingFormatCl: 75, totalBottlesPackaged: 20500, finalAlcoholAbv: 13.5 })
    expect(bottled.status).toBe(201)
    const exports = `/v1/lots/${harvest.lotId}/bottle-codes/exports`
    expect(failure(await post(exports, token, { format: 'ZIP', qr: { imageFormat: 'SVG' } }))).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      details: [{ field: 'toSerial', message: 'Una exportación ZIP admite como máximo 20000 códigos (el rango tiene 20500): expórtalo por rangos de serie' }],
    })
    expect((await post(exports, token, { format: 'ZIP', fromSerial: 1, toSerial: 20000, qr: { imageFormat: 'SVG' } })).status).toBe(202)
    expect((await post(exports, token, { format: 'ZIP', fromSerial: 20001, qr: { imageFormat: 'SVG' } })).status).toBe(202)
    // El CSV no tiene ese límite.
    const csv = await fetch(`${API}/v1/lots/${harvest.lotId}/bottle-codes/export`, { headers: { Authorization: `Bearer ${token}` } })
    expect(csv.headers.get('x-export-rows')).toBe('20500')
  })

  it('plataforma: administración y operaciones listan con ?wineryId=; soporte no; nadie de la plataforma exporta ni anula', async () => {
    const list = (token: string) => call(`/v1/lots/${lotId}/bottle-codes?wineryId=${CINTI}`, { token })
    expect((await list(as('operaciones'))).status).toBe(200)
    expect((await list(as('bo_admin'))).status).toBe(200)
    expect(failure(await list(as('soporte')))).toMatchObject({ status: 403, code: 'AUTH_INSUFFICIENT_PERMISSIONS' })
    expect(failure(await call(`/v1/lots/${lotId}/bottle-codes/export?wineryId=${CINTI}`, { token: as('operaciones') }))).toMatchObject({ status: 403, code: 'AUTH_INSUFFICIENT_PERMISSIONS' })
    expect(failure(await post(`/v1/lots/${lotId}/bottle-codes/exports?wineryId=${CINTI}`, as('operaciones'), { format: 'ZIP', qr: { imageFormat: 'SVG' } }))).toMatchObject({ status: 403, code: 'TRC_PLATFORM_READ_ONLY' })
    expect(failure(await post(`/v1/bottle-codes/${first}/void?wineryId=${CINTI}`, as('operaciones'), { reason: 'Desde la plataforma' }))).toMatchObject({ status: 403, code: 'TRC_PLATFORM_READ_ONLY' })
    // Los demás roles de la bodega ven solo los totales del embotellado.
    expect((await call(`/v1/lots/${lotId}/bottle-codes`, { token: agronomo })).status).toBe(403)
  })
})

describe('expediente canónico doc-dossier/1 y raíz Merkle (§10, §20)', () => {
  it('Merkle: el padre es SHA-256 de los bytes concatenados (no del texto hex); el nodo sin pareja sube; sin hojas, SHA-256("")', () => {
    const leaves = [1, 2, 3].map((serial) => merkleLeaf({ serial, code: `CODE000${serial}`, salt: `${serial}`.repeat(32) }))
    expect(leaves[0]).toBe(sha256(`1:CODE0001:${'1'.repeat(32)}`))
    const parent = sha256(Buffer.concat([Buffer.from(leaves[0]!, 'hex'), Buffer.from(leaves[1]!, 'hex')]))
    expect(merkleParent(leaves[0]!, leaves[1]!)).toBe(parent)
    expect(merkleParent(leaves[0]!, leaves[1]!)).not.toBe(sha256(leaves[0]! + leaves[1]!))
    // Tres hojas: la tercera sube tal cual al segundo nivel.
    const root = sha256(Buffer.concat([Buffer.from(parent, 'hex'), Buffer.from(leaves[2]!, 'hex')]))
    expect(merkleRoot(leaves)).toBe(root)
    expect(merkleRoot([leaves[0]!])).toBe(leaves[0])
    expect(merkleRoot([])).toBe(sha256(''))
    // Prueba de la tercera hoja: un solo paso, con su hermano a la izquierda.
    expect(merkleRootFromProof(leaves[2]!, [{ side: 'L', hash: parent }])).toBe(root)
    expect(verifyMerkleProof(leaves[0]!, [{ side: 'R', hash: leaves[1]! }, { side: 'R', hash: leaves[2]! }], root)).toBe(true)
    expect(verifyMerkleProof(leaves[1]!, [{ side: 'R', hash: leaves[0]! }, { side: 'R', hash: leaves[2]! }], root)).toBe(false)
    expect(verifyMerkleProof('no-es-un-hash', [], root)).toBe(false)
    expect(sha256Hex('expediente')).toBe(sha256('expediente'))
  })

  it('los bytes del expediente cerrado: JCS, claves del contrato, decimales de escala fija, personas sin nombre y la raíz Merkle', async () => {
    const dossier = F.lotDossiers.find((d) => d.lotId === SINGANI_CASE.lotId)!
    const res = await fetch(`${API}/v1/lots/${SINGANI_CASE.lotId}/dossier/canonical`, { headers: { Authorization: `Bearer ${operario}` } })
    expect(res.headers.get('x-dossier-status')).toBe('CLOSED')
    expect(res.headers.get('x-dossier-hash')).toBe(dossier.hash)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bytes = await res.text()
    expect(sha256(Buffer.from(bytes, 'utf8'))).toBe(dossier.hash)
    const doc = CanonicalDossierSchema.strict().parse(JSON.parse(bytes))
    // JSON canónico (RFC 8785): volver a serializarlo da los mismos bytes.
    expect(canonicalJson(doc)).toBe(bytes)
    expect(Object.keys(doc).sort()).toEqual([...CANONICAL_DOSSIER_KEYS].sort())
    expect(doc).toMatchObject({
      schema: 'doc-dossier/1',
      closedAt: '2026-09-24T15:00:00.000Z',
      closedBy: { role: 'OWNER' },
      winery: { id: CINTI, lotPrefix: 'CVJ', tradeName: 'Destilería Cinti Viejo' },
      lot: { reference: 'CVJ-L2026-005', lotCode: CASE_CODE, productType: 'SINGANI', bottledAt: '2026-09-22' },
      harvests: [{ grossWeightKg: '18550.000', tareWeightKg: '150.000', netWeightKg: '18400.000', temperatureAtIntakeC: '16.20', phytosanitaryStatus: 'APPROVED', terroir: { altitudeMasl: '2410.00', varietyName: 'Moscatel de Alejandría' } }],
      tanks: [{ capacityLiters: '15000.00', volumeFilledLiters: '12100.00', finalVolumeLiters: '12100.00', destinationType: 'SINGANI_DIST', inputs: [{ kg: '18400.000' }] }],
      agings: [],
      distillations: [{ inputVolumeLiters: '12100.000', headsLiters: '120.000', heartLiters: '1500.000', tailsLiters: '210.000', vinasseLiters: null, heartAbvPercent: '60.00', restUntil: '2026-09-20' }],
      bottling: {
        packagingFormatCl: 75,
        totalBottlesPackaged: 2950,
        finalAlcoholAbv: '40.00',
        waterDilutionLiters: '750.000',
        leftover: null,
        balance: { availableLiters: '1500.000', bottledLiters: '2212.500', lossLiters: '37.500', lossPercent: '1.67', pureAlcohol: { availableLiters: '900.000', bottledLiters: '885.000' } },
      },
      labAnalyses: [{ actualAlcoholAbv: '40.10', methanolMg100mlAa: '46.500', copperContentMgL: '0.800', conformityStatus: 'CONFORMING', current: true, voidedAt: null }],
      corrections: [{ kind: 'AMEND', changes: [{ field: 'temperatureAtIntakeC', before: 15.8, after: 16.2 }] }],
      attachments: [{ kind: 'LABEL' }, { kind: 'DO_CERTIFICATE' }],
      bottleCodes: { count: 2950, merkleRoot: dossier.bottleCodes!.merkleRoot, algorithm: 'sha256-merkle/serial-code-salt' },
    })
    expect(doc.rules).toStrictEqual(JSON.parse(JSON.stringify(lotByCode(CASE_CODE).rules)))
    expect(doc.tanks[0]!.readings).toHaveLength(5)
    expect(doc.tanks[0]!.readings[0]).toMatchObject({ temperatureCelsius: '21.40', specificGravity: '1.0860', phValue: '3.42', voidedAt: null })
    expect(doc.tanks[0]!.treatments[0]).toMatchObject({ dosageAppliedGPerHl: '3.0000', totalAppliedG: '363.0000' })
    // Ni nombres, ni notas o motivos, ni claves o URL de archivos, ni códigos de botella.
    for (const hidden of ['Rosa Camargo', 'Lucía Rojas', 'fullName', 'userId', 'notes', 'reason', 'org/', 'mocks/uploads', publicFixtures.bottleCodes.at(-1)!.codes[0]!.code]) expect(bytes, hidden).not.toContain(hidden)
    // Lo mismo que ve el público, con la huella como ETag.
    const open = await fetch(`${API}/v1/public/lots/${CASE_CODE}/dossier`)
    expect(open.headers.get('etag')).toBe(`"${dossier.hash}"`)
    expect(await open.text()).toBe(bytes)
    expect((await fetch(`${API}/v1/public/lots/${CASE_CODE}/dossier`, { headers: { 'If-None-Match': `"${dossier.hash}"` } })).status).toBe(304)
  })

  it('vista previa: closedAt y closedBy en null, hashPreview estable mientras no cambien los registros; los anulados siguen, marcados', async () => {
    setScenario('laboratorio-no-conforme')
    const lotId = SINGANI_CASE.lotId
    const canonical = async () => {
      const res = await fetch(`${API}/v1/lots/${lotId}/dossier/canonical`, { headers: { Authorization: `Bearer ${enologa}` } })
      return { status: res.headers.get('x-dossier-status'), hash: res.headers.get('x-dossier-hash'), text: await res.text() }
    }
    const preview = async () => (await get<{ hashPreview: string }>(`/v1/lots/${lotId}/dossier/preview`, enologa)).hashPreview
    const before = await canonical()
    expect(before.status).toBe('OPEN')
    expect(JSON.parse(before.text)).toMatchObject({ closedAt: null, closedBy: null })
    expect(await preview()).toBe(before.hash)
    expect(sha256Hex(before.text)).toBe(before.hash)
    // No depende del momento de la consulta.
    advanceMockClock(3 * DAY_MS)
    expect(await preview()).toBe(before.hash)
    // Cambia cuando cambian los registros: se anula el análisis no conforme, que sigue en el expediente con su `voidedAt`.
    const lab = dataOf((await call<Paged<{ id: string }>>(`/v1/lots/${lotId}/lab-analyses`, { token: enologa })).json).items[0]!
    await post(`/v1/lots/${lotId}/corrections`, enologa, { target: { type: 'LAB_ANALYSIS', id: lab.id }, kind: 'VOID', reason: 'Análisis de otra partida cargado por error' })
    const after = await canonical()
    expect(after.hash).not.toBe(before.hash)
    const doc = CanonicalDossierSchema.parse(JSON.parse(after.text))
    expect(doc.labAnalyses).toMatchObject([{ id: lab.id, current: false, voidedAt: expect.stringMatching(/^2026-09-28T\d\d:\d\d:\d\d\.000Z$/) }])
    expect(doc.corrections.at(-1)).toMatchObject({ target: { type: 'LAB_ANALYSIS', id: lab.id }, kind: 'VOID', changes: [] })
  })

  it('tras el cierre: laboratorio, correcciones, archivos y un segundo cierre → 409 TRC_DOSSIER_CLOSED con closedAt y hash; el resto → TRC_LOT_TERMINAL', async () => {
    const lotId = SINGANI_CASE.lotId
    const dossier = F.lotDossiers.find((d) => d.lotId === lotId)!
    const harvest = F.harvestBatches.find((h) => h.lotId === lotId)!
    const tank = F.fermentationTanks.find((t) => t.lotId === lotId)!
    const lab = { certifiedLaboratoryName: 'Laboratorio ISO 17025', accreditedLabCertificationCode: 'LAB-9', testPerformedAt: '2026-09-25', actualAlcoholAbv: 40, totalAcidityTartaricGl: 4.6, volatileAcidityAceticGl: 0.2, methanolMg100mlAa: 50, copperContentMgL: 0.5, laboratoryReportKey: file(CINTI, 'informe-tardio.pdf') }
    const bottlingId = F.bottling.find((b) => b.lotId === lotId)!.id
    const closedWrites = [
      post(`/v1/lots/${lotId}/lab-analyses`, enologa, lab),
      // El alias legado responde lo mismo.
      post('/v1/lab-analyses', enologa, { ...lab, laboratoryReportKey: undefined, bottlingBatchId: bottlingId, laboratoryReportPdfUrl: 'https://laboratorio.test/informe.pdf' }),
      post(`/v1/lots/${lotId}/corrections`, enologa, { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'AMEND', changes: { notes: 'Otra nota' }, reason: 'Corrección tras el cierre del expediente' }),
      post(`/v1/lots/${lotId}/attachments`, enologa, { key: file(CINTI, 'foto.jpg'), kind: 'PHOTO', title: 'Foto' }),
      post(`/v1/lots/${lotId}/dossier/close`, enologa, { confirm: true }),
    ]
    for (const write of closedWrites) {
      const res = failure(await write)
      expect(res).toMatchObject({ status: 409, code: 'TRC_DOSSIER_CLOSED' })
      expect(res.details[0]!.meta).toEqual({ closedAt: dossier.closedAt, hash: dossier.hash })
    }
    const terminalWrites = [
      post('/v1/harvest-batches', operario, { lotId, terroirId: T('cvj_02'), intakeDate: '2026-09-25', grossWeightKg: 900, tareWeightKg: 100 }),
      post(`/v1/fermentation-tanks/${tank.id}/logs`, operario, { temperatureCelsius: 20, recordedAt: '2026-09-25T10:00:00Z' }),
      post(`/v1/lots/${lotId}/bottling`, enologa, { bottlingDate: '2026-09-25', packagingFormatCl: 75, totalBottlesPackaged: 10, finalAlcoholAbv: 40 }),
      call(`/v1/lots/${lotId}`, { token: enologa, method: 'PATCH', body: { name: 'Otro nombre' } }),
      post(`/v1/lots/${lotId}/discard`, enologa, { reason: 'No procede' }),
    ]
    for (const write of terminalWrites) expect(failure(await write)).toMatchObject({ status: 409, code: 'TRC_LOT_TERMINAL', details: [{ meta: { stage: 'CERTIFIED' } }] })
    // Lo único que el lote sigue admitiendo: anular un código sin sustituto (S-14).
    const code = publicFixtures.bottleCodes.find((b) => b.lotId === lotId)!.codes[1]!.code
    const replace = failure(await post(`/v1/bottle-codes/${code}/void`, enologa, { reason: 'Etiqueta dañada', replace: true }))
    expect(replace).toMatchObject({ status: 409, code: 'TRC_DOSSIER_CLOSED', details: [{ field: 'replace', meta: { closedAt: dossier.closedAt, hash: dossier.hash } }] })
    expect((await post(`/v1/bottle-codes/${code}/void`, enologa, { reason: 'Botella rota' })).status).toBe(200)
    // El expediente no cambia nunca más.
    expect((await get<{ hash: string }>(`/v1/lots/${lotId}/dossier`, enologa)).hash).toBe(dossier.hash)
  })
})

describe('pasaporte público: precisiones (§12)', () => {
  it('casos de los fixtures: certificado, sin laboratorio, no conforme, D.O. por excepción, registro tardío, lote retirado y bodega suspendida', async () => {
    const passport = async (key: keyof typeof PASSPORT_CASES) => {
      const res = await call(`/v1/public/passports/${PASSPORT_CASES[key]}`)
      expect(res.status, key).toBe(200)
      const data = PublicLotPassportSchema.strict().parse(dataOf(res.json))
      // El fixture es lo mismo que responde la ruta.
      expect({ ...publicFixtures.passports[PASSPORT_CASES[key]], generatedAt: data.generatedAt }).toStrictEqual(data)
      return data
    }
    expect(await passport('certified')).toMatchObject({ stage: 'CERTIFIED', lab: { status: 'CONFORMING' }, dossier: { status: 'CLOSED' }, winery: { active: true } })
    expect(await passport('bottled')).toMatchObject({ stage: 'BOTTLED', dossier: { status: 'OPEN', hash: null, closedAt: null, canonicalUrl: null }, rules: { origin: 'MIGRATION' } })
    expect(await passport('labNotRecorded')).toMatchObject({ lab: { status: 'NOT_RECORDED', laboratoryName: null, checks: [] } })
    const nonConforming = await passport('labNonConforming')
    expect(nonConforming).toMatchObject({ productType: 'WINE', stage: 'BOTTLED', lab: { status: 'NON_CONFORMING' }, denomination: { applies: false, status: 'NOT_APPLICABLE' } })
    expect(nonConforming.lab.checks.find((c) => c.result === 'FAIL')).toMatchObject({ parameter: 'acidezVolatil', value: 1.45, limit: { max: 1.2 } })
    const exception = await passport('doByException')
    expect(exception).toMatchObject({ denomination: { applies: true, status: 'ELIGIBLE_BY_EXCEPTION', legalException: true, rules: { minAltitudeMasl: 1500 } }, origin: { terroirs: [{ altitudeMasl: 1540, doStatus: 'ELIGIBLE_BY_EXCEPTION' }] } })
    expect(exception.rules.items.find((i) => i.key === 'trazabilidad.singani.altitudMinimaMsnm')).toMatchObject({ value: 1500, legalException: true })
    const late = await passport('lateEntry')
    expect(late.timeline.find((e) => e.type === 'HARVEST_WEIGHED')).toMatchObject({ lateEntry: true, summary: 'Uva recibida y pesada en la bodega', actorRole: 'OPERATOR' })
    const discarded = await passport('discarded')
    expect(discarded).toMatchObject({ stage: 'DISCARDED', lab: { status: 'NOT_RECORDED' } })
    expect(discarded.timeline.at(-1)).toMatchObject({ type: 'LOT_DISCARDED', summary: 'Lote retirado por la bodega' })
    // El motivo del descarte no es público (S-22).
    expect(JSON.stringify(discarded)).not.toContain('turbidez')
    const inactive = await passport('wineryInactive')
    expect(inactive).toMatchObject({ stage: 'BOTTLED', winery: { slug: 'casa-uriondo', tradeName: 'Casa Uriondo', active: false } })
    // Los códigos de un lote retirado responden como anulados, sin prueba.
    const sample = publicFixtures.bottleCodes.find((b) => b.lotCode === PASSPORT_CASES.discarded)!
    expect(sample.codes.every((c) => c.status === 'VOIDED')).toBe(true)
    expect(PublicBottlePassportSchema.parse(dataOf((await call(`/v1/public/bottles/${sample.codes[0]!.code}`)).json))).toMatchObject({ bottle: { status: 'VOIDED', merkleProof: null }, lot: { stage: 'DISCARDED' } })
  })

  it('forma: fermentación con instantes, región de la bodega en las parcelas, URL relativas, textos propios y reglas sin la merma máxima', async () => {
    const passport = PublicLotPassportSchema.parse(dataOf((await call(`/v1/public/lots/${CASE_CODE}`)).json))
    expect(passport.fermentation).toMatchObject({ startDate: '2026-03-10T00:00:00Z', endDate: '2026-03-21T00:00:00Z', readingsCount: 5 })
    // Un pasaporte del backend real (instantes con milisegundos) pasa el mismo esquema.
    expect(PublicLotPassportSchema.safeParse({ ...passport, fermentation: { ...passport.fermentation, startDate: '2025-03-11T14:30:00.000Z', endDate: '2025-04-13T14:30:00.000Z' } }).success).toBe(true)
    expect(passport.origin.terroirs.map((t) => t.region)).toEqual([passport.winery.region])
    expect(passport.dossier.canonicalUrl).toBe(`/v1/public/lots/${CASE_CODE}/dossier`)
    expect(passport.publicAttachments.every((a) => a.url.startsWith(`/v1/public/lots/${CASE_CODE}/attachments/`))).toBe(true)
    expect(passport.rules.items.map((i) => [i.key, i.label, i.unit])).toEqual([
      ['trazabilidad.singani.altitudMinimaMsnm', 'Altitud mínima del viñedo', 'msnm'],
      ['trazabilidad.singani.variedadesExigidas', 'Variedades exigidas', null],
      ['trazabilidad.singani.reposoMinimoDias', 'Reposo mínimo', 'días'],
      ['trazabilidad.fitosanitario.exigirAprobado', 'Dictamen fitosanitario aprobado antes de fermentar', null],
      ['trazabilidad.laboratorio.limites', 'Límites de laboratorio', null],
    ])
    expect(passport.timeline.map((e) => e.summary)).toEqual([
      'Uva recibida y pesada en la bodega',
      'Dictamen fitosanitario: aprobado',
      'Mosto en tanque de fermentación',
      'Fermentación iniciada',
      'Fermentación completada',
      'Destilación iniciada',
      'Destilación cerrada: empieza el reposo',
      'Tiempo mínimo de crianza o reposo cumplido',
      'Lote embotellado',
      'Análisis de laboratorio registrado',
      'Expediente del lote cerrado',
    ])
    // El resumen interno (con kilos, litros y motivos) no es el que se publica.
    const internal = (await get<{ events: { summary: string }[] }>(`/v1/lots/${SINGANI_CASE.lotId}/timeline`, enologa)).events.map((e) => e.summary)
    expect(internal).toContain('Pesaje de 18.400 kg desde Parcela 2 · Cañón Viejo')
    const wine = PublicLotPassportSchema.parse(dataOf((await call(`/v1/public/lots/${PASSPORT_CASES.labNotRecorded}`)).json))
    expect(wine.rules.items.map((i) => i.key)).toEqual(['trazabilidad.vino.crianzaMinimaMeses', 'trazabilidad.fitosanitario.exigirAprobado', 'trazabilidad.laboratorio.limites'])
    expect(wine.timeline.find((e) => e.type === 'AGING_STARTED')!.summary).toBe('Crianza iniciada')
  })

  it('caché: ETag con If-None-Match → 304; el lote certificado, 1 h; una botella, siempre 60 s; 422 y 429, no-store', async () => {
    const lot = await call(`/v1/public/lots/${CASE_CODE}`)
    expect(lot.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=600')
    const etag = lot.headers.get('etag')!
    const again = await fetch(`${API}/v1/public/lots/${CASE_CODE}`, { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    expect((await fetch(`${API}/v1/public/lots/${CASE_CODE}`, { headers: { 'If-None-Match': '"otro"' } })).status).toBe(200)
    const code = publicFixtures.bottleCodes.find((b) => b.lotCode === CASE_CODE)!.codes[0]!.code
    // Su código aún se puede anular (S-14).
    expect((await call(`/v1/public/bottles/${code}`)).headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=600')
    const malformed = await call('/v1/public/passports/ABC')
    expect(malformed.status).toBe(422)
    expect(malformed.headers.get('cache-control')).toBe('no-store')
    const missing = await call('/v1/public/lots/CVJ-2026-SINGANI-999')
    expect(failure(missing)).toMatchObject({ status: 404, code: 'PUB_CODE_NOT_FOUND', message: 'Código no encontrado' })
  })

  it('escenario pasaporte-saturado: límite de 60 consultas por minuto superado → 429 TOO_MANY_REQUESTS con Retry-After', async () => {
    setScenario('pasaporte-saturado')
    for (const path of [`/v1/public/passports/${CASE_CODE}`, `/v1/public/lots/${CASE_CODE}`, `/v1/public/lots/${CASE_CODE}/dossier`, '/v1/public/bottles/ABC']) {
      const res = await call(path)
      expect(failure(res), path).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS' })
      expect(res.headers.get('retry-after')).toBe(String(PUBLIC_RATE_LIMIT.retryAfterSeconds))
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    // El directorio de bodegas y el catálogo tienen su propio límite: no se ven afectados.
    expect((await call('/v1/public/wineries')).status).toBe(200)
    expect((await call('/v1/public/collections')).status).toBe(200)
    // La trazabilidad no cambia: no es un escenario de datos.
    expect((await lotOf(SINGANI_CASE.lotId)).stage).toBe('CERTIFIED')
    resetScenario()
    expect((await call(`/v1/public/passports/${CASE_CODE}`)).status).toBe(200)
  })

  it('la lista de escenarios se exporta: los de respuesta, los de datos y sus descripciones', () => {
    expect(RESPONSE_SCENARIOS).toEqual(['normal', 'empty', 'error', 'slow', 'offline'])
    expect(SCENARIOS).toContain('pasaporte-saturado')
    expect(Object.keys(SCENARIO_DESCRIPTIONS).sort()).toEqual([...SCENARIOS].sort())
  })
})

describe('coherencia de los fixtures con las precisiones', () => {
  it('la instantánea de reglas de un lote nativo es anterior a su primer evento; la de uno migrado es la de la migración', () => {
    for (const lot of F.lots) {
      const first = F.lotEvents.filter((e) => e.lotId === lot.id).sort((a, b) => a.seq - b.seq)[0]!
      if (lot.rules.origin === 'LOT_CREATION') {
        expect(lot.rules.takenAt, lot.reference).toBe(lot.createdAt)
        expect(lot.rules.takenAt <= first.recordedAt, lot.reference).toBe(true)
        expect(F.lotEvents.filter((e) => e.lotId === lot.id).every((e) => e.recordedAt >= lot.rules.takenAt), lot.reference).toBe(true)
      } else {
        expect(lot.rules.takenAt, lot.reference).toBe('2026-09-25T12:00:00Z')
      }
    }
    // En el pasaporte del caso §18, «reglas fijadas» va antes de la vendimia.
    const passport = publicFixtures.passports[CASE_CODE]!
    expect(passport.rules.takenAt < passport.timeline[0]!.occurredAt).toBe(true)
  })

  it('el dictamen de un lote migrado se anotó al migrar: su evento sale como registro tardío, como en el backend', () => {
    const lot = lotByCode(PASSPORT_CASES.bottled)
    const event = F.lotEvents.find((e) => e.lotId === lot.id && e.type === 'PHYTO_DECIDED')!
    expect(event).toMatchObject({ recordedAt: '2026-09-25T12:00:00Z', lateEntry: true })
  })

  it('límites de laboratorio por defecto: los del catálogo del backend (metanol 200 mg/100 ml a.a.)', () => {
    expect(lotByCode(CASE_CODE).rules.lab.limits).toMatchObject({ metanol: { max: 200, unidad: 'mg/100 ml a.a.' }, cobre: { max: 6 }, acidezVolatil: { max: 1.2 } })
  })
})

describe('archivos de /mocks/uploads', () => {
  it('los handlers sirven de verdad las imágenes, los PDF y los logotipos de los fixtures', async () => {
    const urls = new Set<string>()
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('/mocks/uploads/')) urls.add(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(publicFixtures)
    collect(F.wineries)
    collect(F.terroirs)
    expect([...urls].some((u) => u.includes('/collections/'))).toBe(true)
    expect([...urls].some((u) => u.includes('/logos/'))).toBe(true)
    for (const url of urls) {
      const res = await fetch(`https://app.test${url}`)
      expect(res.status, url).toBe(200)
      const type = res.headers.get('content-type')!
      if (url.endsWith('.pdf')) {
        expect(type).toBe('application/pdf')
        expect((await res.text()).startsWith('%PDF-1.4')).toBe(true)
      } else {
        expect(type).toBe('image/svg+xml; charset=utf-8')
        expect(await res.text()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
      }
    }
    // Una URL firmada de un archivo subido también responde; lo que no es imagen, PDF ni ZIP, 404.
    const attachments = dataOf((await call<Paged<{ url: string; mimeType: string }>>(`/v1/lots/${SINGANI_CASE.lotId}/attachments`, { token: enologa })).json).items
    for (const a of attachments) expect((await fetch(`${API}${a.url}`)).status, a.url).toBe(200)
    expect((await fetch(`${API}/mocks/uploads/otros/datos.bin`)).status).toBe(404)
    expect((await fetch(`${API}/mocks/uploads/exports/bottle-codes/${CINTI}/${uid('no-existe')}.zip`)).status).toBe(404)
  })

  it('uploads: passthrough no los intercepta (la app sirve los suyos)', () => {
    const count = (options: Parameters<typeof createMockHandlers>[0]) => createMockHandlers(options).filter((h) => String(h.info.path).includes('/mocks/uploads/')).length
    expect(count({})).toBe(1)
    expect(count({ uploads: 'passthrough' })).toBe(0)
  })
})
