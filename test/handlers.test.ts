import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  BottlingBatchResponseSchema,
  BottlingPreviewSchema,
  ErrorEnvelopeSchema,
  FermentationTankDetailSchema,
  HealthStatusSchema,
  HarvestBatchResponseSchema,
  LotSchema,
  pagedSchema,
  successEnvelopeSchema,
  TerroirResponseSchema,
  TraceDashboardSchema,
  unwrapList,
  UploadResponseSchema,
  MeResponseSchema,
  MeUserSchema,
  SessionResponseSchema,
  WineAgingResponseSchema,
  type Paged,
  type SessionResponse,
  type TerroirResponse,
} from '../src'
import { erpFixtures, publicFixtures } from '../src/fixtures'
import { resetScenario, setScenario } from '../src/handlers'
import { getErpDb, resetErpDb, setupMockServer } from '../src/node'
import { sha256, toHex } from '../src/shared/crypto'
import { API, call, dataOf, login, loginSession } from './helpers'

const server = setupMockServer({ baseUrl: API })

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
  resetScenario()
})
afterAll(() => server.close())

const ALTOS = erpFixtures.wineries.find((w) => w.commercialName === 'Bodega Altos de Calamuchita')!
const CINTI = erpFixtures.wineries.find((w) => w.commercialName === 'Destilería Cinti Viejo')!

describe('autenticación', () => {
  it('login con usuario de demo devuelve el fixture de auth-login (salvo los tokens de la sesión)', async () => {
    const { status, json } = await call('/v1/auth/login', { body: { email: 'enologa@altos.test', password: 'demo1234' } })
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, statusCode: 200, path: '/v1/auth/login' })
    const data = dataOf(json) as SessionResponse
    expect({ ...data, tokens: undefined }).toStrictEqual({ ...erpFixtures.authLogin.altos_enologa!, tokens: undefined })
    expect(data.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 })
  })

  it('las respuestas de login de todos los usuarios coinciden con auth-login.json', async () => {
    for (const [key, fixture] of Object.entries(erpFixtures.authLogin)) {
      const email = erpFixtures.users.find((u) => u._mock.key === key)!.email
      // El personal de plataforma pasa antes el segundo factor (contrato de la Ola 1 §1).
      const data = SessionResponseSchema.parse(await loginSession(email))
      expect({ ...data, tokens: undefined }).toStrictEqual({ ...fixture, tokens: undefined })
    }
  })

  it('contraseña incorrecta → 401 AUTH_INVALID_CREDENTIALS con envoltorio', async () => {
    const { status, json } = await call('/v1/auth/login', { body: { email: 'enologa@altos.test', password: 'x' } })
    expect(status).toBe(401)
    const err = ErrorEnvelopeSchema.parse(json)
    expect(err.error.code).toBe('AUTH_INVALID_CREDENTIALS')
  })

  it('cuerpo inválido → 422 VALIDATION_ERROR con details por campo', async () => {
    const { status, json } = await call('/v1/auth/login', { body: { email: 'no-es-correo' } })
    expect(status).toBe(422)
    const err = ErrorEnvelopeSchema.parse(json)
    expect(err.error.code).toBe('VALIDATION_ERROR')
    expect(err.error.details!.map((d) => d.field)).toEqual(['email', 'password'])
  })

  it('JSON mal formado → 400 BAD_REQUEST', async () => {
    const res = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
  })

  it('ruta protegida sin token o con token inválido → 401', async () => {
    expect((await call('/v1/users/me')).status).toBe(401)
    expect((await call('/v1/users/me', { token: 'mock.access.nadie' })).status).toBe(401)
  })

  it('users/me devuelve { user, memberships, activeOrganizationId } sin _mock', async () => {
    const token = await login('admin@altos.test')
    const me = MeResponseSchema.strict().parse(dataOf((await call('/v1/users/me', { token })).json))
    expect(MeUserSchema.strict().parse(me.user).email).toBe('admin@altos.test')
    expect(me.user).not.toHaveProperty('_mock')
    expect(me.activeOrganizationId).toBe(ALTOS.id)
    expect(me.memberships.map((m) => m.role)).toEqual(['OWNER'])
  })

  it('refresh acepta el refresco estático de los mocks en la cookie y rechaza tokens desconocidos', async () => {
    const ok = await call('/v1/auth/refresh', { method: 'POST', headers: { Cookie: 'doc_rt=mock.refresh.altos_admin' } })
    const session = SessionResponseSchema.parse(dataOf(ok.json))
    expect(session.user.email).toBe('admin@altos.test')
    // El refresco va solo en la cookie (H1), con la forma del backend: `<sid>.<generación>.<secreto>`.
    expect(session.tokens).not.toHaveProperty('refreshToken')
    expect(/doc_rt=([^;]*)/.exec(ok.headers.get('set-cookie') ?? '')?.[1]).toMatch(/^[0-9a-f-]{36}\.0\.[A-Za-z0-9_-]{43}$/)
    // Sin sesiones (la cookie que guardó MSW ya no corresponde a ninguna) un refresco desconocido → 401.
    resetErpDb()
    const unknown = await call('/v1/auth/refresh', { method: 'POST', headers: { Cookie: 'doc_rt=otro' } })
    expect(unknown.status).toBe(401)
    expect(ErrorEnvelopeSchema.parse(unknown.json).error.code).toBe('AUTH_REFRESH_INVALID')
  })

  it('signup crea un consumidor que luego puede iniciar sesión', async () => {
    const res = await call('/v1/auth/signup', { body: { email: 'nuevo@tribu.test', password: 'secreta1', fullName: 'Nuevo' } })
    expect(res.status).toBe(201)
    expect(SessionResponseSchema.parse(dataOf(res.json))).toMatchObject({ user: { audience: 'CONSUMER' }, memberships: [], activeOrganizationId: null })
    expect((await call('/v1/users/me', { token: await login('nuevo@tribu.test', 'secreta1') })).status).toBe(200)
    expect((await call('/v1/auth/signup', { body: { email: 'nuevo@tribu.test', password: 'x', fullName: 'X' } })).status).toBe(409)
  })

  it('signup ya no registra personal (H1): userRole → 422', async () => {
    const res = await call('/v1/auth/signup', { body: { email: 'duena@nueva.test', password: 'secreta1', fullName: 'Dueña', userRole: 'WINERY_ADMIN' } })
    expect(res.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(res.json).error.details).toEqual([expect.objectContaining({ field: 'userRole' })])
  })
})

describe('multi-tenant, filtros y paginación', () => {
  it('lista de terroirs filtrada por la bodega del token', async () => {
    const token = await login('agronomo@altos.test')
    const { status, json } = await call('/v1/terroirs', { token })
    expect(status).toBe(200)
    const page = pagedSchema(TerroirResponseSchema).parse(dataOf(json))
    expect(page.total).toBe(5)
    expect(page.items.every((t) => t.wineryId === ALTOS.id)).toBe(true)
  })

  it('PLATFORM_ADMIN ve todas las bodegas', async () => {
    const token = await login('gestor@drinksonchain.test')
    const page = dataOf((await call('/v1/terroirs', { token })).json) as Paged<TerroirResponse>
    expect(page.total).toBe(erpFixtures.terroirs.length)
  })

  it('filtros varietyName e isDoEligible (aptitud D.O. calculada con los valores vigentes de la bodega)', async () => {
    const token = await login('agronomo@altos.test')
    const moscatel = unwrapList(dataOf((await call('/v1/terroirs?varietyName=moscatel', { token })).json) as Paged<TerroirResponse>)
    expect(moscatel.items.map((t) => t.parcelName)).toEqual(['Cuartel 2 · Los Sauces', 'Cuartel 3 · El Portillo'])
    // Altos tiene la altitud mínima en 1.500 m por excepción legal (A-31): El Portillo (1.540 m) es apto por excepción.
    expect(moscatel.items.map((t) => t.doEvaluation!.status)).toEqual(['ELIGIBLE', 'ELIGIBLE_BY_EXCEPTION'])
    const noDo = unwrapList(dataOf((await call('/v1/terroirs?isDoEligible=false', { token })).json) as Paged<TerroirResponse>)
    // Las cepas que no son Moscatel de Alejandría no son aptas para la D.O. Singani.
    expect(noDo.items.map((t) => t.varietyName).sort()).toEqual(['Cabernet Sauvignon', 'Syrah', 'Tannat'])
  })

  it('limit / offset y total', async () => {
    const token = await login('enologa@cintiviejo.test')
    const first = dataOf((await call('/v1/harvest-batches?limit=2&offset=0', { token })).json) as Paged<unknown>
    const second = dataOf((await call('/v1/harvest-batches?limit=2&offset=2', { token })).json) as Paged<unknown>
    expect(first).toMatchObject({ total: erpFixtures.harvestBatches.filter((h) => h.wineryId === CINTI.id).length, limit: 2, offset: 0 })
    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(2)
    expect(second.items[0]).not.toEqual(first.items[0])
    const bad = await call('/v1/harvest-batches?limit=abc', { token })
    expect(bad.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(bad.json).error.details).toEqual([{ field: 'limit', message: 'limit debe ser un número entero' }])
  })

  it('limit por defecto 20, máximo 100 (más → 422)', async () => {
    const token = await login('gestor@drinksonchain.test')
    const page = dataOf((await call('/v1/harvest-batches', { token })).json) as Paged<unknown>
    expect(page).toMatchObject({ limit: 20, offset: 0 })
    expect((await call('/v1/harvest-batches?limit=100', { token })).status).toBe(200)
    const tooMany = await call('/v1/harvest-batches?limit=101', { token })
    expect(tooMany.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(tooMany.json).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'limit', message: 'limit no puede ser mayor que 100' }],
    })
  })

  it('filtros de tanques (status, destinationType) y de destilación (restStatus)', async () => {
    const token = await login('enologa@altos.test')
    const fermenting = dataOf((await call('/v1/fermentation-tanks?status=FERMENTING', { token })).json) as Paged<{ tankCode: string }>
    expect(fermenting.items.map((t) => t.tankCode).sort()).toEqual(['TK-04', 'TK-10', 'TK-15'])
    const wine = dataOf((await call('/v1/fermentation-tanks?destinationType=WINE_AGING', { token })).json) as Paged<unknown>
    expect(wine.total).toBe(erpFixtures.fermentationTanks.filter((t) => t.wineryId === ALTOS.id && t.destinationType === 'WINE_AGING').length)
    expect((await call('/v1/fermentation-tanks?status=NOPE', { token })).status).toBe(422)
    const cvj = await login('enologa@cintiviejo.test')
    const resting = dataOf((await call('/v1/production-batches?restStatus=RESTING', { token: cvj })).json) as Paged<unknown>
    expect(resting.total).toBe(2)
  })

  it('una entidad de otra bodega responde 404', async () => {
    const token = await login('enologa@altos.test')
    const cintiTerroir = erpFixtures.terroirs.find((t) => t.wineryId === CINTI.id)!
    const { status, json } = await call(`/v1/terroirs/${cintiTerroir.id}`, { token })
    expect(status).toBe(404)
    expect(ErrorEnvelopeSchema.parse(json).error.code).toBe('NOT_FOUND')
  })

  it('el detalle del tanque incluye lecturas y tratamientos', async () => {
    const token = await login('enologa@altos.test')
    const tank = erpFixtures.fermentationTanks.find((t) => t.tankCode === 'TK-04')!
    const detail = FermentationTankDetailSchema.parse(dataOf((await call(`/v1/fermentation-tanks/${tank.id}`, { token })).json))
    expect(detail.logs!.length).toBeGreaterThan(0)
    expect(detail.treatments!.map((t) => t.treatmentType)).toEqual(['SO2_ADDITION', 'NUTRIENT_ADDITION'])
  })
})

describe('roles', () => {
  it('un agrónomo no puede crear tanques (403)', async () => {
    const token = await login('agronomo@altos.test')
    const harvest = erpFixtures.harvestBatches.find((h) => h.wineryId === ALTOS.id)!
    const { status, json } = await call('/v1/fermentation-tanks', {
      token,
      body: { inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-99', volumeFilledLiters: 1000, startDate: '2026-09-25' },
    })
    expect(status).toBe(403)
    expect(ErrorEnvelopeSchema.parse(json).error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS')
  })

  it('solo la plataforma lista el directorio de bodegas', async () => {
    const owner = await login('admin@altos.test')
    expect((await call('/v1/wineries', { token: owner })).status).toBe(403)
    const admin = await login('gestor@drinksonchain.test')
    const invited = dataOf((await call('/v1/wineries?status=INVITED', { token: admin })).json) as Paged<unknown>
    // Viñedos del Guadalquivir y Bodega Sol de Padcaya (INVITED desde la Ola 1).
    expect(invited).toMatchObject({ total: 2, limit: 20, offset: 0 })
    expect(invited.items).toHaveLength(2)
  })

  it('un consumidor no ve datos del ERP pero sí el pasaporte público', async () => {
    const token = await login('maria@tribu.test')
    expect((await call('/v1/harvest-batches', { token })).status).toBe(403)
    const passport = await call<{ generatedAt: string }>('/v1/public/lots/CVJ-2026-SINGANI-001', { token })
    expect(passport.status).toBe(200)
    const data = dataOf(passport.json)
    expect(data).toStrictEqual({ ...publicFixtures.passports['CVJ-2026-SINGANI-001'], generatedAt: data.generatedAt })
  })
})

describe('recorrido del ERP por las rutas definitivas (cierre H2 de la Ola 2)', () => {
  it('vendimia → tanque → crianza → embotellado del lote: el dictamen va aparte, la uva sin aprobar no fermenta, solo un tanque completado se transfiere y el candado no se elude', async () => {
    const token = await login('enologa@altos.test')
    const terroir = erpFixtures.terroirs.find((t) => t.parcelName === 'Cuartel 1 · La Angostura')!
    const base = { terroirId: terroir.id, intakeDate: '2026-09-25', harvestYear: 2026, grossWeightKg: 5200, tareWeightKg: 100 }

    // EA-04: el alta del pesaje no tiene dictamen; enviarlo, con cualquier valor, es un 422 propio.
    for (const value of ['APPROVED', 'PENDING_INSPECTION']) {
      const selfApproved = await call('/v1/harvest-batches', { token, body: { ...base, phytosanitaryStatus: value } })
      expect(selfApproved.status).toBe(422)
      const selfApprovedErr = ErrorEnvelopeSchema.parse(selfApproved.json).error
      expect(selfApprovedErr.code).toBe('TRC_PHYTO_IN_CREATE')
      expect(selfApprovedErr.details![0]).toMatchObject({ field: 'phytosanitaryStatus', code: 'TRC_PHYTO_IN_CREATE', actual: value })
    }

    // Bruto ≤ tara → 422 en grossWeightKg
    const badWeight = await call('/v1/harvest-batches', { token, body: { ...base, grossWeightKg: 100 } })
    expect(badWeight.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(badWeight.json).error.details![0]!.field).toBe('grossWeightKg')

    // Pesaje sin análisis → 201 (Brix, pH y acidez quedan nulos); uva recibida sin lote.
    const plain = HarvestBatchResponseSchema.parse(dataOf((await call('/v1/harvest-batches', { token, body: base })).json))
    expect(plain).toMatchObject({ brixDegrees: null, initialPh: null, initialAcidityGl: null, lotId: null, maturityAnalyses: [] })

    // Con `maturity` → es el primer análisis de madurez (y rellena los tres campos de la respuesta).
    const created = await call('/v1/harvest-batches', { token, body: { ...base, maturity: { brixDegrees: 24.1, ph: 3.55, acidityGl: 5.9 } } })
    expect(created.status).toBe(201)
    const harvest = HarvestBatchResponseSchema.parse(dataOf(created.json))
    expect(harvest).toMatchObject({ netWeightKg: 5100, phytosanitaryStatus: 'PENDING_INSPECTION', wineryId: ALTOS.id, brixDegrees: 24.1, initialPh: 3.55, initialAcidityGl: 5.9, availableKg: 5100 })
    expect(harvest.maturityAnalyses).toHaveLength(1)
    // Código con la secuencia de la bodega y el año (EA-07).
    expect(harvest.harvestBatchCode).toBe('HARV-2026-ANGOSTURA-016')
    expect(harvest.createdAt).toBe('2026-09-25T12:02:00Z')
    const list = dataOf((await call('/v1/harvest-batches?lotId=none&limit=100', { token })).json) as Paged<{ id: string }>
    expect(list.items.map((h) => h.id)).toEqual([plain.id, harvest.id])

    // La uva sin dictamen aprobado no entra a un tanque.
    const tankBody = { inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-21', capacityLiters: 8000, volumeFilledLiters: 3900, destinationType: 'WINE_AGING', startDate: '2026-09-25' }
    const unapproved = await call('/v1/fermentation-tanks', { token, body: tankBody })
    expect(unapproved.status).toBe(422)
    const unapprovedErr = ErrorEnvelopeSchema.parse(unapproved.json).error
    expect(unapprovedErr.code).toBe('TRC_PHYTO_NOT_APPROVED')
    expect(unapprovedErr.details![0]).toMatchObject({ rule: 'trazabilidad.fitosanitario.exigirAprobado', actual: 'PENDING_INSPECTION', meta: { harvestBatchId: harvest.id, status: 'PENDING_INSPECTION' } })

    // Dictamen: un registro propio, final (no se repite).
    const phyto = await call(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, { token, body: { decision: 'APPROVED' } })
    expect(phyto.status).toBe(201)
    expect(dataOf(phyto.json)).toMatchObject({ phytosanitaryStatus: 'APPROVED', phytoDecisions: [{ decision: 'APPROVED', source: 'ERP' }] })
    const again = await call(`/v1/harvest-batches/${harvest.id}/phyto-decisions`, { token, body: { decision: 'REJECTED', notes: 'Cambio de opinión' } })
    expect(again.status).toBe(409)
    expect(ErrorEnvelopeSchema.parse(again.json).error.code).toBe('TRC_PHYTO_DECISION_FINAL')

    // Estados finales en el alta del tanque → 422; el tanque nace FILLING y crea su lote.
    expect((await call('/v1/fermentation-tanks', { token, body: { ...tankBody, status: 'COMPLETED' } })).status).toBe(422)
    const tankRes = await call('/v1/fermentation-tanks', { token, body: tankBody })
    expect(tankRes.status).toBe(201)
    const tank = dataOf(tankRes.json) as { id: string; status: string; lotId: string; inputs: unknown[] }
    expect(tank).toMatchObject({ status: 'FILLING', inputs: [{ harvestBatchId: harvest.id, kg: 5100 }] })
    const lot = LotSchema.parse(dataOf((await call(`/v1/lots/${tank.lotId}`, { token })).json))
    expect(lot).toMatchObject({ name: 'Tannat 2026', productType: 'WINE', stage: 'FERMENTING', reference: 'ALT-L2026-008' })
    expect(lot.rules.origin).toBe('LOT_CREATION')
    // La otra uva aún no tiene dictamen: la regla del dictamen va antes que la del código ocupado.
    const sameCode = await call('/v1/fermentation-tanks', { token, body: { ...tankBody, inputs: [{ harvestBatchId: plain.id }] } })
    expect(sameCode.status).toBe(422)

    // Lecturas: no futuras.
    const future = await call(`/v1/fermentation-tanks/${tank.id}/logs`, { token, body: { temperatureCelsius: 22.4, recordedAt: '2026-09-26T08:00:00Z' } })
    expect(future.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(future.json).error.code).toBe('TRC_DATE_IN_FUTURE')
    const log = await call(`/v1/fermentation-tanks/${tank.id}/logs`, { token, body: { temperatureCelsius: 22.4, recordedAt: '2026-09-25T11:30:00Z' } })
    expect(log.status).toBe(201)
    const treatment = await call(`/v1/fermentation-tanks/${tank.id}/treatments`, {
      token,
      body: { treatmentType: 'SO2_ADDITION', additiveName: 'Metabisulfito', dosageAppliedGPerHl: 30, regulatoryAuthCode: 'SENASAG-1', appliedAt: '2026-09-25' },
    })
    expect(treatment.status).toBe(201)

    // Crianza: solo desde un tanque `COMPLETED` (cierre H2); el volumen es obligatorio y no supera lo disponible.
    const agingBody = { fermentationTankId: tank.id, containerType: 'Barrica', plannedMonths: 12 }
    const notCompleted = await call('/v1/wine-aging', { token, body: { ...agingBody, volumeLiters: 3800 } })
    expect(notCompleted.status).toBe(409)
    const notCompletedErr = ErrorEnvelopeSchema.parse(notCompleted.json).error
    expect(notCompletedErr.code).toBe('TRC_TANK_NOT_COMPLETED')
    expect(notCompletedErr.details![0]).toMatchObject({ field: 'fermentationTankId', meta: { status: 'FILLING', tankId: tank.id } })
    expect((await call(`/v1/fermentation-tanks/${tank.id}/start`, { token, body: {} })).status).toBe(200)
    const completed = await call(`/v1/fermentation-tanks/${tank.id}/complete`, { token, body: { endDate: '2026-09-25', finalVolumeLiters: 3900, destination: 'WINE_AGING' } })
    expect(dataOf(completed.json)).toMatchObject({ status: 'COMPLETED', destinationType: 'WINE_AGING', availableLiters: 3900 })
    const noVolume = await call('/v1/wine-aging', { token, body: agingBody })
    expect(noVolume.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(noVolume.json).error.details![0]!.field).toBe('volumeLiters')
    const tooMuch = await call('/v1/wine-aging', { token, body: { ...agingBody, volumeLiters: 4000 } })
    const tooMuchErr = ErrorEnvelopeSchema.parse(tooMuch.json).error
    expect(tooMuchErr.code).toBe('TRC_VOLUME_EXCEEDS_AVAILABLE')
    expect(tooMuchErr.details![0]).toMatchObject({ field: 'volumeLiters', expected: 3900, actual: 4000, meta: { available: 3900, requested: 4000, unit: 'L' } })
    // Altos fija un mínimo de crianza de 6 meses: menos → 422 con la regla.
    const short = await call('/v1/wine-aging', { token, body: { ...agingBody, plannedMonths: 3, volumeLiters: 3800 } })
    const shortErr = ErrorEnvelopeSchema.parse(short.json).error
    expect(shortErr.code).toBe('TRC_AGING_BELOW_MINIMUM')
    expect(shortErr.details![0]).toMatchObject({ field: 'plannedMonths', rule: 'trazabilidad.vino.crianzaMinimaMeses', expected: 6, actual: 3 })
    // 12 meses desde hoy → candado hasta 2027-09-25 (meses de calendario).
    const agingRes = await call('/v1/wine-aging', { token, body: { ...agingBody, volumeLiters: 3800 } })
    expect(agingRes.status).toBe(201)
    const aging = WineAgingResponseSchema.parse(dataOf(agingRes.json))
    expect(aging).toMatchObject({ lockUntilDate: '2027-09-25T00:00:00Z', unlockDate: '2027-09-25', startDate: '2026-09-25', lotId: tank.lotId })
    expect(aging.lock).toMatchObject({ kind: 'AGING', released: false, daysRemaining: 365, rule: { settingKey: 'trazabilidad.vino.crianzaMinimaMeses', minimum: 6, applied: 12, unit: 'meses' } })
    const twice = await call('/v1/wine-aging', { token, body: { ...agingBody, volumeLiters: 100 } })
    expect(ErrorEnvelopeSchema.parse(twice.json).error.code).toBe('FERMENTATION_TANK_ALREADY_TRANSFERRED')

    // Embotellar antes del candado → 422 con la regla, la fecha y los días que faltan (la vista previa lo anticipa).
    const bottle = { finalAlcoholAbv: 14, totalBottlesPackaged: 5000, packagingFormatCl: 75, bottlingDate: '2026-09-25' }
    const preview = BottlingPreviewSchema.parse(dataOf((await call(`/v1/lots/${tank.lotId}/bottling/preview`, { token, body: bottle })).json))
    expect(preview.valid).toBe(false)
    expect(preview.violations.map((v) => v.code)).toContain('TRC_LOCK_NOT_RELEASED')
    const locked = await call(`/v1/lots/${tank.lotId}/bottling`, { token, body: bottle })
    expect(locked.status).toBe(422)
    const lockedErr = ErrorEnvelopeSchema.parse(locked.json).error
    expect(lockedErr.code).toBe('TRC_LOCK_NOT_RELEASED')
    expect(lockedErr.message).toBe('Crianza de 12 meses: disponible el 2027-09-25 (faltan 365 días)')
    expect(lockedErr.details![0]).toMatchObject({
      field: 'bottlingDate',
      rule: 'trazabilidad.vino.crianzaMinimaMeses',
      expected: '2027-09-25',
      meta: { sourceId: aging.id, kind: 'AGING', unlockDate: '2027-09-25', daysRemaining: 365 },
    })
    // Declarar una fecha futura tampoco lo elude: el candado se evalúa con el reloj del servidor.
    const futureDate = await call(`/v1/lots/${tank.lotId}/bottling`, { token, body: { ...bottle, bottlingDate: '2027-10-01' } })
    expect(ErrorEnvelopeSchema.parse(futureDate.json).error.details!.map((d) => d.code)).toEqual(expect.arrayContaining(['TRC_DATE_IN_FUTURE', 'TRC_LOCK_NOT_RELEASED']))

    // Un lote de otra bodega no es visible → 404.
    const cintiLot = erpFixtures.lots.find((l) => l.wineryId === CINTI.id)!
    expect((await call(`/v1/lots/${cintiLot.id}/bottling`, { token, body: bottle })).status).toBe(404)
    // Las lecturas del embotellado siguen en `/v1/bottling`.
    const bottlings = pagedSchema(BottlingBatchResponseSchema).parse(dataOf((await call('/v1/bottling', { token })).json))
    expect(bottlings.items.length).toBeGreaterThan(0)
    expect(bottlings.items.every((b) => b.wineryId === ALTOS.id)).toBe(true)
  })

  it('rutas retiradas en el cierre H2 → 404 sin cabeceras Deprecation', async () => {
    const token = await login('enologa@altos.test')
    const bottling = erpFixtures.bottling.find((b) => b.wineryId === ALTOS.id)!
    const harvest = erpFixtures.harvestBatches.find((h) => h.wineryId === ALTOS.id)!
    const retired: [method: string, path: string, body?: unknown][] = [
      ['PATCH', `/v1/harvest-batches/${harvest.id}/phyto-status`, { phytosanitaryStatus: 'APPROVED' }],
      ['POST', '/v1/bottling', { wineAgingBatchId: bottling.wineAgingBatchId }],
      ['POST', '/v1/lab-analyses', { bottlingBatchId: bottling.id }],
      ['GET', `/v1/traceability/dag/${bottling.id}`],
      ['GET', `/v1/traceability/public/${bottling.internationalLotCode}`],
    ]
    for (const [method, path, body] of retired) {
      const res = await call(path, { token, method, body })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.headers.get('deprecation')).toBeNull()
    }
    // Sus sustitutas: el grafo del lote, el pasaporte público y las lecturas del embotellado y su análisis.
    expect((await call(`/v1/lots/${bottling.lotId}/graph`, { token })).status).toBe(200)
    expect((await call(`/v1/public/lots/${bottling.internationalLotCode}`)).status).toBe(200)
    expect((await call(`/v1/bottling/${bottling.id}`, { token })).status).toBe(200)
  })

  it('campos de entrada retirados en el cierre H2 → 422 VALIDATION_ERROR «property … should not exist» (como forbidNonWhitelisted)', async () => {
    const enologa = await login('enologa@altos.test')
    const agronomo = await login('agronomo@altos.test')
    const terroir = erpFixtures.terroirs.find((t) => t.wineryId === ALTOS.id)!
    const harvest = erpFixtures.harvestBatches.find((h) => h.wineryId === ALTOS.id)!
    const fermenting = erpFixtures.fermentationTanks.find((t) => t.wineryId === ALTOS.id && t.status === 'FERMENTING')!
    const lot = erpFixtures.lots.find((l) => l.wineryId === ALTOS.id && l.stage === 'AGING')!
    const bottled = erpFixtures.lots.find((l) => l.wineryId === ALTOS.id && l.stage === 'BOTTLED')!
    const weigh = { terroirId: terroir.id, intakeDate: '2026-09-25', harvestYear: 2026, grossWeightKg: 1200, tareWeightKg: 200 }
    const tank = { inputs: [{ harvestBatchId: harvest.id }], tankCode: 'TK-77', volumeFilledLiters: 500, startDate: '2026-09-25' }
    const distillation = { fermentationTankId: fermenting.id, equipmentIdentifier: 'AL-01', processStartDate: '2026-09-25', inputVolumeLiters: 100 }
    const bottle = { finalAlcoholAbv: 13.5, totalBottlesPackaged: 100, packagingFormatCl: 75, bottlingDate: '2026-09-25' }
    const lab = { certifiedLaboratoryName: 'Lab', accreditedLabCertificationCode: 'LAB-1', testPerformedAt: '2026-09-25', actualAlcoholAbv: 13.5, laboratoryReportKey: `org/${ALTOS.id}/lab-reports/2026/09/informe.pdf` }
    const cases: [token: string, method: string, path: string, body: Record<string, unknown>, fields: Record<string, unknown>][] = [
      [enologa, 'POST', '/v1/harvest-batches', weigh, { brixDegrees: 23, initialPh: 3.4, initialAcidityGl: 6 }],
      [agronomo, 'POST', '/v1/terroirs', { parcelName: 'Nueva', surfaceHectares: 1, altitudeMasl: 1900, rawMaterialType: 'uva', varietyName: 'Tannat' }, { isDoEligible: true }],
      [agronomo, 'PATCH', `/v1/terroirs/${terroir.id}`, { soilType: 'Franco' }, { isDoEligible: false }],
      [enologa, 'POST', '/v1/fermentation-tanks', tank, { harvestBatchId: harvest.id }],
      [enologa, 'POST', '/v1/production-batches/distillation', distillation, { processEndDate: '2026-09-25', outputVolumeLiters: 10, wasteVolumeLiters: 5, additionalParams: { heartYieldLiters: 10 }, isDoEligible: true }],
      [enologa, 'POST', `/v1/lots/${lot.id}/bottling`, bottle, { labelDesignUrl: 'https://cdn.test/etiqueta.png' }],
      [enologa, 'POST', `/v1/lots/${lot.id}/bottling/preview`, bottle, { labelDesignUrl: 'https://cdn.test/etiqueta.png' }],
      [enologa, 'POST', `/v1/lots/${bottled.id}/lab-analyses`, lab, { laboratoryReportPdfUrl: 'https://laboratorio.test/informe.pdf' }],
    ]
    for (const [token, method, path, body, fields] of cases) {
      for (const [field, value] of Object.entries(fields)) {
        const res = await call(path, { token, method, body: { ...body, [field]: value } })
        expect(res.status, `${method} ${path} · ${field}`).toBe(422)
        const error = ErrorEnvelopeSchema.parse(res.json).error
        expect(error.code).toBe('VALIDATION_ERROR')
        expect(error.details).toEqual([expect.objectContaining({ field, message: `property ${field} should not exist` })])
      }
    }
    // Los que pasaron a obligatorios.
    const required: [path: string, body: Record<string, unknown>, field: string][] = [
      ['/v1/fermentation-tanks', { ...tank, inputs: undefined }, 'inputs'],
      ['/v1/fermentation-tanks', { ...tank, volumeFilledLiters: undefined }, 'volumeFilledLiters'],
      ['/v1/production-batches/distillation', { ...distillation, inputVolumeLiters: undefined }, 'inputVolumeLiters'],
      [`/v1/lots/${bottled.id}/lab-analyses`, { ...lab, laboratoryReportKey: undefined }, 'laboratoryReportKey'],
    ]
    for (const [path, body, field] of required) {
      const res = await call(path, { token: enologa, body })
      expect(res.status, `${path} · ${field}`).toBe(422)
      expect(ErrorEnvelopeSchema.parse(res.json).error.details!.map((d) => d.field)).toContain(field)
    }
    // Destilar solo desde un tanque completado.
    const early = await call('/v1/production-batches/distillation', { token: enologa, body: distillation })
    expect(early.status).toBe(409)
    expect(ErrorEnvelopeSchema.parse(early.json).error).toMatchObject({ code: 'TRC_TANK_NOT_COMPLETED', details: [{ meta: { status: 'FERMENTING', tankId: fermenting.id } }] })
  })

  it('resetErpDb() descarta los cambios de la sesión', async () => {
    const token = await login('agronomo@altos.test')
    await call('/v1/terroirs', { token, body: { parcelName: 'Nueva', surfaceHectares: 1, altitudeMasl: 1900, rawMaterialType: 'uva', varietyName: 'Tannat' } })
    expect(getErpDb().terroirs).toHaveLength(erpFixtures.terroirs.length + 1)
    resetErpDb()
    expect(getErpDb().terroirs).toHaveLength(erpFixtures.terroirs.length)
  })
})

describe('bodega, miembros y archivos', () => {
  it('las rutas de 0.1 retiradas en H1 responden 404 (sin cabeceras Deprecation)', async () => {
    const token = await login('admin@altos.test')
    const res = await call('/v1/wineries/my/members', { token })
    expect(res.status).toBe(404)
    expect(res.headers.get('deprecation')).toBeNull()
    expect((await call('/v1/wineries/pending', { token: await login('gestor@drinksonchain.test') })).status).toBe(404)
    expect((await call('/v1/organizations/current/members', { token })).status).toBe(200)
  })

  it('POST /v1/uploads: clave privada de la organización, URL firmada y GET /v1/uploads/url', async () => {
    const token = await login('enologa@altos.test')
    const form = new FormData()
    form.append('file', new File([new Uint8Array([37, 80, 68, 70])], 'acta.pdf', { type: 'application/pdf' }))
    const res = await call('/v1/uploads?folder=inspections', { token, form })
    expect(res.status).toBe(201)
    const upload = UploadResponseSchema.parse(dataOf(res.json))
    const altos = erpFixtures.wineries.find((w) => w.commercialName === 'Bodega Altos de Calamuchita')!
    expect(upload.key).toMatch(new RegExp(`^org/${altos.id}/inspections/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.pdf$`))
    expect(upload.url.startsWith(`/mocks/uploads/${upload.key}?`)).toBe(true)
    expect(Date.parse(upload.expiresAt)).toBeGreaterThan(Date.parse('2026-09-25T12:00:00Z'))
    expect(upload).toMatchObject({ mimeType: 'application/pdf', originalName: 'acta.pdf', sizeBytes: 4 })
    // Huella SHA-256 del contenido (los bytes `%PDF`): la que guardan después el dictamen o el laboratorio junto a la `key`.
    expect(upload.sha256).toBe(toHex(sha256(new Uint8Array([37, 80, 68, 70]))))
    expect(getErpDb().uploads[upload.key]).toBe(upload.sha256)
    // URL nueva para mostrarlo; la clave de otra organización → 404 FILE_NOT_FOUND
    const again = await call(`/v1/uploads/url?key=${encodeURIComponent(upload.key)}`, { token })
    expect(dataOf(again.json)).toMatchObject({ key: upload.key })
    const other = await call(`/v1/uploads/url?key=${encodeURIComponent(upload.key)}`, { token: await login('admin@cintiviejo.test') })
    expect(ErrorEnvelopeSchema.parse(other.json).error.code).toBe('FILE_NOT_FOUND')
    // El tipo se reconoce por el contenido: un .exe (o un PDF que no lo es) → 422 FILE_TYPE_NOT_ALLOWED
    const bad = new FormData()
    bad.append('file', new File(['x'], 'x.exe', { type: 'application/x-msdownload' }))
    const rejected = await call('/v1/uploads', { token, form: bad })
    expect(rejected.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(rejected.json).error).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED', details: [{ field: 'file' }] })
    const fake = new FormData()
    fake.append('file', new File(['no soy un pdf'], 'falso.pdf', { type: 'application/pdf' }))
    expect(ErrorEnvelopeSchema.parse((await call('/v1/uploads', { token, form: fake })).json).error.code).toBe('FILE_TYPE_NOT_ALLOWED')
    // Solo personal: un consumidor → 403
    expect((await call('/v1/uploads', { token: await login('maria@tribu.test'), form })).status).toBe(403)
  })

  it('ruta /v1 desconocida → 404 con envoltorio (baseUrl explícito)', async () => {
    const { status, json } = await call('/v1/nope?x=1')
    expect(status).toBe(404)
    expect(json).toMatchObject({ success: false, path: '/v1/nope?x=1', error: { code: 'NOT_FOUND', message: 'Cannot GET /v1/nope?x=1' } })
  })

  it('health es público', async () => {
    const { json } = await call('/v1/health')
    expect(successEnvelopeSchema(HealthStatusSchema).safeParse(json).success).toBe(true)
    expect(dataOf(json)).toMatchObject({ status: 'ok' })
  })
})

describe('escenarios', () => {
  it('empty: listas vacías', async () => {
    const token = await login('enologa@altos.test')
    setScenario('empty')
    expect(dataOf((await call('/v1/terroirs', { token })).json)).toEqual({ items: [], total: 0, limit: 20, offset: 0 })
    expect(dataOf((await call('/v1/harvest-batches', { token })).json)).toEqual({ items: [], total: 0, limit: 20, offset: 0 })
    // El panel y el reporte no son listas: responden como una bodega sin registros.
    const dashboard = TraceDashboardSchema.parse(dataOf((await call('/v1/traceability/dashboard', { token })).json))
    expect(Object.values(dashboard.lotsByStage).every((n) => n === 0)).toBe(true)
    expect(dashboard).toMatchObject({ locksDueSoon: [], fermentationAlerts: [], pendingPhyto: [], bottledWithoutLab: [], readyToClose: [], complianceIssuesOpen: 0, unassignedHarvestBatches: 0 })
    const owner = await login('admin@altos.test')
    const report = dataOf((await call<{ rows: unknown[]; totals: Record<string, { lots: number }> }>('/v1/traceability/reports/production', { token: owner })).json)
    expect(report.rows).toEqual([])
    expect(Object.values(report.totals).map((t) => t.lots)).toEqual([0, 0, 0])
    const csv = await fetch(`${API}/v1/traceability/reports/production?format=csv`, { headers: { Authorization: `Bearer ${owner}` } })
    expect(csv.headers.get('x-export-rows')).toBe('0')
    expect((await csv.text()).trimEnd().split('\r\n')).toHaveLength(1)
    // Fuera del escenario vuelven los datos.
    setScenario('normal')
    expect(TraceDashboardSchema.parse(dataOf((await call('/v1/traceability/dashboard', { token })).json)).lotsByStage.BOTTLED).toBeGreaterThan(0)
  })

  it('error: 500 con envoltorio (login sigue funcionando)', async () => {
    setScenario('error')
    const token = await login('enologa@altos.test')
    const { status, json } = await call('/v1/terroirs', { token })
    expect(status).toBe(500)
    expect(ErrorEnvelopeSchema.parse(json).error.code).toBe('INTERNAL_ERROR')
  })

  it('offline: error de red', async () => {
    setScenario('offline')
    await expect(fetch(`${API}/v1/health`)).rejects.toThrow()
  })

  it('slow: añade 2,5 s', async () => {
    setScenario('slow')
    const start = Date.now()
    await call('/v1/health')
    expect(Date.now() - start).toBeGreaterThanOrEqual(2400)
  })

  it('setScenario rechaza nombres desconocidos', () => {
    expect(() => setScenario('nope' as never)).toThrow()
  })
})
