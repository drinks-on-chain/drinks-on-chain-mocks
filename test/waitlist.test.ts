import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AuditEventSchema,
  DashboardSchema,
  ErrorEnvelopeSchema,
  PermissionMatrixSchema,
  WAITLIST_CSV_COLUMNS,
  WAITLIST_EMAIL_LIMIT_PER_HOUR,
  WaitlistEntrySchema,
  WaitlistJoinRequestSchema,
  WaitlistJoinResponseSchema,
  WaitlistSourcesSchema,
  WaitlistStatsSchema,
  listPageSchema,
  type AuditEvent,
  type Envelope,
  type WaitlistEntry,
} from '../src'
import { platformRolesWith } from '../src/backoffice/permissions'
import { generateWaitlistFixtures } from '../src/backoffice/seed/waitlist'
import { backofficeFixtures as B } from '../src/fixtures'
import { resetScenario, setScenario } from '../src/handlers'
import { getErpDb, resetErpDb, setupMockServer } from '../src/node'
import { API, call, dataOf, login } from './helpers'

// Lista de espera (plan/contratos/o1b-lista-de-espera.md, backend v0.1.1): fixtures y handlers.

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
  resetScenario()
})
afterAll(() => server.close())

const staticToken = (key: string) => `mock.access.${key}`
const OPERATIONS = staticToken('operaciones')
const SUPPORT = staticToken('soporte')
const PUBLIC = { 'X-Client-App': 'PUBLIC' }
const BO = { 'X-Client-App': 'BACKOFFICE' }

const CONSUMER = { type: 'CONSUMER', fullName: 'Persona de Prueba', email: 'prueba@example.com', isAdult: true, consent: true }
const WINERY = { type: 'WINERY', fullName: 'Contacto de Prueba', email: 'bodega.prueba@example.com', wineryName: 'Bodega de Prueba', consent: true }

type Join = { type: string; position: number }
type Page = { items: WaitlistEntry[]; total: number; limit: number; offset: number }

const join = (body: unknown, headers: Record<string, string> = PUBLIC) => call<Join>('/v1/public/waitlist', { body, headers })
const list = async (query = '', token = OPERATIONS) => dataOf((await call<Page>(`/v1/platform/waitlist${query}`, { token })).json)
const errorOf = (json: Envelope<unknown>) => ErrorEnvelopeSchema.parse(json).error
const fieldsOf = (json: Envelope<unknown>) => (errorOf(json).details ?? []).map((d) => d.field)
const stored = () => getErpDb().backoffice.waitlist
const audit = (action: string): AuditEvent[] => getErpDb().backoffice.audit.filter((e) => e.action === action).map((e) => AuditEventSchema.parse(e))

const consumers = B.waitlist.filter((e) => e.type === 'CONSUMER')
const wineries = B.waitlist.filter((e) => e.type === 'WINERY')

describe('fixtures de la lista de espera', () => {
  it('entre 40 y 60 inscripciones de consumidores y bodegas, deterministas y con el esquema estricto', () => {
    expect(B.waitlist.length).toBeGreaterThanOrEqual(40)
    expect(B.waitlist.length).toBeLessThanOrEqual(60)
    expect(consumers.length).toBeGreaterThan(wineries.length)
    expect(wineries.length).toBeGreaterThanOrEqual(10)
    expect(z.array(WaitlistEntrySchema.strict()).parse(B.waitlist)).toStrictEqual(B.waitlist)
    expect(JSON.parse(JSON.stringify(generateWaitlistFixtures()))).toStrictEqual(B.waitlist)
  })

  it('posiciones consecutivas por tipo en orden de llegada; correos únicos por tipo y en dominios example.*', () => {
    for (const group of [consumers, wineries]) {
      const byArrival = [...group].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      expect(byArrival.map((e) => e.position)).toEqual(byArrival.map((_, i) => i + 1))
      expect(new Set(group.map((e) => e.email)).size).toBe(group.length)
    }
    expect(new Set(B.waitlist.map((e) => e.id)).size).toBe(B.waitlist.length)
    for (const e of B.waitlist) {
      expect(e.email, e.email).toMatch(/^[a-z0-9.]+@example\.(com|org|net)$/)
      expect(e.consentAt).toBe(e.createdAt)
      expect(e.createdAt < '2026-09-25T12:00:00Z', e.email).toBe(true)
    }
    // El archivo sale como la lista: más recientes primero.
    expect(B.waitlist.map((e) => e.createdAt)).toEqual([...B.waitlist.map((e) => e.createdAt)].sort().reverse())
  })

  it('orígenes variados (tarija-2026 mayoritario, alguno sin origen) y los tres estados', () => {
    const bySource = new Map<string | null, number>()
    for (const e of B.waitlist) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1)
    expect(bySource.get('tarija-2026')!).toBeGreaterThan(B.waitlist.length / 2)
    expect(bySource.get(null)!).toBeGreaterThan(0)
    expect(bySource.size).toBeGreaterThanOrEqual(4)
    expect(new Set(B.waitlist.map((e) => e.status))).toEqual(new Set(['NEW', 'CONTACTED', 'DISCARDED']))
    for (const e of B.waitlist) {
      if (e.status === 'CONTACTED') expect(e.contactedAt && e.contactedBy, e.email).toBeTruthy()
      if (e.status === 'NEW') expect([e.contactedAt, e.contactedBy], e.email).toEqual([null, null])
      if (e.contactedAt) expect(e.contactedAt > e.createdAt, e.email).toBe(true)
      expect(Boolean(e.wineryName), e.email).toBe(e.type === 'WINERY')
    }
    expect(new Set(B.waitlist.map((e) => e.locale))).toEqual(new Set(['es', 'en']))
  })
})

describe('POST /v1/public/waitlist', () => {
  it('201 con la posición dentro de su tipo; la inscripción queda en la lista y en la bitácora (origen PUBLIC, sin datos personales)', async () => {
    const res = await join({ ...CONSUMER, email: '  Prueba@Example.COM ', phone: '+591 70000001', city: 'Tarija', interest: 'BOTH', source: 'Tarija-2026' })
    expect(res.status).toBe(201)
    expect(WaitlistJoinResponseSchema.parse(dataOf(res.json))).toEqual({ type: 'CONSUMER', position: consumers.length + 1 })
    const winery = await join({ ...WINERY, region: 'Valle de Cinti', produces: 'SINGANI' })
    expect(dataOf(winery.json)).toEqual({ type: 'WINERY', position: wineries.length + 1 })

    const entry = stored().find((e) => e.email === 'prueba@example.com')!
    expect(WaitlistEntrySchema.strict().parse(entry)).toMatchObject({
      type: 'CONSUMER',
      status: 'NEW',
      fullName: 'Persona de Prueba',
      phone: '+591 70000001',
      city: 'Tarija',
      interest: 'BOTH',
      wineryName: null,
      locale: 'es',
      source: 'tarija-2026',
      contactedAt: null,
      notes: null,
    })
    expect(entry.consentAt).toBe(entry.createdAt)
    const joined = audit('WAITLIST_JOINED')
    expect(joined).toHaveLength(2)
    expect(joined[0]).toMatchObject({
      source: { app: 'PUBLIC' },
      resource: { type: 'waitlist_entry', id: entry.id },
      organizationId: null,
      after: { type: 'CONSUMER', source: 'tarija-2026' },
    })
    expect(JSON.stringify(joined)).not.toContain('prueba@example.com')
    // La nueva sale la primera de la lista del back office.
    expect((await list('?type=CONSUMER&limit=1')).items[0]!.id).toBe(entry.id)
  })

  it('correo ya inscrito en ese tipo: misma posición, sin duplicar ni pisar datos (solo completa teléfono, ciudad y región)', async () => {
    const known = consumers.find((e) => e.phone === null && e.city !== null)!
    const before = stored().length
    const again = await join({ ...CONSUMER, fullName: 'Otro Nombre', email: known.email.toUpperCase(), phone: '70000002', city: 'Otra ciudad', interest: 'WINE' })
    expect(again.status).toBe(201)
    expect(dataOf(again.json)).toEqual({ type: 'CONSUMER', position: known.position })
    expect(stored()).toHaveLength(before)
    expect(stored().find((e) => e.id === known.id)).toMatchObject({ fullName: known.fullName, phone: '70000002', city: known.city, interest: known.interest })
    expect(audit('WAITLIST_JOINED')).toHaveLength(0)
    // El mismo correo en el otro tipo sí es una inscripción nueva.
    const asWinery = await join({ ...WINERY, email: known.email })
    expect(dataOf(asWinery.json)).toEqual({ type: 'WINERY', position: wineries.length + 1 })
  })

  it('campo trampa relleno: 201 con una posición verosímil y nada guardado', async () => {
    const res = await join({ ...CONSUMER, website: 'https://spam.example' })
    expect(res.status).toBe(201)
    expect(dataOf(res.json)).toEqual({ type: 'CONSUMER', position: consumers.length + 1 })
    expect(stored()).toHaveLength(B.waitlist.length)
    expect(audit('WAITLIST_JOINED')).toHaveLength(0)
    // Un campo trampa vacío (o con espacios) no cuenta.
    expect((await join({ ...CONSUMER, website: '  ' })).status).toBe(201)
    expect(stored()).toHaveLength(B.waitlist.length + 1)
  })

  it('422 con details[{ field, message }] en español: isAdult, consent, wineryName, correo…', async () => {
    const consumer = await join({ type: 'CONSUMER', fullName: 'A', email: 'no-es-un-correo', consent: false, phone: 'abc', source: 'con espacios' })
    expect(consumer.status).toBe(422)
    expect(errorOf(consumer.json).code).toBe('VALIDATION_ERROR')
    expect(errorOf(consumer.json).details).toEqual(
      expect.arrayContaining([
        { field: 'fullName', message: 'El nombre debe tener entre 2 y 120 caracteres' },
        { field: 'email', message: 'El correo electrónico debe ser válido' },
        { field: 'phone', message: 'El teléfono debe tener entre 7 y 20 caracteres: dígitos, espacios y + - ( )' },
        { field: 'isAdult', message: 'Debes confirmar que eres mayor de edad' },
        { field: 'consent', message: 'Debes aceptar el aviso de privacidad para inscribirte' },
        { field: 'source', message: 'El origen admite hasta 40 caracteres: letras minúsculas, números y guiones' },
      ]),
    )
    // Como el e2e del backend: un detalle por campo.
    expect(fieldsOf((await join({ type: 'CONSUMER' })).json).sort()).toEqual(['consent', 'email', 'fullName', 'isAdult'])
    expect(fieldsOf((await join({ ...CONSUMER, phone: 'abc' })).json)).toEqual(['phone'])
    expect(fieldsOf((await join({ ...CONSUMER, isAdult: false })).json)).toEqual(['isAdult'])
    expect(fieldsOf((await join({ ...CONSUMER, consent: undefined })).json)).toEqual(['consent'])

    const winery = await join({ ...WINERY, wineryName: '  ' })
    expect(winery.status).toBe(422)
    expect(errorOf(winery.json).details).toEqual([{ field: 'wineryName', message: 'El nombre de la bodega es obligatorio' }])
    expect(fieldsOf((await join({ ...WINERY, wineryName: undefined })).json)).toEqual(['wineryName'])
    expect(fieldsOf((await join({ ...WINERY, isAdult: 'sí' })).json)).toEqual(['isAdult'])
    // En una bodega `isAdult` es opcional.
    expect((await join(WINERY)).status).toBe(201)

    const type = await join({ ...CONSUMER, type: 'PARTNER' })
    expect(errorOf(type.json).details).toEqual([{ field: 'type', message: 'Tipo de lista no válido' }])
    expect(fieldsOf((await join({ ...CONSUMER, message: 'x'.repeat(501), locale: 'pt', interest: 'BEER' })).json).sort()).toEqual(['interest', 'locale', 'message'])
    expect((await call('/v1/public/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status).toBe(422)
    expect(stored()).toHaveLength(B.waitlist.length + 1)
  })

  it('el esquema zod de la inscripción normaliza como el backend', () => {
    const parsed = WaitlistJoinRequestSchema.parse({ ...WINERY, email: ' Bodega@Example.com', phone: '', region: ' Valle de Cinti ', source: ' QR-Cata ', message: '   ' })
    expect(parsed).toMatchObject({ email: 'bodega@example.com', phone: null, region: 'Valle de Cinti', source: 'qr-cata', message: null })
  })

  it('captcha: opcional; un token con «fail» simula el rechazo (422 CAPTCHA_INVALID)', async () => {
    expect((await join({ ...CONSUMER, captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' })).status).toBe(201)
    const res = await join({ ...CONSUMER, email: 'otra@example.com', captchaToken: 'fail' })
    expect(res.status).toBe(422)
    expect(errorOf(res.json)).toMatchObject({ code: 'CAPTCHA_INVALID', details: [{ field: 'captchaToken' }] })
  })

  it(`más de ${WAITLIST_EMAIL_LIMIT_PER_HOUR} inscripciones por hora del mismo correo → 429 TOO_MANY_REQUESTS con Retry-After`, async () => {
    for (let i = 0; i < WAITLIST_EMAIL_LIMIT_PER_HOUR; i++) expect((await join(CONSUMER)).status).toBe(201)
    const blocked = await join(CONSUMER)
    expect(blocked.status).toBe(429)
    expect(errorOf(blocked.json).code).toBe('TOO_MANY_REQUESTS')
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(Number(blocked.headers.get('retry-after'))).toBeLessThanOrEqual(3600)
    // Otro correo no se ve afectado; el campo trampa no cuenta.
    expect((await join({ ...CONSUMER, email: 'otra@example.com' })).status).toBe(201)
    expect((await join({ ...CONSUMER, website: 'x' })).status).toBe(201)
  })
})

describe('GET /v1/public/waitlist/stats', () => {
  it('totales por tipo, públicos y con caché de 60 s', async () => {
    const res = await call('/v1/public/waitlist/stats')
    expect(res.status).toBe(200)
    expect(WaitlistStatsSchema.strict().parse(dataOf(res.json))).toEqual({ consumers: consumers.length, wineries: wineries.length })
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    await join(WINERY)
    expect(dataOf((await call('/v1/public/waitlist/stats')).json)).toEqual({ consumers: consumers.length, wineries: wineries.length + 1 })
  })
})

describe('GET /v1/platform/waitlist', () => {
  it('lista paginada, más reciente primero', async () => {
    const page = listPageSchema(WaitlistEntrySchema.strict()).parse(await list())
    expect(page).toMatchObject({ total: B.waitlist.length, limit: 20, offset: 0 })
    expect(page.items).toHaveLength(20)
    expect(page.items).toStrictEqual(B.waitlist.slice(0, 20))
    const second = await list('?limit=10&offset=50')
    expect(second.items).toStrictEqual(B.waitlist.slice(50, 60))
    expect((await call('/v1/platform/waitlist?limit=101', { token: OPERATIONS })).status).toBe(422)
  })

  it('filtros type, status, source, q, from y to', async () => {
    expect((await list('?type=WINERY&limit=100')).items.map((e) => e.id)).toEqual(wineries.map((e) => e.id))
    const contacted = await list('?status=CONTACTED&limit=100')
    expect(contacted.total).toBe(B.waitlist.filter((e) => e.status === 'CONTACTED').length)
    expect(contacted.items.every((e) => e.status === 'CONTACTED')).toBe(true)
    // El origen se compara en minúsculas y exacto.
    const event = await list('?source=TARIJA-2026&type=CONSUMER&limit=100')
    expect(event.total).toBe(consumers.filter((e) => e.source === 'tarija-2026').length)
    expect((await list('?source=tarija')).total).toBe(0)

    // `q` busca en nombre, correo, bodega y teléfono.
    const withPhone = consumers.find((e) => e.phone)!
    expect((await list(`?q=${encodeURIComponent(withPhone.phone!.slice(-6))}`)).items.map((e) => e.id)).toContain(withPhone.id)
    expect((await list('?q=TOMAYAPO')).items.map((e) => e.wineryName)).toEqual(['Viñas de Tomayapo'])
    expect((await list('?q=emily.carter@')).items.map((e) => e.fullName)).toEqual(['Emily Carter'])
    expect((await list(`?q=${encodeURIComponent('fernández')}`)).items.map((e) => e.fullName)).toEqual(['Lucía Fernández Rojas'])
    expect((await list('?q=nadie-con-este-texto')).total).toBe(0)

    // Fechas: AAAA-MM-DD = día completo (UTC) o ISO.
    const day = await list('?from=2026-09-20&to=2026-09-20&limit=100')
    expect(day.total).toBe(B.waitlist.filter((e) => e.createdAt.startsWith('2026-09-20')).length)
    expect(day.total).toBeGreaterThan(0)
    const recent = await list('?from=2026-09-24T12:00:00Z&limit=100')
    expect(recent.total).toBe(B.waitlist.filter((e) => e.createdAt >= '2026-09-24T12:00:00Z').length)
    const combined = await list('?type=WINERY&status=NEW&source=tarija-2026&from=2026-09-19&to=2026-09-21&limit=100')
    expect(combined.items.map((e) => e.wineryName)).toEqual([
      'Singani Artesanal Río San Juan del Oro',
      'Vinos de Altura Sella Méndez',
      'Bodega Los Ceibos de Chaguaya',
    ])
  })

  it('422 con el campo en filtros inválidos', async () => {
    for (const [query, field] of [
      ['type=PARTNER', 'type'],
      ['status=DONE', 'status'],
      ['from=ayer', 'from'],
      ['to=31-12-2026', 'to'],
      [`q=${'x'.repeat(201)}`, 'q'],
    ] as const) {
      const res = await call(`/v1/platform/waitlist?${query}`, { token: OPERATIONS })
      expect(res.status, query).toBe(422)
      expect(fieldsOf(res.json), query).toEqual([field])
    }
  })

  it('escenario empty: página vacía', async () => {
    setScenario('empty')
    expect(await list()).toEqual({ items: [], total: 0, limit: 20, offset: 0 })
  })
})

describe('GET /v1/platform/waitlist/sources', () => {
  it('arreglo plano { source, count }, del origen más numeroso al menos; null = sin origen', async () => {
    const all = WaitlistSourcesSchema.parse(dataOf((await call('/v1/platform/waitlist/sources', { token: SUPPORT })).json))
    expect(Array.isArray(all)).toBe(true)
    expect(all[0]).toEqual({ source: 'tarija-2026', count: B.waitlist.filter((e) => e.source === 'tarija-2026').length })
    expect(all.reduce((n, s) => n + s.count, 0)).toBe(B.waitlist.length)
    expect(all.map((s) => s.count)).toEqual([...all.map((s) => s.count)].sort((a, b) => b - a))
    expect(all.find((s) => s.source === null)!.count).toBe(B.waitlist.filter((e) => e.source === null).length)

    const ofWineries = dataOf((await call<Array<{ source: string | null; count: number }>>('/v1/platform/waitlist/sources?type=WINERY', { token: SUPPORT })).json)
    expect(ofWineries.reduce((n, s) => n + s.count, 0)).toBe(wineries.length)
    expect((await call('/v1/platform/waitlist/sources?type=X', { token: SUPPORT })).status).toBe(422)
  })
})

describe('PATCH /v1/platform/waitlist/{id}', () => {
  const fresh = consumers.find((e) => e.status === 'NEW')!
  const patch = (id: string, body: unknown, token = OPERATIONS) => call<WaitlistEntry>(`/v1/platform/waitlist/${id}`, { method: 'PATCH', token, body, headers: BO })

  it('al pasar a CONTACTED guarda contactedAt y quién; queda en la bitácora sin el texto de las notas', async () => {
    const res = await patch(fresh.id, { status: 'CONTACTED', notes: '  Llamada hecha: interesado en singani.  ' })
    expect(res.status).toBe(200)
    const entry = WaitlistEntrySchema.strict().parse(dataOf(res.json))
    expect(entry).toMatchObject({ id: fresh.id, status: 'CONTACTED', contactedBy: 'Valeria Méndez', notes: 'Llamada hecha: interesado en singani.' })
    expect(entry.contactedAt! > '2026-09-25T12:00:00Z').toBe(true)
    expect((await list(`?q=${fresh.email}`)).items[0]).toStrictEqual(entry)

    const [event] = audit('WAITLIST_STATUS_CHANGED')
    expect(event).toMatchObject({
      actor: { fullName: 'Valeria Méndez', role: 'OPERATIONS', viaPlatform: true },
      source: { app: 'BACKOFFICE' },
      resource: { type: 'waitlist_entry', id: fresh.id },
      before: { status: 'NEW' },
      after: { status: 'CONTACTED', notesChanged: true },
    })
    expect(JSON.stringify(event)).not.toContain('Llamada hecha')
  })

  it('DISCARDED conserva el contacto; volver a NEW lo borra; notes null o vacío borra las notas', async () => {
    const contacted = B.waitlist.find((e) => e.status === 'CONTACTED' && e.notes)!
    const discarded = dataOf((await patch(contacted.id, { status: 'DISCARDED' })).json)
    expect(discarded).toMatchObject({ status: 'DISCARDED', contactedAt: contacted.contactedAt, contactedBy: contacted.contactedBy, notes: contacted.notes })
    const cleared = dataOf((await patch(contacted.id, { notes: null })).json)
    expect(cleared).toMatchObject({ status: 'DISCARDED', notes: null, contactedBy: contacted.contactedBy })
    const back = dataOf((await patch(contacted.id, { status: 'NEW', notes: '' })).json)
    expect(back).toMatchObject({ status: 'NEW', contactedAt: null, contactedBy: null, notes: null })
    expect(audit('WAITLIST_STATUS_CHANGED').map((e) => e.after)).toEqual([
      { status: 'DISCARDED', notesChanged: false },
      { status: 'DISCARDED', notesChanged: true },
      { status: 'NEW', notesChanged: false },
    ])
  })

  it('sin cambios devuelve la inscripción tal cual, sin evento', async () => {
    expect(dataOf((await patch(fresh.id, {})).json)).toStrictEqual(fresh)
    expect(dataOf((await patch(fresh.id, { status: 'NEW', notes: null })).json)).toStrictEqual(fresh)
    expect(audit('WAITLIST_STATUS_CHANGED')).toHaveLength(0)
  })

  it('404 si no existe; 422 en status o en notas de más de 1000 caracteres', async () => {
    const missing = await patch('00000000-0000-4000-8000-000000000000', { status: 'CONTACTED' })
    expect(missing.status).toBe(404)
    expect(errorOf(missing.json).code).toBe('NOT_FOUND')
    const status = await patch(fresh.id, { status: 'DONE' })
    expect(status.status).toBe(422)
    expect(errorOf(status.json).details).toEqual([{ field: 'status', message: 'Estado no válido' }])
    const notes = await patch(fresh.id, { notes: 'x'.repeat(1001) })
    expect(errorOf(notes.json).details).toEqual([{ field: 'notes', message: 'Las notas admiten hasta 1000 caracteres' }])
    expect((await patch(fresh.id, { notes: 'x'.repeat(1000) })).status).toBe(200)
  })
})

describe('GET /v1/platform/waitlist/export', () => {
  const fetchCsv = (query = '', token = OPERATIONS) => fetch(`${API}/v1/platform/waitlist/export${query}`, { headers: { Authorization: `Bearer ${token}`, ...BO } })

  it('CSV UTF-8 con BOM, CRLF y Content-Disposition; columnas = WaitlistEntry sin id, en orden de llegada', async () => {
    const res = await fetchCsv()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="lista-de-espera-20260925-1200.csv"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-export-rows')).toBe(String(B.waitlist.length))
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder('utf-8', { ignoreBOM: false }).decode(bytes)
    expect(text.endsWith('\r\n')).toBe(true)
    const lines = text.slice(0, -2).split('\r\n')
    expect(lines[0]).toBe('position,type,status,fullName,email,phone,city,interest,wineryName,region,produces,message,locale,source,consentAt,createdAt,contactedAt,contactedBy,notes')
    expect(lines[0]!.split(',')).toEqual([...WAITLIST_CSV_COLUMNS])
    // Las claves de `WaitlistEntry` sin `id` (el backend pone `position` delante de `type`).
    expect([...WAITLIST_CSV_COLUMNS].sort()).toEqual(Object.keys(WaitlistEntrySchema.shape).filter((k) => k !== 'id').sort())
    expect(lines).toHaveLength(B.waitlist.length + 1)
    const first = [...B.waitlist].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]!
    expect(lines[1]!.startsWith(`1,CONSUMER,${first.status},${first.fullName},${first.email},`)).toBe(true)
    expect(text).not.toContain(first.id)
    expect(text).toContain('Óscar Segovia')
  })

  it('celdas protegidas contra fórmulas y entrecomilladas cuando hace falta', async () => {
    await join({ ...WINERY, fullName: '=HYPERLINK("https://x.example")', wineryName: 'Bodega "La Coma", S.R.L.', phone: '+591 70000003', message: 'Línea 1\nLínea 2' })
    const text = await (await fetchCsv('?q=bodega.prueba@example.com')).text()
    const row = text.split('\r\n').slice(1).join('\r\n')
    expect(row).toContain(`"'=HYPERLINK(""https://x.example"")"`)
    expect(row).toContain(`'+591 70000003`)
    expect(row).toContain('"Bodega ""La Coma"", S.R.L."')
    expect(row).toContain('"Línea 1\nLínea 2"')
  })

  it('mismos filtros que la lista y evento WAITLIST_EXPORTED con el número de filas (sin el texto buscado)', async () => {
    const res = await fetchCsv('?type=WINERY&status=CONTACTED&source=tarija-2026&from=2026-09-01&q=vi')
    const lines = (await res.text()).trim().split('\r\n')
    const expected = wineries.filter((e) => e.status === 'CONTACTED' && e.source === 'tarija-2026' && [e.fullName, e.email, e.wineryName].some((v) => v!.toLowerCase().includes('vi')))
    expect(expected.length).toBeGreaterThan(0)
    expect(lines).toHaveLength(expected.length + 1)
    const [event] = audit('WAITLIST_EXPORTED')
    expect(event).toMatchObject({
      actor: { fullName: 'Valeria Méndez' },
      source: { app: 'BACKOFFICE' },
      resource: { type: 'waitlist_entry', id: null },
      after: { rows: expected.length, filters: { type: 'WINERY', status: 'CONTACTED', source: 'tarija-2026', from: '2026-09-01', to: null, searched: true } },
    })
    expect((await fetchCsv('?status=NOPE')).status).toBe(422)
    expect(audit('WAITLIST_EXPORTED')).toHaveLength(1)
  })
})

describe('permisos de la lista de espera (capacidad waitlist)', () => {
  it('la matriz declara la capacidad: FULL para superusuario, administración y operaciones; READ para soporte', async () => {
    const matrix = PermissionMatrixSchema.parse(dataOf((await call('/v1/platform/permissions', { token: SUPPORT })).json))
    const capability = matrix.capabilities.find((c) => c.key === 'waitlist')!
    expect(capability.label).toBe('Lista de espera')
    expect(capability.roles).toMatchObject({ SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL', SUPPORT: 'READ', OWNER: 'NONE', ENOLOGIST: 'NONE' })
    expect(matrix.capabilities.map((c) => c.key)).toEqual(['platform.users', 'settings', 'applications', 'waitlist', 'wineries.suspend', 'wineries.revoke', 'team', 'audit'])
    expect(platformRolesWith('waitlist', 'FULL', 'READ')).toEqual(['SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT'])
    expect(platformRolesWith('waitlist', 'FULL')).toEqual(['SUPERADMIN', 'ADMIN', 'OPERATIONS'])
  })

  it('leen los cuatro roles de plataforma; soporte no cambia el estado ni exporta', async () => {
    const entry = consumers.find((e) => e.status === 'NEW')!
    for (const key of ['admin', 'bo_admin', 'operaciones', 'soporte']) {
      const token = staticToken(key)
      expect((await call('/v1/platform/waitlist', { token })).status, key).toBe(200)
      expect((await call('/v1/platform/waitlist/sources', { token })).status, key).toBe(200)
      const canWrite = key !== 'soporte'
      expect((await call(`/v1/platform/waitlist/${entry.id}`, { method: 'PATCH', token, body: {} })).status, key).toBe(canWrite ? 200 : 403)
      expect((await call('/v1/platform/waitlist/export?status=NOPE', { token })).status, key).toBe(canWrite ? 422 : 403)
    }
    const denied = await call(`/v1/platform/waitlist/${entry.id}`, { method: 'PATCH', token: SUPPORT, body: { status: 'CONTACTED' } })
    expect(errorOf(denied.json).code).toBe('AUTH_INSUFFICIENT_PERMISSIONS')
    expect(stored().find((e) => e.id === entry.id)!.status).toBe('NEW')
  })

  it('sin sesión → 401; personal de bodega y consumidores → 403', async () => {
    for (const path of ['/v1/platform/waitlist', '/v1/platform/waitlist/sources', '/v1/platform/waitlist/export']) {
      expect((await call(path)).status, path).toBe(401)
      expect((await call(path, { token: staticToken('altos_admin') })).status, path).toBe(403)
      expect((await call(path, { token: staticToken('maria') })).status, path).toBe(403)
    }
    expect((await call(`/v1/platform/waitlist/${consumers[0]!.id}`, { method: 'PATCH', body: {} })).status).toBe(401)
  })

  it('una sesión real de operaciones (con segundo factor) gestiona la lista', async () => {
    const token = await login('operaciones@drinksonchain.test')
    expect((await list('?limit=1', token)).total).toBe(B.waitlist.length)
  })
})

describe('tablero: bloque waitlist', () => {
  it('consumers, wineries y last24h (aditivo)', async () => {
    const read = async () => DashboardSchema.parse(dataOf((await call('/v1/platform/dashboard', { token: SUPPORT })).json))
    const last24h = B.waitlist.filter((e) => e.createdAt >= '2026-09-24T12:00:00Z').length
    expect(last24h).toBeGreaterThan(0)
    expect((await read()).waitlist).toEqual({ consumers: consumers.length, wineries: wineries.length, last24h })
    await join(CONSUMER)
    await join(WINERY)
    expect((await read()).waitlist).toEqual({ consumers: consumers.length + 1, wineries: wineries.length + 1, last24h: last24h + 2 })
  })
})
