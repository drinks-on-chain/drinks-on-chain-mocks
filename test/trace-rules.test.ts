import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  BottleUnitSchema,
  BottlingPreviewSchema,
  ErrorEnvelopeSchema,
  LotBalanceSchema,
  LotDossierSchema,
  LotGraphSchema,
  LotSchema,
  LotSummarySchema,
  LotTimelineSchema,
  merkleLeaf,
  merkleRootFromProof,
  PublicBottlePassportSchema,
  TraceDashboardSchema,
  type ApiErrorDetail,
  type Envelope,
  type Lot,
  type Paged,
} from '../src'
import { erpFixtures, publicFixtures, SINGANI_CASE } from '../src/fixtures'
import { advanceMockClock, getErpDb, resetScenario, setScenario } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { sha256Hex } from '../src/shared/crypto'
import { uid } from '../src/shared/uuid'
import { API, call, dataOf } from './helpers'

// Reglas de la trazabilidad confiable (contrato de la Ola 2 §2–§13) tal como las aplican los
// handlers: el recorrido H2 del §18 de principio a fin y sus pruebas de elusión. Cada regla
// incumplida responde su código `TRC_…` con `details` ampliados (`code`, `rule`, `expected`,
// `actual`, `meta`) para que la UI explique qué pasa y cuándo se podrá hacer.

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
const T = (key: string) => uid(`terroir:${key}`)
const as = (key: string) => `mock.access.${key}`
const enologa = as('cvj_enologa')
const operario = as('cvj_operario')
const agronomo = as('cvj_agronomo')
const duena = as('cvj_admin')
const file = (wineryId: string, name: string) => `org/${wineryId}/docs/2026/09/${name}`

interface Failure {
  status: number
  code: string
  message: string
  details: ApiErrorDetail[]
}
/** Respuesta de error: estado, código y detalles. */
function failure(res: { status: number; json: Envelope<unknown> }): Failure {
  const { error } = ErrorEnvelopeSchema.parse(res.json)
  return { status: res.status, code: error.code, message: error.message, details: error.details ?? [] }
}
const post = <T = Record<string, unknown>>(path: string, token: string, body: unknown = {}) => call<T>(path, { token, body })
const get = async <T = Record<string, unknown>>(path: string, token: string) => dataOf((await call<T>(path, { token })).json)
const lotOf = async (id: string, token = enologa): Promise<Lot> => LotSchema.parse(await get(`/v1/lots/${id}`, token))

/** Pesaje con dictamen aprobado en un lote (o sin lote). */
async function approvedHarvest(tokens: { weigh: string; decide: string }, body: Record<string, unknown>): Promise<{ id: string; lotId: string | null }> {
  const harvest = dataOf((await post<{ id: string; lotId: string | null }>('/v1/harvest-batches', tokens.weigh, { intakeDate: '2026-09-25', grossWeightKg: 5150, tareWeightKg: 150, ...body })).json)
  const decided = await post(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, tokens.decide, { decision: 'APPROVED' })
  expect(decided.status).toBe(201)
  return harvest
}

describe('recorrido H2 (contrato §18): «Singani Gran Reserva» de la parcela a la botella', () => {
  it('lote → pesaje → dictamen → tanque → destilación → reposo de 180 días → embotellado de 2.950 botellas → códigos → laboratorio → expediente → pasaporte', async () => {
    // 1. La enóloga crea el lote: instantánea con 1.600 m, Moscatel de Alejandría, 180 días y merma del 5 %.
    const created = await post('/v1/lots', enologa, { name: 'Singani de la casa 2026', harvestYear: 2026, productType: 'SINGANI', estimatedBottles: 3000, plannedFormatCl: 75, targetAbvPercent: 40, plannedTerroirIds: [T('cvj_02')] })
    expect(created.status).toBe(201)
    const lot = LotSchema.parse(dataOf(created.json))
    expect(lot).toMatchObject({ stage: 'ORIGIN', reference: 'CVJ-L2026-007', lotCode: null, productType: 'SINGANI', projectedBottles: 3000, denomination: { status: 'ELIGIBLE' } })
    expect(lot.rules).toMatchObject({ origin: 'LOT_CREATION', singani: { minAltitudeMasl: 1600, requiredVarieties: ['Moscatel de Alejandría'], minRestDays: 180 }, bottling: { maxLossPercent: 5 }, legalExceptions: [] })
    expect(lot.createdBy).toMatchObject({ fullName: 'Lic. Lucía Rojas', role: 'ENOLOGIST' })

    // 2. El operario pesa 18.400 kg netos (no puede crear lotes ni dictaminar); la enóloga analiza; el agrónomo aprueba.
    const weigh = { terroirId: T('cvj_02'), intakeDate: '2026-09-25', grossWeightKg: 18550, tareWeightKg: 150 }
    expect(failure(await post('/v1/harvest-batches', operario, { ...weigh, newLot: { name: 'Lote del operario', harvestYear: 2026 } })).status).toBe(403)
    const harvest = dataOf((await post<{ id: string; netWeightKg: number; terroirSnapshot: unknown; doEvaluation: { status: string } }>('/v1/harvest-batches', operario, { ...weigh, lotId: lot.id })).json)
    expect(harvest).toMatchObject({ netWeightKg: 18400, lotId: lot.id, brixDegrees: null, terroirSnapshot: { parcelName: 'Parcela 2 · Cañón Viejo', altitudeMasl: 2410 }, doEvaluation: { status: 'ELIGIBLE', rulesSource: 'LOT_SNAPSHOT' } })
    expect(failure(await post(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, operario, { decision: 'APPROVED' })).status).toBe(403)
    expect((await post(`/v1/harvest-batches/${harvest.id}/maturity-analyses`, enologa, { brixDegrees: 23.4, ph: 3.4, acidityGl: 5.9, measuredAt: '2026-09-25T11:00:00Z' })).status).toBe(201)
    const decided = await post(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, agronomo, { decision: 'APPROVED', inspectionReportKey: file(CINTI, 'acta.pdf') })
    expect(dataOf(decided.json)).toMatchObject({ phytosanitaryStatus: 'APPROVED', brixDegrees: 23.4, phytoDecisions: [{ decision: 'APPROVED', decidedBy: { role: 'AGRONOMIST' } }] })
    expect((await lotOf(lot.id)).stage).toBe('HARVEST')

    // 3. Tanque de 12.100 L, lectura y fermentación completada con destino singani (D.O. comprobada).
    const tank = dataOf((await post<{ id: string }>('/v1/fermentation-tanks', enologa, { lotId: lot.id, inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-21', capacityLiters: 15000, volumeFilledLiters: 12100, startFermentation: true, startDate: '2026-09-25' })).json)
    expect(tank).toMatchObject({ status: 'FERMENTING', lotId: lot.id, inputs: [{ harvestBatchId: harvest.id, kg: 18400 }] })
    expect((await post(`/v1/fermentation-tanks/${tank.id}/logs`, operario, { temperatureCelsius: 22.1, specificGravity: 1.08, recordedAt: '2026-09-25T11:45:00Z' })).status).toBe(201)
    const completed = dataOf((await post(`/v1/fermentation-tanks/${tank.id}/complete`, enologa, { endDate: '2026-09-25', finalVolumeLiters: 12100, destination: 'SINGANI_DIST' })).json)
    expect(completed).toMatchObject({ status: 'COMPLETED', finalVolumeLiters: 12100, destinationType: 'SINGANI_DIST' })

    // 4. Destilación de 12.100 L cerrada con cabezas 120 L, corazón 1.500 L al 60 % y colas 210 L.
    const distillation = dataOf((await post<{ id: string }>('/v1/production-batches/distillation', enologa, { fermentationTankId: tank.id, equipmentIdentifier: 'Alambique AL-01', processStartDate: '2026-09-25', inputVolumeLiters: 12100 })).json)
    expect(distillation).toMatchObject({ restStatus: 'NOT_REQUIRED', lotId: lot.id, isDoEligible: true, lock: null })
    expect((await lotOf(lot.id)).stage).toBe('DISTILLING')
    const closed = dataOf((await post(`/v1/production-batches/${distillation.id}/close`, enologa, { processEndDate: '2026-09-25', cuts: { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 }, heartAbvPercent: 60 })).json)
    expect(closed).toMatchObject({
      restStatus: 'RESTING',
      mandatoryRestUntil: '2027-03-24T00:00:00Z',
      heartLiters: 1500,
      pureAlcoholLiters: 900,
      availableLiters: 1500,
      lock: { kind: 'REST', unlockDate: '2027-03-24', released: false, daysRemaining: 180, rule: { settingKey: 'trazabilidad.singani.reposoMinimoDias', minimum: 180, unit: 'días' } },
    })
    const resting = await lotOf(lot.id)
    // Proyección (S-19): corazón × grado ÷ grado previsto × (1 − merma máxima) ÷ formato.
    expect(resting).toMatchObject({ stage: 'RESTING', projectedBottles: 2850, estimatedReadyDate: '2027-03-24', estimatedReadyBasis: 'LOCK', nextLock: { daysRemaining: 180 } })

    // 5. Antes del reposo no se embotella; la vista previa lo explica sin escribir nada.
    const bottle = { bottlingDate: '2026-09-25', packagingFormatCl: 75, totalBottlesPackaged: 2950, finalAlcoholAbv: 40, waterDilutionLiters: 750 }
    const early = BottlingPreviewSchema.parse(dataOf((await post(`/v1/lots/${lot.id}/bottling/preview`, enologa, bottle)).json))
    expect(early.valid).toBe(false)
    expect(early.violations).toHaveLength(1)
    expect(early.violations[0]).toMatchObject({
      code: 'TRC_LOCK_NOT_RELEASED',
      field: 'bottlingDate',
      rule: 'trazabilidad.singani.reposoMinimoDias',
      expected: '2027-03-24',
      message: 'Reposo mínimo de 180 días: disponible el 2027-03-24 (faltan 180 días)',
      meta: { sourceId: distillation.id, kind: 'REST', unlockDate: '2027-03-24', daysRemaining: 180 },
    })
    expect(failure(await post(`/v1/lots/${lot.id}/bottling`, enologa, bottle)).code).toBe('TRC_LOCK_NOT_RELEASED')

    // Pasan los 180 días (reloj simulado): la tarea diaria libera el candado y lo anota.
    advanceMockClock(180 * DAY_MS)
    const ready = await lotOf(lot.id)
    expect(ready.nextLock).toBeNull()
    expect(ready.locks).toMatchObject([{ released: true, daysRemaining: 0 }])
    const timeline = LotTimelineSchema.parse(await get(`/v1/lots/${lot.id}/timeline`, operario))
    expect(timeline.events.map((e) => e.seq)).toEqual(timeline.events.map((_, i) => i + 1))
    expect(timeline.events.at(-1)).toMatchObject({ type: 'LOCK_RELEASED', actor: null, visibility: 'PUBLIC', stage: 'RESTING' })

    const preview = BottlingPreviewSchema.parse(dataOf((await post(`/v1/lots/${lot.id}/bottling/preview`, enologa, { ...bottle, bottlingDate: '2027-03-24' })).json))
    expect(preview).toMatchObject({
      valid: true,
      violations: [],
      balance: { availableLiters: 1500, waterDilutionLiters: 750, bottledLiters: 2212.5, leftoverLiters: 0, lossLiters: 37.5, lossPercent: 1.67, maxLossPercent: 5, pureAlcohol: { availableLiters: 900, bottledLiters: 885 }, maxBottles: 3000 },
    })
    expect(getErpDb().bottlings.some((b) => b.lotId === lot.id)).toBe(false)
    const bottledRes = await post(`/v1/lots/${lot.id}/bottling`, enologa, { ...bottle, bottlingDate: '2027-03-24' })
    expect(bottledRes.status).toBe(201)
    const bottling = dataOf(bottledRes.json) as { id: string; lotCode: string; qrBatchUrl: string }
    // Código de lote con la secuencia de la bodega y el año del embotellado.
    expect(bottling).toMatchObject({ lotCode: 'CVJ-2027-SINGANI-001', productType: 'SINGANI', qrBatchUrl: 'http://localhost:3005/b/CVJ-2027-SINGANI-001', bottleCodes: { total: 2950, active: 2950 } })
    expect(failure(await post(`/v1/lots/${lot.id}/bottling`, enologa, bottle)).code).toBe('TRC_LOT_ALREADY_BOTTLED')

    // 6. Un código por botella: lista, CSV y ZIP para la imprenta.
    const codes = dataOf((await call<Paged<unknown>>(`/v1/lots/${lot.id}/bottle-codes?limit=100`, { token: enologa })).json)
    expect(codes.total).toBe(2950)
    const first = BottleUnitSchema.parse(codes.items[0])
    expect(first).toMatchObject({ serial: 1, status: 'ACTIVE', lotCode: 'CVJ-2027-SINGANI-001', exportsCount: 0, voided: null })
    expect(first.codeFormatted).toBe(`${first.code.slice(0, 4)}-${first.code.slice(4)}`)
    expect(first.qrUrl).toBe(`http://localhost:3005/b/${first.code}`)
    const csv = await fetch(`${API}/v1/lots/${lot.id}/bottle-codes/export?format=csv`, { headers: { Authorization: `Bearer ${enologa}` } })
    const lines = (await csv.text()).trimEnd().split('\r\n')
    expect(lines).toHaveLength(2951)
    expect(lines[0]).toBe('serial,code,codeFormatted,qrUrl,lotCode,lotName,productType,bottlingDate')
    expect(lines[1]).toBe(`1,${first.code},${first.codeFormatted},${first.qrUrl},CVJ-2027-SINGANI-001,Singani de la casa 2026,SINGANI,2027-03-24`)
    const zip = dataOf((await post<{ exportId: string; status: string }>(`/v1/lots/${lot.id}/bottle-codes/exports`, enologa, { format: 'ZIP', fromSerial: 1, toSerial: 1000, qr: { imageFormat: 'SVG' } })).json)
    expect(zip.status).toBe('PENDING')
    expect(await get(`/v1/lots/${lot.id}/bottle-codes/exports/${zip.exportId}`, enologa)).toMatchObject({ status: 'PENDING', rows: 1000, downloadUrl: null })
    expect(await get(`/v1/lots/${lot.id}/bottle-codes/exports/${zip.exportId}`, enologa)).toMatchObject({ status: 'READY', downloadUrl: expect.stringContaining('.zip') })

    // Laboratorio conforme (metanol en mg/100 mL de alcohol anhidro, cobre y grado) y cierre del expediente.
    const notReady = failure(await post(`/v1/lots/${lot.id}/dossier/close`, enologa, { confirm: true }))
    expect(notReady).toMatchObject({ status: 422, code: 'TRC_DOSSIER_NOT_READY' })
    expect(notReady.details.map((d) => d.meta?.requirement)).toEqual(['LAB_CONFORMING'])
    const lab = await post(`/v1/lots/${lot.id}/lab-analyses`, enologa, {
      certifiedLaboratoryName: 'Laboratorio ISO 17025',
      accreditedLabCertificationCode: 'LAB-1',
      testPerformedAt: '2027-03-24',
      actualAlcoholAbv: 40.1,
      totalAcidityTartaricGl: 4.7,
      volatileAcidityAceticGl: 0.21,
      methanolMg100mlAa: 46.5,
      copperContentMgL: 0.8,
      laboratoryReportKey: file(CINTI, 'informe.pdf'),
    })
    expect(dataOf(lab.json)).toMatchObject({ conformityStatus: 'CONFORMING', conformsToSenasagStandards: true, current: true, units: { methanolMg100mlAa: 'mg/100 mL de alcohol anhidro' } })
    const dossier = LotDossierSchema.parse(dataOf((await post(`/v1/lots/${lot.id}/dossier/close`, duena, { confirm: true })).json))
    expect(dossier).toMatchObject({ status: 'CLOSED', schema: 'doc-dossier/1', algorithm: 'sha256/jcs-rfc8785', closedBy: { role: 'OWNER' }, bottleCodes: { count: 2950, algorithm: 'sha256-merkle/serial-code-salt' }, anchor: { status: 'PENDING', txHash: null, memoHashHex: expect.stringMatching(/^[0-9a-f]{64}$/) } })
    const canonical = await (await fetch(`${API}/v1/lots/${lot.id}/dossier/canonical`, { headers: { Authorization: `Bearer ${operario}` } })).text()
    expect(sha256Hex(canonical)).toBe(dossier.hash)
    // Los códigos no van en claro en el expediente: solo su raíz Merkle.
    expect(canonical).not.toContain(first.code)
    const certified = await lotOf(lot.id)
    expect(certified).toMatchObject({ stage: 'CERTIFIED', dossierStatus: 'CLOSED', labStatus: 'CONFORMING', bottles: 2950, lotCode: 'CVJ-2027-SINGANI-001' })
    // Tras el cierre el lote no admite escrituras.
    expect(failure(await post(`/v1/lots/${lot.id}/corrections`, enologa, { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'AMEND', changes: { notes: 'x' }, reason: 'Corrección tras el cierre' }))).toMatchObject({ status: 409, code: 'TRC_DOSSIER_CLOSED' })
    expect(failure(await call(`/v1/lots/${lot.id}`, { token: enologa, method: 'PATCH', body: { name: 'Otro nombre' } }))).toMatchObject({ status: 409, code: 'TRC_LOT_TERMINAL' })

    // 7. El visor abre /b/{código}: botella n.º 1 de 2.950, con su prueba frente a la raíz del expediente.
    const passport = PublicBottlePassportSchema.parse(dataOf((await call(`/v1/public/passports/${first.codeFormatted.toLowerCase()}`)).json))
    expect(passport.bottle).toMatchObject({ serial: 1, lotTotal: 2950, status: 'ACTIVE', code: first.code })
    const proof = passport.bottle.merkleProof!
    expect(merkleRootFromProof(merkleLeaf({ serial: 1, code: first.code, salt: proof.salt }), proof.path)).toBe(dossier.bottleCodes!.merkleRoot)
    expect(passport.lot).toMatchObject({ lotCode: 'CVJ-2027-SINGANI-001', stage: 'CERTIFIED', dossier: { status: 'CLOSED', hash: dossier.hash }, lab: { status: 'CONFORMING' }, aging: { status: 'NOT_APPLICABLE' } })
  })
})

describe('pruebas de elusión (contrato §18)', () => {
  it('tanque con uva pendiente o en cuarentena → 422 TRC_PHYTO_NOT_APPROVED con un detalle por pesaje', async () => {
    const token = as('altos_enologa')
    const pending = F.harvestBatches.find((h) => h.wineryId === ALTOS && h.phytosanitaryStatus === 'PENDING_INSPECTION')!
    const quarantine = F.harvestBatches.find((h) => h.wineryId === ALTOS && h.phytosanitaryStatus === 'QUARANTINE')!
    for (const h of [pending, quarantine]) {
      const res = failure(await post('/v1/fermentation-tanks', token, { inputs: [{ harvestBatchId: h.id }], tankCode: 'TK-30', volumeFilledLiters: 500, startDate: '2026-09-25' }))
      expect(res).toMatchObject({ status: 422, code: 'TRC_PHYTO_NOT_APPROVED' })
      expect(res.details).toMatchObject([{ code: 'TRC_PHYTO_NOT_APPROVED', expected: ['APPROVED'], actual: h.phytosanitaryStatus, meta: { harvestBatchId: h.id, harvestBatchCode: h.harvestBatchCode, status: h.phytosanitaryStatus } }])
    }
    // Nada quedó a medias: ni tanque ni lote nuevo.
    expect(getErpDb().tanks).toHaveLength(F.fermentationTanks.length)
    expect(getErpDb().lots).toHaveLength(F.lots.length)
  })

  it('D.O. calculada: una parcela no apta no entra en un lote singani (TRC_DO_TERROIR_NOT_ELIGIBLE), su tanque no se completa con destino singani (TRC_DO_NOT_ELIGIBLE) y `isDoEligible` ya no se admite', async () => {
    // Cepa no admitida (Vischoqueña) en un lote singani.
    const lot = dataOf((await post<{ id: string }>('/v1/lots', enologa, { name: 'Singani de prueba', harvestYear: 2026, productType: 'SINGANI' })).json)
    const bad = failure(await post('/v1/harvest-batches', operario, { lotId: lot.id, terroirId: T('cvj_03'), intakeDate: '2026-09-25', grossWeightKg: 3150, tareWeightKg: 150 }))
    expect(bad).toMatchObject({ status: 422, code: 'TRC_DO_TERROIR_NOT_ELIGIBLE' })
    expect(bad.details).toMatchObject([{ field: 'terroirId', rule: 'trazabilidad.singani.variedadesExigidas', expected: ['Moscatel de Alejandría'], actual: 'Vischoqueña', meta: { terroirId: T('cvj_03'), check: 'VARIETY' } }])
    // También al crear el lote con esa parcela prevista.
    expect(failure(await post('/v1/lots', enologa, { name: 'Singani de Las Carreras', harvestYear: 2026, productType: 'SINGANI', plannedTerroirIds: [T('cvj_03')] })).code).toBe('TRC_DO_TERROIR_NOT_ELIGIBLE')

    // Lote sin tipo decidido con esa uva: el destino singani y la destilación comprueban la D.O. de todos sus pesajes.
    const harvest = await approvedHarvest({ weigh: operario, decide: agronomo }, { terroirId: T('cvj_03'), newLot: undefined })
    const tank = dataOf((await post<{ id: string; lotId: string }>('/v1/fermentation-tanks', enologa, { inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-31', volumeFilledLiters: 3000, startFermentation: true, startDate: '2026-09-25' })).json)
    const predeclared = failure(await post(`/v1/fermentation-tanks/${tank.id}/complete`, enologa, { endDate: '2026-09-25', finalVolumeLiters: 2900, destination: 'SINGANI_DIST' }))
    expect(predeclared).toMatchObject({ status: 422, code: 'TRC_DO_NOT_ELIGIBLE' })
    expect(predeclared.details[0]).toMatchObject({ rule: 'trazabilidad.singani.variedadesExigidas', actual: 'Vischoqueña', meta: { check: 'VARIETY', harvestBatches: [{ id: harvest.id }] } })
    // Declarar la D.O. ya no es posible (campo retirado en el cierre H2) y un tanque sin completar no se destila.
    const distillation = { fermentationTankId: tank.id, equipmentIdentifier: 'AL-02', processStartDate: '2026-09-25', inputVolumeLiters: 1000 }
    const declared = failure(await post('/v1/production-batches/distillation', enologa, { ...distillation, isDoEligible: true }))
    expect(declared).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'isDoEligible', message: 'property isDoEligible should not exist' }] })
    expect(failure(await post('/v1/production-batches/distillation', enologa, distillation))).toMatchObject({ status: 409, code: 'TRC_TANK_NOT_COMPLETED', details: [{ meta: { status: 'FERMENTING' } }] })
    // Los intentos no fijaron el tipo del lote ni dejaron la destilación.
    expect(await lotOf(tank.lotId)).toMatchObject({ productType: null, stage: 'FERMENTING' })
    expect(getErpDb().productionBatches).toHaveLength(F.productionBatches.length)
    // Como vino sí se puede; después, el destino singani ya no es coherente.
    expect((await post(`/v1/fermentation-tanks/${tank.id}/complete`, enologa, { endDate: '2026-09-25', finalVolumeLiters: 2900, destination: 'WINE_AGING' })).status).toBe(200)
    const mismatch = failure(await post('/v1/production-batches/distillation', enologa, distillation))
    expect(mismatch).toMatchObject({ code: 'TRC_DESTINATION_MISMATCH' })
    // El destino del tanque (lo que hay) frente al que pide la operación.
    expect(mismatch.details[0]).toMatchObject({ field: 'fermentationTankId', expected: 'SINGANI_DIST', actual: 'WINE_AGING' })
  })

  it('El Portillo (1.540 m): apto por excepción con el ajuste de Altos; sin él, no; y cambiar la regla a mitad de proceso no afecta al lote ya creado', async () => {
    const token = as('altos_enologa')
    const portillo = T('altos_03')
    // Altos tiene la altitud mínima en 1.500 m por excepción legal (A-31): el lote lo lleva en su instantánea.
    const before = dataOf((await post<Lot>('/v1/lots', token, { name: 'Singani de Altos (con excepción)', harvestYear: 2026, productType: 'SINGANI' })).json)
    expect(before.rules).toMatchObject({ singani: { minAltitudeMasl: 1500 }, legalExceptions: expect.arrayContaining(['trazabilidad.singani.altitudMinimaMsnm']) })
    expect(before.rules.sources['trazabilidad.singani.altitudMinimaMsnm']).toBe('WINERY')
    expect(await get(`/v1/terroirs/${portillo}`, token)).toMatchObject({ isDoEligible: true, doEvaluation: { status: 'ELIGIBLE_BY_EXCEPTION', rulesSource: 'EFFECTIVE_SETTINGS' } })

    // El back office retira el ajuste: los lotes nuevos vuelven a los 1.600 m del estándar.
    const reset = await post('/v1/platform/settings/trazabilidad.singani.altitudMinimaMsnm/overrides/reset', as('bo_admin'), { wineryIds: [ALTOS], reason: 'Fin de la excepción' })
    expect(reset.status).toBe(200)
    expect(await get(`/v1/terroirs/${portillo}`, token)).toMatchObject({ isDoEligible: false, doEvaluation: { status: 'NOT_ELIGIBLE' } })
    const after = dataOf((await post<Lot>('/v1/lots', token, { name: 'Singani de Altos (sin excepción)', harvestYear: 2026, productType: 'SINGANI' })).json)
    expect(after.rules).toMatchObject({ singani: { minAltitudeMasl: 1600 }, legalExceptions: [] })
    const weigh = { terroirId: portillo, intakeDate: '2026-09-25', grossWeightKg: 4100, tareWeightKg: 100 }
    const rejected = failure(await post('/v1/harvest-batches', token, { ...weigh, lotId: after.id }))
    expect(rejected).toMatchObject({ status: 422, code: 'TRC_DO_TERROIR_NOT_ELIGIBLE' })
    expect(rejected.details[0]).toMatchObject({ rule: 'trazabilidad.singani.altitudMinimaMsnm', expected: 1600, actual: 1540 })

    // El lote creado antes conserva su instantánea: el cambio no le afecta.
    const kept = await post<{ doEvaluation: { status: string } }>('/v1/harvest-batches', token, { ...weigh, lotId: before.id })
    expect(kept.status).toBe(201)
    expect(dataOf(kept.json).doEvaluation.status).toBe('ELIGIBLE_BY_EXCEPTION')
    expect((await lotOf(before.id, token)).denomination).toMatchObject({ status: 'ELIGIBLE_BY_EXCEPTION', rulesSource: 'LOT_SNAPSHOT' })
  })

  it('embotellado antes del reposo (escenario lote-en-reposo): vista previa y alta responden TRC_LOCK_NOT_RELEASED con los días que faltan', async () => {
    setScenario('lote-en-reposo')
    const lot = await lotOf(SINGANI_CASE.lotId)
    expect(lot).toMatchObject({ name: 'Singani Gran Reserva 2026', stage: 'RESTING', nextLock: { kind: 'REST', unlockDate: '2026-10-05', daysRemaining: 10, released: false } })
    const body = { bottlingDate: '2026-09-25', packagingFormatCl: 75, totalBottlesPackaged: 2950, finalAlcoholAbv: 40, waterDilutionLiters: 750 }
    const preview = BottlingPreviewSchema.parse(dataOf((await post(`/v1/lots/${lot.id}/bottling/preview`, enologa, body)).json))
    expect(preview).toMatchObject({ valid: false, violations: [{ code: 'TRC_LOCK_NOT_RELEASED', message: 'Reposo mínimo de 180 días: disponible el 2026-10-05 (faltan 10 días)', meta: { daysRemaining: 10 } }] })
    expect(failure(await post(`/v1/lots/${lot.id}/bottling`, enologa, body))).toMatchObject({ status: 422, code: 'TRC_LOCK_NOT_RELEASED' })
    // Diez días después (reloj simulado) ya se puede.
    advanceMockClock(10 * DAY_MS)
    expect((await post(`/v1/lots/${lot.id}/bottling`, enologa, { ...body, bottlingDate: '2026-10-05' })).status).toBe(201)
  })

  it('balance del embotellado: más botellas que litros, agua para inflar, merma sin declarar y agua en un vino', async () => {
    setScenario('lote-listo')
    const url = `/v1/lots/${SINGANI_CASE.lotId}/bottling`
    const base = { bottlingDate: '2026-09-25', packagingFormatCl: 75, finalAlcoholAbv: 40 }
    const tooMany = failure(await post(url, enologa, { ...base, totalBottlesPackaged: 3001, waterDilutionLiters: 750 }))
    expect(tooMany).toMatchObject({ status: 422, code: 'TRC_BOTTLING_EXCEEDS_VOLUME' })
    expect(tooMany.details[0]).toMatchObject({ field: 'totalBottlesPackaged', expected: 3000, actual: 3001, meta: { maxBottles: 3000, availableLiters: 1500 } })
    // Más agua para sacar más botellas: el alcohol puro embotellado superaría el del corazón.
    const watered = failure(await post(url, enologa, { ...base, totalBottlesPackaged: 3900, waterDilutionLiters: 1500 }))
    expect(watered).toMatchObject({ status: 422, code: 'TRC_ALCOHOL_BALANCE_EXCEEDED' })
    expect(watered.details[0]).toMatchObject({ field: 'finalAlcoholAbv', expected: 900, actual: 1170, meta: { tolerancePercent: 0.5 } })
    // Merma por encima de la tolerada (5 %): hay que declarar el remanente.
    const loss = failure(await post(url, enologa, { ...base, totalBottlesPackaged: 2500, waterDilutionLiters: 750 }))
    expect(loss).toMatchObject({ status: 422, code: 'TRC_BOTTLING_LOSS_ABOVE_TOLERANCE' })
    expect(loss.details[0]).toMatchObject({ rule: 'trazabilidad.embotellado.mermaMaximaPorcentaje', expected: 5, actual: 16.67 })
    const withLeftover = await post(url, enologa, { ...base, totalBottlesPackaged: 2500, waterDilutionLiters: 750, leftover: { liters: 340, disposition: 'RETAINED', notes: 'Queda en el depósito D-2' } })
    expect(withLeftover.status).toBe(201)
    expect(dataOf(withLeftover.json)).toMatchObject({ leftover: { liters: 340, disposition: 'RETAINED' }, balance: { lossLiters: 35, lossPercent: 1.56 } })

    // Vino: no se admite agua.
    const wine = F.lots.find((l) => l.wineryId === ALTOS && l.stage === 'AGING')!
    const preview = BottlingPreviewSchema.parse(dataOf((await post(`/v1/lots/${wine.id}/bottling/preview`, as('altos_enologa'), { ...base, finalAlcoholAbv: 13.5, totalBottlesPackaged: 4000, waterDilutionLiters: 100 })).json))
    expect(preview.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['TRC_LOCK_NOT_RELEASED', 'TRC_DILUTION_NOT_ALLOWED']))
    expect(preview.balance.pureAlcohol).toBeNull()
  })

  it('crianza bajo el mínimo de la instantánea → 422 TRC_AGING_BELOW_MINIMUM (Altos fija 6 meses; el estándar y Cinti Viejo, 0)', async () => {
    const token = as('altos_enologa')
    const harvest = await approvedHarvest({ weigh: token, decide: as('altos_agronomo') }, { terroirId: T('altos_04'), newLot: { name: 'Syrah de prueba 2026', harvestYear: 2026, productType: 'WINE' } })
    expect((await lotOf(harvest.lotId!, token)).rules.wine.minAgingMonths).toBe(6)
    const tank = dataOf((await post<{ id: string }>('/v1/fermentation-tanks', token, { inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-42', volumeFilledLiters: 3600, startFermentation: true, startDate: '2026-09-25' })).json)
    await post(`/v1/fermentation-tanks/${tank.id}/complete`, token, { endDate: '2026-09-25', finalVolumeLiters: 3500, destination: 'WINE_AGING' })
    const aging = { fermentationTankId: tank.id, containerType: 'Barrica', volumeLiters: 3400 }
    const short = failure(await post('/v1/wine-aging', token, { ...aging, plannedMonths: 3 }))
    expect(short).toMatchObject({ status: 422, code: 'TRC_AGING_BELOW_MINIMUM' })
    expect(short.details[0]).toMatchObject({ field: 'plannedMonths', rule: 'trazabilidad.vino.crianzaMinimaMeses', expected: 6, actual: 3 })
    const ok = await post('/v1/wine-aging', token, { ...aging, plannedMonths: 6 })
    expect(dataOf(ok.json)).toMatchObject({ agingStatus: 'AGING', unlockDate: '2027-03-25', lock: { rule: { minimum: 6, applied: 6 } } })
    // El tanque completado pasa a TRANSFERRED y la merma de trasiego queda en el balance.
    const balance = LotBalanceSchema.parse(await get(`/v1/lots/${harvest.lotId}/balance`, token))
    expect(balance).toMatchObject({ harvest: { netKg: 5000, approvedKg: 5000 }, must: { filledLiters: 3600, litersPerKg: 0.72 }, fermentation: { finalLiters: 3500, lossLiters: 100, lossPercent: 2.78 }, aging: { liters: 3400, lossLiters: 100 }, bottling: null })
    // El mínimo es el ajuste de Altos (fixtures del back office); el estándar de la plataforma sigue en 0.
    expect(F.lots.filter((l) => l.wineryId === ALTOS).every((l) => l.rules.wine.minAgingMonths === 6 && l.rules.sources['trazabilidad.vino.crianzaMinimaMeses'] === 'WINERY')).toBe(true)
    expect(F.lots.filter((l) => l.wineryId === CINTI).every((l) => l.rules.wine.minAgingMonths === 0)).toBe(true)
  })

  it('expediente: cierre con laboratorio sin registrar o no conforme → 422 TRC_DOSSIER_NOT_READY; corrección tras el cierre → 409 TRC_DOSSIER_CLOSED', async () => {
    const withoutLab = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'BOTTLED' && l.labStatus === 'NOT_RECORDED')!
    const res = failure(await post(`/v1/lots/${withoutLab.id}/dossier/close`, enologa, { confirm: true }))
    expect(res).toMatchObject({ status: 422, code: 'TRC_DOSSIER_NOT_READY' })
    expect(res.details).toMatchObject([{ code: 'TRC_DOSSIER_NOT_READY', message: 'Falta el análisis de laboratorio del lote', meta: { requirement: 'LAB_CONFORMING', labStatus: 'NOT_RECORDED' } }])
    expect(failure(await post(`/v1/lots/${withoutLab.id}/dossier/close`, enologa, {})).code).toBe('VALIDATION_ERROR')

    setScenario('laboratorio-no-conforme')
    const preview = await get<{ ready: boolean; requirements: { key: string; met: boolean; message: string }[]; hashPreview: string | null }>(`/v1/lots/${SINGANI_CASE.lotId}/dossier/preview`, operario)
    expect(preview.ready).toBe(false)
    expect(preview.requirements.filter((r) => !r.met)).toEqual([{ key: 'LAB_CONFORMING', met: false, message: 'El análisis de laboratorio vigente no es conforme' }])
    expect(preview.hashPreview).toMatch(/^[0-9a-f]{64}$/)
    expect(await lotOf(SINGANI_CASE.lotId)).toMatchObject({ stage: 'BOTTLED', labStatus: 'NON_CONFORMING', dossierStatus: 'OPEN' })
    // Un reanálisis conforme sustituye al anterior y desbloquea el cierre.
    const reanalysis = await post(`/v1/lots/${SINGANI_CASE.lotId}/lab-analyses`, enologa, { certifiedLaboratoryName: 'Laboratorio ISO 17025', accreditedLabCertificationCode: 'LAB-2', testPerformedAt: '2026-09-25', actualAlcoholAbv: 40, totalAcidityTartaricGl: 4.6, volatileAcidityAceticGl: 0.2, methanolMg100mlAa: 52, copperContentMgL: 0.6, laboratoryReportKey: file(CINTI, 'reanalisis.pdf') })
    expect(reanalysis.status).toBe(201)
    const labs = dataOf((await call<Paged<{ current: boolean; conformityStatus: string; supersededAt: string | null }>>(`/v1/lots/${SINGANI_CASE.lotId}/lab-analyses`, { token: operario })).json)
    expect(labs.items.map((l) => [l.current, l.conformityStatus, l.supersededAt !== null])).toEqual([[true, 'CONFORMING', false], [false, 'NON_CONFORMING', true]])
    expect((await post(`/v1/lots/${SINGANI_CASE.lotId}/dossier/close`, enologa, { confirm: true })).status).toBe(200)

    resetScenario()
    const harvest = F.harvestBatches.find((h) => h.lotId === SINGANI_CASE.lotId)!
    const closed = failure(await post(`/v1/lots/${SINGANI_CASE.lotId}/corrections`, enologa, { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'AMEND', changes: { notes: 'Otra nota' }, reason: 'Corrección tras el cierre del expediente' }))
    expect(closed).toMatchObject({ status: 409, code: 'TRC_DOSSIER_CLOSED' })
    expect(closed.details[0]!.meta).toEqual({ closedAt: '2026-09-24T15:00:00Z', hash: F.lotDossiers[0]!.hash })
    expect(failure(await post(`/v1/lots/${SINGANI_CASE.lotId}/dossier/close`, enologa, { confirm: true })).code).toBe('TRC_DOSSIER_CLOSED')
  })

  it('grafo (SE-07): la bodega dueña y la plataforma lo ven; otra bodega o un consumidor → 404; la plataforma no escribe (TRC_PLATFORM_READ_ONLY)', async () => {
    const url = `/v1/lots/${SINGANI_CASE.lotId}/graph`
    const graph = LotGraphSchema.parse(await get(url, operario))
    expect(graph.nodes.map((n) => n.type)).toEqual(['TERROIR', 'HARVEST_BATCH', 'TANK', 'DISTILLATION', 'BOTTLING', 'LAB_ANALYSIS'])
    expect(graph.nodes.find((n) => n.type === 'HARVEST_BATCH')).toMatchObject({ quantity: { value: 18400, unit: 'kg' }, corrected: true, actor: { role: 'OPERATOR' } })
    expect(graph.nodes.find((n) => n.type === 'BOTTLING')).toMatchObject({ quantity: { value: 2950, unit: 'bottles' }, status: 'CERTIFIED' })
    expect(graph.edges).toHaveLength(5)
    expect((await call(url, { token: as('soporte') })).status).toBe(200)
    for (const other of [as('altos_enologa'), as('maria')]) {
      expect(failure(await call(url, { token: other }))).toMatchObject({ status: 404, code: 'TRC_LOT_NOT_FOUND' })
    }
    // Lo de otra bodega es 404, nunca 403.
    expect(failure(await call(`/v1/lots/${SINGANI_CASE.lotId}`, { token: as('altos_enologa') }))).toMatchObject({ status: 404, code: 'TRC_LOT_NOT_FOUND' })
    // El grafo legado por embotellado se retiró en el cierre H2: tampoco existe para la plataforma.
    const bottling = F.bottling.find((b) => b.lotId === SINGANI_CASE.lotId)!
    const legacy = await call(`/v1/traceability/dag/${bottling.id}`, { token: as('operaciones') })
    expect(legacy.status).toBe(404)
    expect(legacy.headers.get('deprecation')).toBeNull()
    // La plataforma lee con ?wineryId= y no escribe.
    expect(dataOf((await call<Paged<unknown>>(`/v1/lots?wineryId=${CINTI}`, { token: as('operaciones') })).json).total).toBe(F.lots.filter((l) => l.wineryId === CINTI).length)
    for (const [path, body] of [['/v1/lots', { name: 'Lote de la plataforma', harvestYear: 2026 }], [`/v1/lots/${SINGANI_CASE.lotId}/dossier/close`, { confirm: true }]] as const) {
      expect(failure(await post(`${path}?wineryId=${CINTI}`, as('operaciones'), body))).toMatchObject({ status: 403, code: 'TRC_PLATFORM_READ_ONLY' })
    }
  })
})

describe('reglas del lote, la vendimia y los tanques', () => {
  it('lote: lista con filtros, estimación con motivo e historial, y descarte (TRC_LOT_TERMINAL después)', async () => {
    const all = dataOf((await call<Paged<unknown>>('/v1/lots?limit=100', { token: operario })).json)
    const summaries = all.items.map((i) => LotSummarySchema.parse(i))
    expect(summaries).toHaveLength(F.lots.filter((l) => l.wineryId === CINTI).length)
    // Orden por última actualización, la más reciente primero.
    expect(summaries.map((s) => s.updatedAt)).toEqual([...summaries.map((s) => s.updatedAt)].sort().reverse())
    expect(summaries[0]).toMatchObject({ name: 'Singani Gran Reserva 2026', stage: 'ANCHORED' })
    const filtered = async (query: string) => dataOf((await call<Paged<{ name: string }>>(`/v1/lots?${query}`, { token: operario })).json).items.map((l) => l.name)
    expect(await filtered('stage=RESTING,DISTILLING')).toEqual(['Singani El Molino 2026', 'Moscatel de Alejandría 2026'])
    expect(await filtered('q=gran reserva')).toEqual(['Singani Gran Reserva 2026'])
    expect(await filtered('q=CVJ-2026-WINE')).toEqual(['CVJ-2026-WINE-003'])
    expect(await filtered('productType=WINE')).toEqual(['CVJ-2026-WINE-003'])
    expect(await filtered('lockDueWithinDays=30')).toEqual(['Moscatel de Alejandría 2026'])
    expect(await filtered('hasComplianceIssues=true')).toEqual([])
    expect(failure(await call('/v1/lots?stage=NOPE', { token: operario })).details[0]!.field).toBe('stage')

    const origin = F.lots.find((l) => l.stage === 'ORIGIN')!
    const noReason = failure(await call(`/v1/lots/${origin.id}`, { token: enologa, method: 'PATCH', body: { estimatedBottles: 2000 } }))
    expect(noReason).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'reason' }] })
    const updated = LotSchema.parse(dataOf((await call(`/v1/lots/${origin.id}`, { token: enologa, method: 'PATCH', body: { estimatedBottles: 2000, reason: 'Se suma la parcela vecina' } })).json))
    expect(updated.estimatedBottlesHistory.map((h) => [h.value, h.reason])).toEqual([[1800, null], [2000, 'Se suma la parcela vecina']])
    expect(failure(await post('/v1/lots', agronomo, { name: 'Lote del agrónomo', harvestYear: 2026 })).status).toBe(403)
    expect(failure(await post('/v1/lots', enologa, { name: 'Sidra de prueba', harvestYear: 2026, productType: 'CIDER' }))).toMatchObject({ status: 422, code: 'TRC_PRODUCT_NOT_SUPPORTED' })
    expect(failure(await post('/v1/lots', enologa, { name: 'Lote del futuro', harvestYear: 2027 })).details[0]!.field).toBe('harvestYear')

    const discarded = LotSchema.parse(dataOf((await post(`/v1/lots/${origin.id}/discard`, duena, { reason: 'Se cancela la edición' })).json))
    expect(discarded).toMatchObject({ stage: 'DISCARDED', discarded: { reason: 'Se cancela la edición', by: { role: 'OWNER' } } })
    expect(failure(await post(`/v1/lots/${origin.id}/discard`, duena, { reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'TRC_LOT_TERMINAL' })
    expect(failure(await post('/v1/harvest-batches', operario, { lotId: origin.id, terroirId: T('cvj_04'), intakeDate: '2026-09-25', grossWeightKg: 900, tareWeightKg: 100 })).code).toBe('TRC_LOT_TERMINAL')
    // Un lote certificado tampoco se descarta; y descartar uno embotellado anula sus códigos.
    expect(failure(await post(`/v1/lots/${SINGANI_CASE.lotId}/discard`, duena, { reason: 'No procede' })).code).toBe('TRC_LOT_TERMINAL')
    const bottled = F.lots.find((l) => l.wineryId === CINTI && l.lotCode === 'CVJ-2026-SINGANI-001')!
    expect(dataOf((await post(`/v1/lots/${bottled.id}/discard`, duena, { reason: 'Retirada del mercado' })).json)).toMatchObject({ stage: 'DISCARDED', bottles: 0 })
    const code = publicFixtures.bottleCodes.find((b) => b.lotId === bottled.id)!.codes[0]!.code
    // El pasaporte sigue respondiendo, con el lote descartado y el código anulado (veracidad, S-23).
    expect(dataOf((await call(`/v1/public/bottles/${code}`)).json)).toMatchObject({ bottle: { status: 'VOIDED' }, lot: { stage: 'DISCARDED' } })
  })

  it('pesaje: fechas, añada, etapa del lote y dictamen con motivo; todos los pesajes rechazados → lote REJECTED', async () => {
    const weigh = { terroirId: T('cvj_04'), intakeDate: '2026-09-25', grossWeightKg: 2100, tareWeightKg: 100 }
    const future = failure(await post('/v1/harvest-batches', operario, { ...weigh, intakeDate: '2026-09-26' }))
    expect(future).toMatchObject({ status: 422, code: 'TRC_DATE_IN_FUTURE', details: [{ field: 'intakeDate', expected: '2026-09-25', actual: '2026-09-26' }] })
    const lot = dataOf((await post<{ id: string }>('/v1/lots', enologa, { name: 'Singani de pruebas 2026', harvestYear: 2026, productType: 'SINGANI' })).json)
    expect(failure(await post('/v1/harvest-batches', operario, { ...weigh, lotId: lot.id, harvestYear: 2025 }))).toMatchObject({ code: 'TRC_HARVEST_YEAR_MISMATCH', details: [{ field: 'harvestYear', expected: 2026, actual: 2025 }] })
    expect(failure(await post('/v1/harvest-batches', operario, { ...weigh, lotId: SINGANI_CASE.lotId })).code).toBe('TRC_LOT_TERMINAL')
    const restingLot = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'RESTING')!
    expect(failure(await post('/v1/harvest-batches', operario, { ...weigh, lotId: restingLot.id }))).toMatchObject({ status: 409, code: 'TRC_INVALID_STAGE', details: [{ meta: { stage: 'RESTING', allowed: ['ORIGIN', 'HARVEST', 'FERMENTING'] } }] })
    expect(failure(await post('/v1/harvest-batches', operario, { ...weigh, lotId: uid('nope') })).code).toBe('TRC_LOT_NOT_FOUND')

    // Registro tardío (S-9): fecha pasada admitida y marcada.
    const late = dataOf((await post<{ id: string; lateEntry: boolean }>('/v1/harvest-batches', operario, { ...weigh, lotId: lot.id, intakeDate: '2026-09-10' })).json)
    expect(late.lateEntry).toBe(true)
    const decide = (body: unknown) => post(`/v1/harvest-batches/${late.id}/phyto-decisions`, agronomo, body)
    expect(failure(await decide({ decision: 'QUARANTINE' }))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'notes' }] })
    expect(failure(await decide({ decision: 'APPROVED', decidedAt: '2026-09-01' })).code).toBe('TRC_DATE_BEFORE_PREVIOUS_STAGE')
    expect(failure(await decide({ decision: 'APPROVED', inspectionReportKey: file(ALTOS, 'de-otra-bodega.pdf') }))).toMatchObject({ status: 422, code: 'TRC_FILE_NOT_FOUND', details: [{ field: 'inspectionReportKey' }] })
    // Cuarentena → rechazo (la cuarentena no es final; el rechazo sí).
    expect((await decide({ decision: 'QUARANTINE', notes: 'Posible oídio' })).status).toBe(201)
    const rejected = await decide({ decision: 'REJECTED', notes: 'Oídio confirmado' })
    expect(dataOf(rejected.json)).toMatchObject({ phytosanitaryStatus: 'REJECTED', phytoDecisions: [{ decision: 'QUARANTINE' }, { decision: 'REJECTED', notes: 'Oídio confirmado' }] })
    expect(failure(await decide({ decision: 'APPROVED' }))).toMatchObject({ status: 409, code: 'TRC_PHYTO_DECISION_FINAL' })
    const after = await lotOf(lot.id)
    expect(after).toMatchObject({ stage: 'REJECTED', phyto: { rejected: 1, approved: 0 } })
    const timeline = LotTimelineSchema.parse(await get(`/v1/lots/${lot.id}/timeline`, operario))
    expect(timeline.events.map((e) => e.type)).toEqual(['LOT_CREATED', 'HARVEST_WEIGHED', 'PHYTO_DECIDED', 'PHYTO_DECIDED', 'LOT_REJECTED'])
    expect(timeline.events[1]).toMatchObject({ lateEntry: true, summary: 'Pesaje de 2.000 kg desde Parcela 4 · El Molino', actor: { role: 'OPERATOR' } })
  })

  it('tanques: un solo lote por tanque, kilos disponibles, capacidad, código físico ocupado y transiciones por acciones', async () => {
    const lotA = await approvedHarvest({ weigh: enologa, decide: agronomo }, { terroirId: T('cvj_01'), newLot: { name: 'Lote A 2026', harvestYear: 2026 } })
    const lotB = await approvedHarvest({ weigh: enologa, decide: agronomo }, { terroirId: T('cvj_04'), newLot: { name: 'Lote B 2026', harvestYear: 2026 } })
    const tankBody = { tankCode: 'TK-40', capacityLiters: 5000, volumeFilledLiters: 3500, startDate: '2026-09-25' }
    const mixed = failure(await post('/v1/fermentation-tanks', enologa, { ...tankBody, inputs: [{ harvestBatchId: lotA.id }, { harvestBatchId: lotB.id }] }))
    expect(mixed).toMatchObject({ status: 422, code: 'TRC_MIXED_LOTS' })
    expect((mixed.details[0]!.meta!.lotIds as string[]).sort()).toEqual([lotA.lotId, lotB.lotId].sort())
    expect(failure(await post('/v1/fermentation-tanks', enologa, { ...tankBody, inputs: [{ harvestBatchId: lotA.id, kg: 6000 }] }))).toMatchObject({ code: 'TRC_VOLUME_EXCEEDS_AVAILABLE', details: [{ field: 'inputs.0.kg', expected: 5000, actual: 6000, meta: { unit: 'kg' } }] })
    expect(failure(await post('/v1/fermentation-tanks', enologa, { ...tankBody, volumeFilledLiters: 5200, inputs: [{ harvestBatchId: lotA.id }] }))).toMatchObject({ code: 'TRC_TANK_CAPACITY_EXCEEDED', details: [{ field: 'volumeFilledLiters', meta: { capacityLiters: 5000 } }] })
    expect(failure(await post('/v1/fermentation-tanks', enologa, { ...tankBody, startDate: '2026-09-20', inputs: [{ harvestBatchId: lotA.id }] })).code).toBe('TRC_DATE_BEFORE_PREVIOUS_STAGE')
    // TK-03 está ocupado (TRANSFERRED, sin limpiar): no se reutiliza hasta limpiarlo (S-7).
    const busy = failure(await post('/v1/fermentation-tanks', enologa, { ...tankBody, tankCode: 'TK-03', inputs: [{ harvestBatchId: lotA.id }] }))
    expect(busy).toMatchObject({ status: 409, code: 'TRC_TANK_CODE_IN_USE' })
    const occupied = F.fermentationTanks.find((t) => t.wineryId === CINTI && t.tankCode === 'TK-03')!
    expect(dataOf((await post(`/v1/fermentation-tanks/${occupied.id}/clean`, enologa)).json)).toMatchObject({ status: 'CLEANED' })
    // Parte de la uva a un tanque y el resto a otro.
    const first = dataOf((await post<{ id: string }>('/v1/fermentation-tanks', enologa, { ...tankBody, tankCode: 'TK-03', inputs: [{ harvestBatchId: lotA.id, kg: 3000 }] })).json)
    expect(first).toMatchObject({ status: 'FILLING', inputs: [{ kg: 3000 }] })
    expect((await get<{ availableKg: number }>(`/v1/harvest-batches/${lotA.id}`, enologa)).availableKg).toBe(2000)
    // Con la uva ya en un tanque el dictamen no cambia.
    expect(failure(await post(`/v1/harvest-batches/${lotA.id}/phyto-decisions`, agronomo, { decision: 'REJECTED', notes: 'Tarde' })).code).toBe('TRC_PHYTO_DECISION_FINAL')

    // Transiciones: FILLING → FERMENTING → COMPLETED → (TRANSFERRED) → CLEANED.
    const invalid = failure(await post(`/v1/fermentation-tanks/${first.id}/complete`, enologa, { endDate: '2026-09-25', finalVolumeLiters: 3400, destination: 'WINE_AGING' }))
    expect(invalid).toMatchObject({ status: 409, code: 'TRC_TANK_INVALID_TRANSITION', details: [{ meta: { from: 'FILLING', to: 'COMPLETED' } }] })
    expect(dataOf((await post(`/v1/fermentation-tanks/${first.id}/start`, enologa)).json)).toMatchObject({ status: 'FERMENTING' })
    expect(failure(await post(`/v1/fermentation-tanks/${first.id}/start`, enologa)).code).toBe('TRC_TANK_INVALID_TRANSITION')
    expect(failure(await post(`/v1/fermentation-tanks/${first.id}/complete`, enologa, { endDate: '2026-09-25', finalVolumeLiters: 3600, destination: 'WINE_AGING' }))).toMatchObject({ code: 'TRC_VOLUME_EXCEEDS_AVAILABLE', details: [{ field: 'finalVolumeLiters' }] })
    expect(dataOf((await post(`/v1/fermentation-tanks/${first.id}/complete`, enologa, { endDate: '2026-09-25', finalVolumeLiters: 3400, destination: 'WINE_AGING' })).json)).toMatchObject({ status: 'COMPLETED' })
    expect(failure(await post(`/v1/fermentation-tanks/${first.id}/clean`, enologa))).toMatchObject({ code: 'TRC_TANK_INVALID_TRANSITION', details: [{ meta: { from: 'COMPLETED', to: 'CLEANED' } }] })
    // La primera bifurcación fija el tipo del lote; un segundo tanque del lote no puede ir a otro destino.
    expect(await lotOf(lotA.lotId!)).toMatchObject({ productType: 'WINE', stage: 'FERMENTING' })
    expect(failure(await post('/v1/fermentation-tanks', enologa, { ...tankBody, tankCode: 'TK-41', destinationType: 'SINGANI_DIST', inputs: [{ harvestBatchId: lotA.id }] }))).toMatchObject({ code: 'TRC_DESTINATION_MISMATCH', details: [{ expected: 'WINE_AGING', actual: 'SINGANI_DIST' }] })
    // Lecturas y tratamientos solo en tanques activos.
    const cleaned = F.fermentationTanks.find((t) => t.wineryId === CINTI && t.status === 'CLEANED')!
    expect(failure(await post(`/v1/fermentation-tanks/${cleaned.id}/logs`, operario, { temperatureCelsius: 20, recordedAt: '2026-09-25T10:00:00Z' }))).toMatchObject({ status: 409, code: 'TRC_TANK_NOT_ACTIVE', details: [{ meta: { status: 'CLEANED' } }] })
    // Las lecturas del día se agrupan en un evento de la línea de tiempo.
    for (const temperatureCelsius of [21.5, 23.2]) await post(`/v1/fermentation-tanks/${first.id}/logs`, operario, { temperatureCelsius, recordedAt: '2026-09-25T11:00:00Z' })
    const readings = LotTimelineSchema.parse(await get(`/v1/lots/${lotA.lotId}/timeline`, operario)).events.filter((e) => e.type === 'FERMENTATION_READINGS')
    expect(readings).toMatchObject([{ summary: '2 lecturas en TK-03: 23,2 °C', data: { readings: 2, minTemperatureC: 21.5, maxTemperatureC: 23.2 }, visibility: 'INTERNAL' }])
  })

  it('parcela usada: los campos normativos no cambian por PATCH (TRC_TERROIR_IN_USE) sino por corrección, que reevalúa la D.O. de sus lotes abiertos', async () => {
    const used = T('cvj_01')
    const patch = (body: unknown) => call(`/v1/terroirs/${used}`, { token: agronomo, method: 'PATCH', body })
    expect(failure(await patch({ altitudeMasl: 1500 }))).toMatchObject({ status: 409, code: 'TRC_TERROIR_IN_USE', details: [{ field: 'altitudeMasl', meta: { fields: ['altitudeMasl'] } }] })
    // El resto de campos sí; `isDoEligible` se calcula y ya no se admite en la entrada.
    expect(failure(await patch({ soilType: 'Franco', isDoEligible: false }))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'isDoEligible' }] })
    expect(dataOf((await patch({ soilType: 'Franco' })).json)).toMatchObject({ soilType: 'Franco', isDoEligible: true })
    expect(failure(await post(`/v1/terroirs/${used}/corrections`, agronomo, { changes: { parcelName: 'Otro nombre' }, reason: 'No es un campo normativo' })).code).toBe('TRC_CORRECTION_FIELD_NOT_CORRECTABLE')
    const correction = await post(`/v1/terroirs/${used}/corrections`, agronomo, { changes: { altitudeMasl: 1580 }, reason: 'Altitud corregida con el levantamiento topográfico' })
    expect(dataOf(correction.json)).toMatchObject({ lotId: null, target: { type: 'TERROIR', id: used }, kind: 'AMEND', changes: [{ field: 'altitudeMasl', before: 2350, after: 1580 }], createdBy: { role: 'AGRONOMIST' } })
    // El lote en reposo que usa esa parcela deja de cumplir la D.O.: incidencia que bloquea el embotellado.
    const lot = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'RESTING')!
    const reviewed = await lotOf(lot.id)
    expect(reviewed).toMatchObject({ complianceIssuesOpen: 1, denomination: { status: 'NOT_ELIGIBLE' } })
    expect(reviewed.complianceIssues).toMatchObject([{ code: 'TRC_DO_NOT_ELIGIBLE', source: 'RULES_REEVALUATION', resolvedAt: null, details: [{ rule: 'trazabilidad.singani.altitudMinimaMsnm', expected: 1600, actual: 1580 }] }])
    const preview = BottlingPreviewSchema.parse(dataOf((await post(`/v1/lots/${lot.id}/bottling/preview`, enologa, { bottlingDate: '2026-09-25', packagingFormatCl: 75, totalBottlesPackaged: 100, finalAlcoholAbv: 40 })).json))
    expect(preview.violations.map((v) => v.code)).toContain('TRC_COMPLIANCE_ISSUES_OPEN')
    // Corregir de nuevo la resuelve.
    await post(`/v1/terroirs/${used}/corrections`, agronomo, { changes: { altitudeMasl: 2350 }, reason: 'Se deshace la corrección anterior' })
    expect(await lotOf(lot.id)).toMatchObject({ complianceIssuesOpen: 0, denomination: { status: 'ELIGIBLE' } })
  })
})

describe('códigos de botella, correcciones, adjuntos, panel y reportes', () => {
  it('códigos: anular con y sin sustituto, rangos y lote sin embotellar', async () => {
    const lot = F.lots.find((l) => l.wineryId === CINTI && l.lotCode === 'CVJ-2026-SINGANI-001')!
    const sample = publicFixtures.bottleCodes.find((b) => b.lotId === lot.id)!
    const code = sample.codes[1]!.code
    // Normalización al leer: minúsculas, guion, O → 0, I/L → 1.
    const replaced = BottleUnitSchema.parse(dataOf((await post(`/v1/bottle-codes/${code.slice(0, 4).toLowerCase()}-${code.slice(4)}/void`, enologa, { reason: 'Etiqueta rota', replace: true })).json))
    expect(replaced).toMatchObject({ code, serial: 2, status: 'VOIDED', voided: { reason: 'Etiqueta rota', by: { role: 'ENOLOGIST' } } })
    expect(replaced.voided!.replacedBy).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(failure(await post(`/v1/bottle-codes/${code}/void`, enologa, { reason: 'Otra vez' }))).toMatchObject({ status: 409, code: 'TRC_BOTTLE_CODE_ALREADY_VOIDED' })
    const range = dataOf((await call<Paged<unknown>>(`/v1/lots/${lot.id}/bottle-codes?fromSerial=1&toSerial=3`, { token: enologa })).json)
    expect(range.items.map((u) => BottleUnitSchema.parse(u)).map((u) => [u.serial, u.status, u.replaces])).toEqual([[1, 'ACTIVE', null], [2, 'VOIDED', null], [2, 'ACTIVE', code], [3, 'ACTIVE', null]])
    // Sin sustituto: una botella menos con código activo.
    await post(`/v1/bottle-codes/${sample.codes[0]!.code}/void`, enologa, { reason: 'Botella rota en el almacén' })
    expect(await lotOf(lot.id)).toMatchObject({ bottles: 4079 })
    expect(dataOf((await call<Paged<unknown>>(`/v1/lots/${lot.id}/bottle-codes?status=VOIDED`, { token: enologa })).json).total).toBe(2)
    expect((await get<{ bottleCodes: unknown }>(`/v1/bottling/${F.bottling.find((b) => b.lotId === lot.id)!.id}`, enologa)).bottleCodes).toEqual({ total: 4081, active: 4079, voided: 2, firstSerial: 1, lastSerial: 4080 })

    expect(failure(await call(`/v1/lots/${lot.id}/bottle-codes?fromSerial=10&toSerial=5`, { token: enologa }))).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'fromSerial' }] })
    expect(failure(await call(`/v1/lots/${lot.id}/bottle-codes?toSerial=5000`, { token: enologa })).details[0]!.field).toBe('toSerial')
    expect(failure(await post('/v1/bottle-codes/ZZZZZZZZ/void', enologa, { reason: 'No existe' }))).toMatchObject({ status: 404, code: 'TRC_BOTTLE_CODE_NOT_FOUND' })
    // Código de otra bodega → 404; operario → 403; lote sin embotellar → 409.
    expect(failure(await post(`/v1/bottle-codes/${sample.codes[2]!.code}/void`, as('altos_enologa'), { reason: 'De otra bodega' })).code).toBe('TRC_BOTTLE_CODE_NOT_FOUND')
    expect((await call(`/v1/lots/${lot.id}/bottle-codes`, { token: operario })).status).toBe(403)
    const resting = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'RESTING')!
    expect(failure(await call(`/v1/lots/${resting.id}/bottle-codes`, { token: enologa }))).toMatchObject({ status: 409, code: 'TRC_LOT_NOT_BOTTLED', details: [{ meta: { stage: 'RESTING' } }] })
    // Con el expediente cerrado un código se anula pero no se sustituye (S-14).
    const caseCode = publicFixtures.bottleCodes.find((b) => b.lotId === SINGANI_CASE.lotId)!.codes[0]!.code
    expect(failure(await post(`/v1/bottle-codes/${caseCode}/void`, enologa, { reason: 'Etiqueta dañada', replace: true }))).toMatchObject({ status: 409, code: 'TRC_DOSSIER_CLOSED' })
    expect((await post(`/v1/bottle-codes/${caseCode}/void`, enologa, { reason: 'Botella rota' })).status).toBe(200)
  })

  it('correcciones compensatorias: valor anterior y nuevo con motivo, lista cerrada de campos, rol de quien crea el registro y reglas que no se rompen', async () => {
    const lot = F.lots.find((l) => l.wineryId === CINTI && l.stage === 'RESTING')!
    const harvest = F.harvestBatches.find((h) => h.lotId === lot.id)!
    const tank = F.fermentationTanks.find((t) => t.lotId === lot.id)!
    const correct = (token: string, body: unknown) => post(`/v1/lots/${lot.id}/corrections`, token, body)
    const ok = await correct(operario, { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'AMEND', changes: { grossWeightKg: 18560 }, reason: 'Báscula mal tarada ese día' })
    // El neto es un valor derivado: queda también en la corrección.
    expect(dataOf(ok.json)).toMatchObject({
      lotId: lot.id,
      kind: 'AMEND',
      changes: [
        { field: 'grossWeightKg', before: 18550, after: 18560 },
        { field: 'netWeightKg', before: 18400, after: 18410 },
      ],
      createdBy: { role: 'OPERATOR' },
    })
    expect(await get(`/v1/harvest-batches/${harvest.id}`, operario)).toMatchObject({ grossWeightKg: 18560, netWeightKg: 18410 })
    // No corregibles: lote de pertenencia, tipo, códigos…
    const notAllowed = failure(await correct(enologa, { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'AMEND', changes: { lotId: uid('otro'), harvestYear: 2025 }, reason: 'Mover el pesaje a otro lote' }))
    expect(notAllowed).toMatchObject({ status: 422, code: 'TRC_CORRECTION_FIELD_NOT_CORRECTABLE' })
    expect(notAllowed.details.map((d) => d.meta?.field)).toEqual(['lotId', 'harvestYear'])
    // S-17: el operario no corrige lo que no puede crear (un tanque).
    expect(failure(await correct(operario, { target: { type: 'FERMENTATION_TANK', id: tank.id }, kind: 'AMEND', changes: { volumeFilledLiters: 12000 }, reason: 'Volumen mal anotado' })).status).toBe(403)
    // La corrección no puede dejar el lote incumpliendo una regla: del tanque salieron 12.100 L.
    const breaks = failure(await correct(enologa, { target: { type: 'FERMENTATION_TANK', id: tank.id }, kind: 'AMEND', changes: { volumeFilledLiters: 11000 }, reason: 'Volumen mal anotado en el llenado' }))
    expect(breaks).toMatchObject({ status: 422, code: 'TRC_CORRECTION_BREAKS_RULES' })
    expect(breaks.details[0]).toMatchObject({ code: 'TRC_VOLUME_EXCEEDS_AVAILABLE', expected: 11000, actual: 12100 })
    expect((await get<{ volumeFilledLiters: number }>(`/v1/fermentation-tanks/${tank.id}`, enologa)).volumeFilledLiters).toBe(12100)
    expect(failure(await correct(enologa, { target: { type: 'BOTTLING', id: uid('no-existe') }, kind: 'AMEND', changes: { bottleType: 'x' }, reason: 'Registro que no existe' })).status).toBe(404)
    expect(failure(await correct(enologa, { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'VOID', reason: 'Un pesaje no se anula' })).code).toBe('TRC_CORRECTION_FIELD_NOT_CORRECTABLE')
    expect(failure(await correct(enologa, { target: { type: 'HARVEST_BATCH', id: harvest.id }, kind: 'AMEND', changes: { notes: 'x' }, reason: 'corto' })).details[0]!.field).toBe('reason')
    // VOID de un análisis de madurez: el pesaje vuelve a quedar sin análisis.
    const analysis = F.maturityAnalyses.find((m) => m.harvestBatchId === harvest.id)!
    expect((await correct(enologa, { target: { type: 'MATURITY_ANALYSIS', id: analysis.id }, kind: 'VOID', reason: 'Muestra mal etiquetada en el laboratorio' })).status).toBe(201)
    // El análisis anulado deja de contar (el pesaje vuelve a quedar sin Brix) y se devuelve marcado.
    expect(await get(`/v1/harvest-batches/${harvest.id}`, operario)).toMatchObject({
      brixDegrees: null,
      correctedFields: ['grossWeightKg', 'netWeightKg'],
      voided: false,
      maturityAnalyses: [{ id: analysis.id, voided: true, correctedFields: [] }],
    })
    const list = dataOf((await call<Paged<{ kind: string }>>(`/v1/lots/${lot.id}/corrections`, { token: operario })).json)
    expect(list.items.map((c) => c.kind)).toEqual(['VOID', 'AMEND'])
    const timeline = LotTimelineSchema.parse(await get(`/v1/lots/${lot.id}/timeline`, operario))
    expect(timeline.events.filter((e) => e.type === 'CORRECTION')).toHaveLength(2)
    expect(timeline.events.find((e) => e.type === 'HARVEST_WEIGHED')!.corrected).toBe(true)
  })

  it('adjuntos del lote: clave propia, etiqueta pública por defecto, informes del dictamen y del laboratorio, y cambio de visibilidad', async () => {
    const url = `/v1/lots/${SINGANI_CASE.lotId}/attachments`
    const items = dataOf((await call<Paged<{ kind: string; visibility: string; url: string; sha256: string }>>(url, { token: enologa })).json).items
    expect(items.map((a) => [a.kind, a.visibility])).toEqual([['PHYTO_REPORT', 'PRIVATE'], ['LABEL', 'PUBLIC'], ['LAB_REPORT', 'PRIVATE'], ['DO_CERTIFICATE', 'PRIVATE']])
    expect(items[0]!.url).toMatch(/^\/mocks\/uploads\/org\/.+signature=mock$/)
    // Agronomía y operación solo ven lo que adjuntaron ellos (§14): el agrónomo, su acta; el operario, nada.
    const mine = async (token: string) => dataOf((await call<Paged<{ kind: string }>>(url, { token })).json).items.map((a) => a.kind)
    expect(await mine(agronomo)).toEqual(['PHYTO_REPORT'])
    expect(await mine(operario)).toEqual([])
    // Con el expediente cerrado no se adjunta nada más.
    const closed = failure(await post(url, operario, { key: file(CINTI, 'foto.jpg'), kind: 'PHOTO', title: 'Foto' }))
    expect(closed).toMatchObject({ status: 409, code: 'TRC_DOSSIER_CLOSED' })
    expect(closed.details[0]!.meta).toEqual({ closedAt: '2026-09-24T15:00:00Z', hash: F.lotDossiers[0]!.hash })
    const open = F.lots.find((l) => l.stage === 'DISTILLING')!
    const openUrl = `/v1/lots/${open.id}/attachments`
    expect(failure(await post(openUrl, operario, { key: file(ALTOS, 'ajena.jpg'), kind: 'PHOTO', title: 'De otra bodega' }))).toMatchObject({ status: 422, code: 'TRC_FILE_NOT_FOUND', details: [{ field: 'key' }] })
    const photo = dataOf((await post<{ id: string; visibility: string; mimeType: string }>(openUrl, operario, { key: file(CINTI, 'alambique.jpg'), kind: 'PHOTO', title: 'Alambique' })).json)
    expect(photo).toMatchObject({ visibility: 'PRIVATE', mimeType: 'image/jpeg', createdBy: { role: 'OPERATOR' } })
    expect(dataOf((await post(openUrl, enologa, { key: file(CINTI, 'etiqueta.png'), kind: 'LABEL', title: 'Etiqueta' })).json)).toMatchObject({ visibility: 'PUBLIC' })
    // Publicar un archivo es cosa de dirección y enología.
    expect((await post(openUrl, operario, { key: file(CINTI, 'otra.jpg'), kind: 'PHOTO', title: 'Otra', visibility: 'PUBLIC' })).status).toBe(403)
    expect((await post(`${openUrl}/${photo.id}/visibility`, operario, { visibility: 'PUBLIC' })).status).toBe(403)
    const events = async () => LotTimelineSchema.parse(await get(`/v1/lots/${open.id}/timeline`, enologa)).events.filter((e) => e.type === 'FILE_ATTACHED')
    const before = (await events()).length
    expect(dataOf((await post(`${openUrl}/${photo.id}/visibility`, enologa, { visibility: 'PUBLIC' })).json)).toMatchObject({ visibility: 'PUBLIC' })
    // El cambio de visibilidad queda como un evento `FILE_ATTACHED`; repetir la vigente no registra nada.
    expect((await events()).at(-1)).toMatchObject({ data: { action: 'VISIBILITY_CHANGED', attachmentId: photo.id, previous: 'PRIVATE', visibility: 'PUBLIC' }, visibility: 'INTERNAL' })
    await post(`${openUrl}/${photo.id}/visibility`, enologa, { visibility: 'PUBLIC' })
    expect(await events()).toHaveLength(before + 1)
    expect((await post(`${openUrl}/${uid('nope')}/visibility`, enologa, { visibility: 'PUBLIC' })).status).toBe(404)
  })

  it('panel de la bodega y reporte de producción (JSON y CSV)', async () => {
    const cinti = TraceDashboardSchema.parse(await get('/v1/traceability/dashboard', enologa))
    expect(cinti.lotsByStage).toMatchObject({ ORIGIN: 2, HARVEST: 1, DISTILLING: 1, RESTING: 1, BOTTLED: 3, CERTIFIED: 0, ANCHORED: 1, FERMENTING: 0 })
    expect(cinti.bottledWithoutLab.map((l) => l.lotCode)).toEqual(['CVJ-2026-WINE-003'])
    expect(cinti.readyToClose.map((l) => l.lotCode).sort()).toEqual(['CVJ-2026-SINGANI-001', 'CVJ-2026-SINGANI-002'])
    expect(cinti.pendingPhyto.map((p) => [p.status, p.lotId === null])).toEqual([['PENDING_INSPECTION', false], ['PENDING_INSPECTION', true]])
    expect(cinti).toMatchObject({ complianceIssuesOpen: 0, unassignedHarvestBatches: 1, locksDueSoon: [] })
    // El día del pesaje es una fecha de calendario, no un instante (como el backend).
    for (const p of cinti.pendingPhyto) expect(p.intakeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(cinti.pendingPhyto[0]!.intakeDate).toBe(F.harvestBatches.find((h) => h.id === cinti.pendingPhyto[0]!.harvestBatchId)!.intakeDate.slice(0, 10))
    // El candado del lote en reposo vence en 18 días: entra en el aviso cuando faltan 14 o menos.
    advanceMockClock(5 * DAY_MS)
    expect(TraceDashboardSchema.parse(await get('/v1/traceability/dashboard', enologa)).locksDueSoon).toMatchObject([{ name: 'Moscatel de Alejandría 2026', lock: { daysRemaining: 13, unlockDate: '2026-10-13' } }])
    resetErpDb()

    const altos = TraceDashboardSchema.parse(await get('/v1/traceability/dashboard', as('altos_enologa')))
    // Última lectura a 33,4 °C (> 32 °C) y tanques en fermentación sin lecturas desde hace más de 48 h (S-18).
    expect(altos.fermentationAlerts.map((a) => [a.tankCode, a.kind, a.value]).sort()).toEqual([['TK-04', 'NO_READING', expect.any(Number)], ['TK-10', 'NO_READING', expect.any(Number)], ['TK-15', 'HIGH_TEMPERATURE', 33.4]])
    expect(altos.pendingPhyto.map((p) => p.status).sort()).toEqual(['PENDING_INSPECTION', 'QUARANTINE'])
    expect((await call('/v1/traceability/dashboard', { token: as('altos_operario') })).status).toBe(403)

    const report = await get<{ rows: Record<string, unknown>[]; totals: Record<string, Record<string, number>> }>('/v1/traceability/reports/production?productType=SINGANI', duena)
    const row = report.rows.find((r) => r.name === 'Singani Gran Reserva 2026')!
    expect(row).toMatchObject({ lotCode: 'CVJ-2026-SINGANI-004', stage: 'ANCHORED', netKg: 18400, mustLiters: 12100, baseWineLiters: 12100, heartLiters: 1500, bottledLiters: 2212.5, bottles: 2950, formatCl: 75, labStatus: 'CONFORMING', lossPercentByStage: { fermentation: 0, transfer: null, distillation: 87.6, bottling: 1.67 }, bottlesPerTonne: 160.3 })
    expect(report.totals.SINGANI).toMatchObject({ lots: report.rows.length, bottles: 4080 + 2140 + 2950 })
    expect(report.totals.WINE!.lots).toBe(0)
    const csv = await fetch(`${API}/v1/traceability/reports/production?format=csv&stage=ANCHORED`, { headers: { Authorization: `Bearer ${duena}` } })
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    // El nombre lleva el día (America/La_Paz) en que se pide.
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="reporte-produccion-2026-09-25.csv"')
    const lines = (await csv.text()).trimEnd().split('\r\n')
    expect(lines[0]).toBe('lotId,reference,lotCode,name,productType,harvestYear,stage,netKg,mustLiters,baseWineLiters,heartLiters,bottledLiters,bottles,formatCl,lossPercentFermentation,lossPercentTransfer,lossPercentDistillation,lossPercentBottling,litersPerKg,bottlesPerTonne,bottlingDate,labStatus')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(',CVJ-2026-SINGANI-004,Singani Gran Reserva 2026,SINGANI,2026,ANCHORED,18400,')
    expect(failure(await call('/v1/traceability/reports/production?from=ayer', { token: duena })).details[0]!.field).toBe('from')
    expect((await call('/v1/traceability/reports/production', { token: operario })).status).toBe(403)
  })
})

describe('escenarios de datos de /__mocks', () => {
  it('lote-listo, lote-en-reposo, laboratorio-no-conforme y lote-con-incidencia dejan el lote de demostración en su etapa; volver a normal restaura los fixtures', async () => {
    const state = async () => {
      const lot = await lotOf(SINGANI_CASE.lotId)
      return { stage: lot.stage, lab: lot.labStatus, bottles: lot.bottles, lock: lot.nextLock?.daysRemaining ?? null, reference: lot.reference }
    }
    expect(await state()).toEqual({ stage: 'ANCHORED', lab: 'CONFORMING', bottles: 2950, lock: null, reference: 'CVJ-L2026-005' })
    setScenario('lote-listo')
    expect(await state()).toEqual({ stage: 'RESTING', lab: 'NOT_RECORDED', bottles: null, lock: null, reference: 'CVJ-L2026-005' })
    expect((await get<{ restStatus: string }>(`/v1/production-batches/${(await lotOf(SINGANI_CASE.lotId)).links.productionBatchIds[0]}`, enologa)).restStatus).toBe('READY')
    setScenario('lote-en-reposo')
    expect(await state()).toEqual({ stage: 'RESTING', lab: 'NOT_RECORDED', bottles: null, lock: 10, reference: 'CVJ-L2026-005' })
    setScenario('laboratorio-no-conforme')
    expect(await state()).toEqual({ stage: 'BOTTLED', lab: 'NON_CONFORMING', bottles: 2950, lock: null, reference: 'CVJ-L2026-005' })
    expect((await lotOf(SINGANI_CASE.lotId)).lotCode).toBe('CVJ-2026-SINGANI-004')

    setScenario('lote-con-incidencia')
    expect(await state()).toMatchObject({ stage: 'ANCHORED' })
    const withIssue = dataOf((await call<Paged<Lot>>('/v1/lots?hasComplianceIssues=true', { token: operario })).json)
    expect(withIssue.items.map((l) => l.lotCode)).toEqual(['CVJ-2026-SINGANI-002'])
    const lot = await lotOf(withIssue.items[0]!.id)
    expect(lot.complianceIssues).toMatchObject([{ code: 'TRC_BOTTLING_EXCEEDS_VOLUME', source: 'MIGRATION', resolvedAt: null, details: [{ expected: 2133, actual: 2140 }] }])
    // La incidencia bloquea el cierre del expediente hasta corregirla (o descartar el lote).
    const close = failure(await post(`/v1/lots/${lot.id}/dossier/close`, enologa, { confirm: true }))
    expect(close.details.map((d) => d.meta?.requirement)).toEqual(['NO_OPEN_COMPLIANCE_ISSUES'])
    expect(TraceDashboardSchema.parse(await get('/v1/traceability/dashboard', enologa)).complianceIssuesOpen).toBe(1)

    // Lo creado en la sesión se descarta al cambiar de escenario de datos; la identidad no.
    await post('/v1/lots', enologa, { name: 'Lote efímero 2026', harvestYear: 2026 })
    resetScenario()
    expect(await state()).toEqual({ stage: 'ANCHORED', lab: 'CONFORMING', bottles: 2950, lock: null, reference: 'CVJ-L2026-005' })
    expect(getErpDb().lots).toHaveLength(F.lots.length)
  })
})
