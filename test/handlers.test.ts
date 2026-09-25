import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  BottlingBatchResponseSchema,
  ErrorEnvelopeSchema,
  FermentationTankDetailSchema,
  HealthStatusSchema,
  HarvestBatchResponseSchema,
  pagedSchema,
  ProductionBatchResponseSchema,
  PublicPassportSchema,
  RestStatusResponseSchema,
  successEnvelopeSchema,
  TerroirResponseSchema,
  TraceabilityDagSchema,
  unwrapList,
  UploadResponseSchema,
  UserProfileResponseSchema,
  WineAgingResponseSchema,
  type Paged,
  type TerroirResponse,
} from '../src'
import { erpFixtures } from '../src/fixtures'
import { ERP_ROUTES, resetScenario, setScenario } from '../src/handlers'
import { getErpDb, resetErpDb, setupMockServer } from '../src/node'
import { API, call, dataOf, login } from './helpers'

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

describe('cobertura del OpenAPI', () => {
  it('hay un handler por cada operación del OpenAPI', async () => {
    const { readFileSync } = await import('node:fs')
    const spec = JSON.parse(readFileSync(new URL('../openapi/erp.json', import.meta.url), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>
    }
    const expected = Object.entries(spec.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`))
      .sort()
    const actual = ERP_ROUTES.map((r) => `${r.method} ${r.path}`).sort()
    expect(actual).toEqual(expected)
  })
})

describe('autenticación', () => {
  it('login con usuario de demo devuelve el fixture de auth-login', async () => {
    const { status, json } = await call('/v1/auth/login', { body: { email: 'enologa@altos.test', password: 'demo1234' } })
    expect(status).toBe(200)
    expect(json).toMatchObject({ success: true, statusCode: 200, path: '/v1/auth/login' })
    expect(dataOf(json)).toStrictEqual(erpFixtures.authLogin.altos_enologa)
  })

  it('las respuestas de login de todos los usuarios coinciden con auth-login.json', async () => {
    for (const [key, expected] of Object.entries(erpFixtures.authLogin)) {
      const email = erpFixtures.users.find((u) => u._mock.key === key)!.email
      const { json } = await call('/v1/auth/login', { body: { email, password: 'demo1234' } })
      expect(dataOf(json)).toStrictEqual(expected)
    }
  })

  it('contraseña incorrecta → 401 con envoltorio', async () => {
    const { status, json } = await call('/v1/auth/login', { body: { email: 'enologa@altos.test', password: 'x' } })
    expect(status).toBe(401)
    const err = ErrorEnvelopeSchema.parse(json)
    expect(err.error.code).toBe('UNAUTHORIZED')
  })

  it('cuerpo inválido → 400 VALIDATION_ERROR con detalles', async () => {
    const { status, json } = await call('/v1/auth/login', { body: {} })
    expect(status).toBe(400)
    const err = ErrorEnvelopeSchema.parse(json)
    expect(err.error.code).toBe('VALIDATION_ERROR')
    expect(Array.isArray(err.error.details)).toBe(true)
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

  it('users/me devuelve el perfil sin _mock', async () => {
    const token = await login('admin@altos.test')
    const me = dataOf((await call('/v1/users/me', { token })).json)
    expect(UserProfileResponseSchema.strict().parse(me).email).toBe('admin@altos.test')
    expect(me).not.toHaveProperty('_mock')
  })

  it('refresh renueva tokens y rechaza tokens desconocidos', async () => {
    const ok = await call('/v1/auth/refresh', { body: { refreshToken: 'mock.refresh.altos_admin' } })
    expect(dataOf(ok.json)).toMatchObject({ accessToken: 'mock.access.altos_admin', tokenType: 'Bearer' })
    expect((await call('/v1/auth/refresh', { body: { refreshToken: 'otro' } })).status).toBe(401)
  })

  it('signup crea un consumidor que luego puede iniciar sesión', async () => {
    const res = await call('/v1/auth/signup', { body: { email: 'nuevo@tribu.test', password: 'secreta1', fullName: 'Nuevo' } })
    expect(res.status).toBe(201)
    expect(await login('nuevo@tribu.test', 'secreta1')).toMatch(/^mock\.access\./)
    expect((await call('/v1/auth/signup', { body: { email: 'nuevo@tribu.test', password: 'x', fullName: 'X' } })).status).toBe(409)
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

  it('filtros varietyName e isDoEligible', async () => {
    const token = await login('agronomo@altos.test')
    const moscatel = unwrapList(dataOf((await call('/v1/terroirs?varietyName=moscatel', { token })).json) as Paged<TerroirResponse>)
    expect(moscatel.items.map((t) => t.parcelName)).toEqual(['Cuartel 2 · Los Sauces', 'Cuartel 3 · El Portillo'])
    const noDo = unwrapList(dataOf((await call('/v1/terroirs?isDoEligible=false', { token })).json) as Paged<TerroirResponse>)
    expect(noDo.items).toHaveLength(1)
    expect(noDo.items[0]!.altitudeMasl).toBe(1540)
  })

  it('limit / offset y total', async () => {
    const token = await login('enologa@cintiviejo.test')
    const first = dataOf((await call('/v1/harvest-batches?limit=2&offset=0', { token })).json) as Paged<unknown>
    const second = dataOf((await call('/v1/harvest-batches?limit=2&offset=2', { token })).json) as Paged<unknown>
    expect(first).toMatchObject({ total: 5, limit: 2, offset: 0 })
    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(2)
    expect(second.items[0]).not.toEqual(first.items[0])
    expect((await call('/v1/harvest-batches?limit=abc', { token })).status).toBe(400)
  })

  it('filtros de tanques (status, destinationType) y de destilación (restStatus)', async () => {
    const token = await login('enologa@altos.test')
    const fermenting = dataOf((await call('/v1/fermentation-tanks?status=FERMENTING', { token })).json) as Paged<{ tankCode: string }>
    expect(fermenting.items.map((t) => t.tankCode).sort()).toEqual(['TK-04', 'TK-10'])
    const wine = dataOf((await call('/v1/fermentation-tanks?destinationType=WINE_AGING', { token })).json) as Paged<unknown>
    expect(wine.total).toBe(7)
    expect((await call('/v1/fermentation-tanks?status=NOPE', { token })).status).toBe(400)
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
      body: { harvestBatchId: harvest.id, tankCode: 'TK-99', startDate: '2026-09-25' },
    })
    expect(status).toBe(403)
    expect(ErrorEnvelopeSchema.parse(json).error.code).toBe('FORBIDDEN')
  })

  it('solo PLATFORM_ADMIN lista bodegas y pendientes', async () => {
    const owner = await login('admin@altos.test')
    expect((await call('/v1/wineries', { token: owner })).status).toBe(403)
    const admin = await login('gestor@drinksonchain.test')
    const pending = dataOf((await call('/v1/wineries/pending', { token: admin })).json) as unknown[]
    expect(pending).toHaveLength(1)
  })

  it('un consumidor no ve datos del ERP pero sí el pasaporte público', async () => {
    const token = await login('maria@tribu.test')
    expect((await call('/v1/harvest-batches', { token })).status).toBe(403)
    const passport = await call('/v1/traceability/public/CVJ-2026-SINGANI-001')
    expect(passport.status).toBe(200)
    expect(dataOf(passport.json)).toStrictEqual(erpFixtures.traceabilityPublic['CVJ-2026-SINGANI-001'])
  })
})

describe('recorrido del ERP: vendimia → tanque → crianza → embotellado', () => {
  it('flujo completo con reglas de negocio', async () => {
    const token = await login('enologa@altos.test')
    const terroir = erpFixtures.terroirs.find((t) => t.parcelName === 'Cuartel 1 · La Angostura')!

    // Pesaje sin laboratorio → 422
    const base = { terroirId: terroir.id, intakeDate: '2026-09-25', harvestYear: 2026, grossWeightKg: 5200, tareWeightKg: 100 }
    const noLab = await call('/v1/harvest-batches', { token, body: base })
    expect(noLab.status).toBe(422)
    const err = ErrorEnvelopeSchema.parse(noLab.json)
    expect(err.error.code).toBe('UNPROCESSABLE_ENTITY')
    expect(err.error.details).toEqual(['brixDegrees es obligatorio', 'initialPh es obligatorio', 'initialAcidityGl es obligatorio'])

    // Bruto ≤ tara → 400
    const badWeight = await call('/v1/harvest-batches', {
      token,
      body: { ...base, grossWeightKg: 100, brixDegrees: 23, initialPh: 3.5, initialAcidityGl: 6 },
    })
    expect(badWeight.status).toBe(400)

    // Pesaje correcto → 201 y aparece en la lista
    const created = await call('/v1/harvest-batches', {
      token,
      body: { ...base, brixDegrees: 24.1, initialPh: 3.55, initialAcidityGl: 5.9 },
    })
    expect(created.status).toBe(201)
    const harvest = HarvestBatchResponseSchema.parse(dataOf(created.json))
    expect(harvest).toMatchObject({ netWeightKg: 5100, phytosanitaryStatus: 'PENDING_INSPECTION', wineryId: ALTOS.id })
    expect(harvest.harvestBatchCode).toBe('HARV-2026-ANGOSTURA-13')
    expect(harvest.createdAt).toBe('2026-09-25T12:01:00Z')
    const list = dataOf((await call('/v1/harvest-batches?harvestYear=2026&limit=100', { token })).json) as Paged<{ id: string }>
    expect(list.items.some((h) => h.id === harvest.id)).toBe(true)

    // Dictamen fitosanitario
    const phyto = await call(`/v1/harvest-batches/${harvest.id}/phyto-status`, {
      token,
      method: 'PATCH',
      body: { phytosanitaryStatus: 'APPROVED' },
    })
    expect(dataOf(phyto.json)).toMatchObject({ phytosanitaryStatus: 'APPROVED' })

    // Tanque con destino vino
    const tankRes = await call('/v1/fermentation-tanks', {
      token,
      body: { harvestBatchId: harvest.id, tankCode: 'TK-11', capacityLiters: 8000, volumeFilledLiters: 3900, destinationType: 'WINE_AGING', startDate: '2026-09-25' },
    })
    expect(tankRes.status).toBe(201)
    const tank = dataOf(tankRes.json) as { id: string; status: string }
    expect(tank.status).toBe('FILLING')

    const log = await call(`/v1/fermentation-tanks/${tank.id}/logs`, { token, body: { temperatureCelsius: 22.4, recordedAt: '2026-09-26T08:00:00Z' } })
    expect(log.status).toBe(201)
    const treatment = await call(`/v1/fermentation-tanks/${tank.id}/treatments`, {
      token,
      body: { treatmentType: 'SO2_ADDITION', additiveName: 'Metabisulfito', dosageAppliedGPerHl: 30, regulatoryAuthCode: 'SENASAG-1', appliedAt: '2026-09-25' },
    })
    expect(treatment.status).toBe(201)

    // Crianza de 12 meses desde hoy → candado hasta 2027-09-25
    const agingRes = await call('/v1/wine-aging', {
      token,
      body: { fermentationTankId: tank.id, containerType: 'Barrica', plannedMonths: 12 },
    })
    expect(agingRes.status).toBe(201)
    const aging = WineAgingResponseSchema.parse(dataOf(agingRes.json))
    expect(aging.lockUntilDate).toBe('2027-09-25T00:00:00Z')

    // Embotellar antes del candado → 422
    const bottle = { wineAgingBatchId: aging.id, productType: 'WINE', finalAlcoholAbv: 14, totalBottlesPackaged: 5000, packagingFormatCl: 75, bottlingDate: '2026-09-25' }
    const locked = await call('/v1/bottling', { token, body: bottle })
    expect(locked.status).toBe(422)
    expect(ErrorEnvelopeSchema.parse(locked.json).error.message).toBe('El vino se encuentra bloqueado por período de crianza hasta el 2027-09-25')

    // Una crianza liberada (fixture READY de otra bodega no es visible → 404)
    const cintiReady = erpFixtures.wineAging.find((a) => a.agingStatus === 'READY')!
    expect((await call('/v1/bottling', { token, body: { ...bottle, wineAgingBatchId: cintiReady.id } })).status).toBe(404)
  })

  it('embotellado de singani: 422 durante el reposo y 201 con el reposo cumplido', async () => {
    const token = await login('enologa@cintiviejo.test')
    const resting = erpFixtures.productionBatches.find((p) => p.restStatus === 'RESTING')!
    const ready = erpFixtures.productionBatches.find((p) => p.restStatus === 'READY')!
    const body = { productType: 'SINGANI', finalAlcoholAbv: 40, waterDilutionLiters: 300, totalBottlesPackaged: 1000, packagingFormatCl: 75, bottlingDate: '2026-09-25' }

    const rest = RestStatusResponseSchema.parse(dataOf((await call(`/v1/production-batches/${resting.id}/rest-status`, { token })).json))
    expect(rest.isRestCompleted).toBe(false)
    const blocked = await call('/v1/bottling', { token, body: { ...body, productionBatchId: resting.id } })
    expect(blocked.status).toBe(422)

    const ok = await call('/v1/bottling', { token, body: { ...body, productionBatchId: ready.id } })
    expect(ok.status).toBe(201)
    const b = BottlingBatchResponseSchema.parse(dataOf(ok.json))
    expect(b.internationalLotCode).toBe('CVJ-2026-SINGANI-004')
    expect(b.isAnchoredOnChain).toBe(false)
    const after = ProductionBatchResponseSchema.parse(dataOf((await call(`/v1/production-batches/${ready.id}`, { token })).json))
    expect(after.restStatus).toBe('BOTTLED')

    // Pasaporte público y grafo del nuevo lote
    const passport = PublicPassportSchema.parse(dataOf((await call(`/v1/traceability/public/${b.internationalLotCode}`)).json))
    expect(passport.blockchainIntegrity.status).toBe('PENDING_ANCHOR')
    const dag = TraceabilityDagSchema.parse(dataOf((await call(`/v1/traceability/dag/${b.id}`, { token })).json))
    expect(dag.nodes.map((n) => n.type)).toEqual(['TERROIR', 'HARVEST_BATCH', 'FERMENTATION_TANK', 'PRODUCTION_BATCH', 'BOTTLING_BATCH'])

    // Certificado de laboratorio: alta y 409 al repetir
    const lab = { bottlingBatchId: b.id, certifiedLaboratoryName: 'Lab', accreditedLabCertificationCode: 'LAB-1', testPerformedAt: '2026-09-26', actualAlcoholAbv: 40, totalAcidityTartaricGl: 4, volatileAcidityAceticGl: 0.2, laboratoryReportPdfUrl: '/mocks/uploads/lab-reports/x.pdf' }
    expect((await call('/v1/lab-analyses', { token, body: lab })).status).toBe(201)
    expect((await call('/v1/lab-analyses', { token, body: lab })).status).toBe(409)
  })

  it('destilación D.O.: 422 si la parcela está por debajo de 1.600 m', async () => {
    const token = await login('enologa@altos.test')
    const lowTerroir = erpFixtures.terroirs.find((t) => t.altitudeMasl < 1600)!
    const harvest = dataOf(
      (await call('/v1/harvest-batches', {
        token,
        body: { terroirId: lowTerroir.id, intakeDate: '2026-09-25', harvestYear: 2026, grossWeightKg: 3000, tareWeightKg: 50, brixDegrees: 22, initialPh: 3.5, initialAcidityGl: 6 },
      })).json,
    ) as { id: string }
    const tank = dataOf((await call('/v1/fermentation-tanks', { token, body: { harvestBatchId: harvest.id, tankCode: 'TK-SG', destinationType: 'SINGANI_DIST', startDate: '2026-09-25' } })).json) as { id: string }
    const res = await call('/v1/production-batches/distillation', {
      token,
      body: { fermentationTankId: tank.id, equipmentIdentifier: 'AL-01', processStartDate: '2026-09-25', isDoEligible: true },
    })
    expect(res.status).toBe(422)
    const nonDo = await call('/v1/production-batches/distillation', {
      token,
      body: { fermentationTankId: tank.id, equipmentIdentifier: 'AL-01', processStartDate: '2026-09-25', processEndDate: '2026-09-26' },
    })
    expect(nonDo.status).toBe(201)
    expect(ProductionBatchResponseSchema.parse(dataOf(nonDo.json)).mandatoryRestUntil).toBe('2027-03-25T00:00:00Z')
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
  it('el dueño crea un miembro que puede iniciar sesión con su bodega', async () => {
    const token = await login('admin@altos.test')
    const res = await call('/v1/wineries/my/members/create', {
      token,
      body: { email: 'nueva.enologa@altos.test', password: 'clave123', fullName: 'Nueva Enóloga', memberRole: 'ENOLOGIST' },
    })
    expect(res.status).toBe(201)
    const newToken = await login('nueva.enologa@altos.test', 'clave123')
    const me = dataOf((await call('/v1/users/me', { token: newToken })).json) as { wineryMemberships: { wineryId: string }[] }
    expect(me.wineryMemberships[0]!.wineryId).toBe(ALTOS.id)
    const membersList = dataOf((await call('/v1/wineries/my/members', { token })).json) as unknown[]
    expect(membersList).toHaveLength(5)
  })

  it('aprobar una bodega pendiente le asigna cuenta Stellar', async () => {
    const token = await login('gestor@drinksonchain.test')
    const pending = erpFixtures.wineries.find((w) => w.certificationStatus === 'PENDING')!
    const approved = dataOf((await call(`/v1/wineries/${pending.id}/approve`, { token, body: {} })).json) as {
      certificationStatus: string
      stellarPublicKey: string
    }
    expect(approved.certificationStatus).toBe('ACTIVE')
    expect(approved.stellarPublicKey).toMatch(/^G[A-Z2-7]{55}$/)
  })

  it('POST /v1/uploads devuelve una URL /mocks/uploads/...', async () => {
    const token = await login('enologa@altos.test')
    const form = new FormData()
    form.append('file', new File([new Uint8Array([37, 80, 68, 70])], 'acta.pdf', { type: 'application/pdf' }))
    const res = await call('/v1/uploads?folder=inspections', { token, form })
    expect(res.status).toBe(201)
    const upload = UploadResponseSchema.parse(dataOf(res.json))
    expect(upload.url).toMatch(/^\/mocks\/uploads\/inspections\/\d+-acta\.pdf$/)
    const bad = new FormData()
    bad.append('file', new File(['x'], 'x.exe', { type: 'application/x-msdownload' }))
    expect((await call('/v1/uploads', { token, form: bad })).status).toBe(400)
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
    expect(dataOf((await call('/v1/terroirs', { token })).json)).toEqual({ items: [], total: 0, limit: 50, offset: 0 })
    expect(dataOf((await call('/v1/wineries/my/members', { token })).json)).toEqual([])
  })

  it('error: 500 con envoltorio (login sigue funcionando)', async () => {
    setScenario('error')
    const token = await login('enologa@altos.test')
    const { status, json } = await call('/v1/terroirs', { token })
    expect(status).toBe(500)
    expect(ErrorEnvelopeSchema.parse(json).error.code).toBe('INTERNAL_SERVER_ERROR')
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
