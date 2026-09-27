import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as pkg from '../src'
import { backofficeFixtures, DEMO_NEW_PASSWORD, DEMO_TOTP_SECRET, erpFixtures, generateTotp } from '../src/fixtures'
import { MOCK_ROUTE_SPECS, mockMailbox } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import { uid } from '../src/shared/uuid'
import { API } from './helpers'

// Prueba de contrato (plan/04 §4): los mocks frente a openapi/erp.json.
// 1. Cada RouteSpec existe en el OpenAPI o está en openapi/pendientes.json como «adelantada»
//    por un contrato de ola; cada operación del OpenAPI tiene su RouteSpec.
// 2. Cada fixture con DTO valida contra su esquema del OpenAPI (Ajv).
// 3. Cada operación se ejecuta con una petición de ejemplo y su respuesta valida contra el
//    esquema del OpenAPI (o el de pendientes.json cuando el contrato de ola lo cambia).
//
// Normalización (docs/CONTRATO.md punto 3), porque el OpenAPI de NestJS no declara `nullable`:
// - los campos `T | null` salen como `{ type: 'object' }` sin propiedades: pasan a
//   `{ type: <tipo del example>, nullable: true }`;
// - los campos opcionales (fuera de `required`) aceptan también `null`, que es lo que devuelve
//   Prisma para una columna vacía. Los requeridos siguen sin admitir `null`.
// - ningún objeto admite campos que el DTO no declare (`additionalProperties: false`), salvo los
//   `camposExtra` de pendientes.json: así un campo renombrado rompe la prueba.

const root = join(import.meta.dirname, '..')
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), 'utf8')) as T

type Json = Record<string, unknown>
interface OpenApi {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: Json }> }> }>>
  components: { schemas: Record<string, Json> }
}
interface PendingEntry {
  method: string
  path: string
  contrato: string
  motivo: string
  respuesta?: { status: number; schema?: Json }
}
interface Pending {
  adelantadas: PendingEntry[]
  cambios: PendingEntry[]
  camposExtra: Record<string, { campos: string[]; contrato: string; motivo: string }>
  /** `Dto.campo` → valores de la enumeración que fija un contrato de ola (sustituyen a los del OpenAPI). */
  enumCambios: Record<string, { valores: string[]; contrato: string; motivo: string }>
}

const spec = readJson<OpenApi>('openapi/erp.json')
const pending = readJson<Pending>('openapi/pendientes.json')

const opKey = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`
const openApiOps = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => opKey(m, p))))
const routeOps = MOCK_ROUTE_SPECS.map((r) => opKey(r.method, r.path))
const ahead = new Map(pending.adelantadas.map((e) => [opKey(e.method, e.path), e]))
const changed = new Map(pending.cambios.map((e) => [opKey(e.method, e.path), e]))

// ---------------------------------------------------------------------------
// Ajv con los componentes del OpenAPI
// ---------------------------------------------------------------------------

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (!node || typeof node !== 'object') return node
  const obj = node as Json
  const bare =
    obj.type === 'object' && !('properties' in obj) && !('additionalProperties' in obj) && !('$ref' in obj) && !('allOf' in obj)
  if (bare) {
    const example = obj.example
    const type = typeof example
    if (type === 'string' || type === 'number' || type === 'boolean') return { type, nullable: true }
    if (example && type === 'object') return { type: Array.isArray(example) ? 'array' : 'object', nullable: true }
    return {}
  }
  const out = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalize(v)])) as Json
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
    const props = out.properties as Record<string, Json>
    for (const [name, prop] of Object.entries(props)) {
      if (required.has(name) || !prop.type) continue
      props[name] = { ...prop, nullable: true, ...(Array.isArray(prop.enum) ? { enum: [...(prop.enum as unknown[]), null] } : {}) }
    }
    if (!('additionalProperties' in out)) out.additionalProperties = false
  }
  return out
}

/** Componentes normalizados con los campos extra permitidos. */
function components(): Json {
  const schemas = normalize(spec.components.schemas) as Record<string, Json>
  for (const [name, extra] of Object.entries(pending.camposExtra)) {
    const props = schemas[name]?.properties as Record<string, Json> | undefined
    if (!props) throw new Error(`camposExtra: ${name} no existe en el OpenAPI`)
    for (const field of extra.campos) props[field] ??= {}
  }
  for (const [target, change] of Object.entries(pending.enumCambios)) {
    const [name, field] = target.split('.') as [string, string]
    const prop = (schemas[name]?.properties as Record<string, Json> | undefined)?.[field]
    if (!prop || !Array.isArray(prop.enum)) throw new Error(`enumCambios: ${target} no es una enumeración del OpenAPI`)
    prop.enum = [...change.valores, ...(prop.enum.includes(null) ? [null] : [])]
  }
  return { ...spec.components, schemas }
}

/** JSON Schema (draft 7) de un esquema zod exportado por el paquete (`{ $zod: 'Nombre' }`). */
function zodJsonSchema(name: string): Json {
  const schema = (pkg as Record<string, unknown>)[name]
  if (!(schema instanceof z.ZodType)) throw new Error(`$zod: ${name} no es un esquema exportado por el paquete`)
  const out = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Json
  delete out.$schema
  return out
}

/**
 * Reescribe `#/components/...` a `erp.json#/components/...`, expande `{ $page: ref }` y los
 * esquemas zod (`{ $zod: 'Nombre' }`, `{ $page: 'zod:Nombre' }`).
 */
function resolveRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveRefs)
  if (!node || typeof node !== 'object') return node
  const obj = node as Json
  if (typeof obj.$zod === 'string') return zodJsonSchema(obj.$zod)
  if (typeof obj.$page === 'string') {
    const item = obj.$page.startsWith('zod:') ? { $zod: obj.$page.slice(4) } : { $ref: obj.$page }
    return {
      type: 'object',
      required: ['items', 'total', 'limit', 'offset'],
      properties: {
        items: { type: 'array', items: resolveRefs(item) },
        total: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
    }
  }
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `erp.json${v}` : resolveRefs(v)]),
  )
}

const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
ajv.addSchema({ $id: 'erp.json', components: components() })
const cache = new Map<string, ValidateFunction>()
function validator(schema: Json): ValidateFunction {
  const key = JSON.stringify(schema)
  let fn = cache.get(key)
  if (!fn) {
    fn = ajv.compile(resolveRefs(schema) as Json)
    cache.set(key, fn)
  }
  return fn
}
const component = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })

function expectValid(schema: Json, value: unknown, label: string) {
  const validate = validator(schema)
  const valid = validate(value)
  if (!valid) throw new Error(`${label}: ${ajv.errorsText(validate.errors, { separator: '\n  ' })}`)
}

/** Esquema de respuesta: el de pendientes.json si el contrato de ola lo fija; si no, el del OpenAPI. */
function responseSchema(key: string, status: number): { schema: Json | null; source: string } {
  const override = ahead.get(key) ?? changed.get(key)
  if (override?.respuesta) {
    expect(override.respuesta.status, `${key}: estado de pendientes.json`).toBe(status)
    return { schema: override.respuesta.schema ?? null, source: override.contrato }
  }
  const [method, path] = key.split(' ') as [string, string]
  const schema = spec.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)]?.content?.['application/json']?.schema
  return { schema: schema ?? null, source: 'openapi/erp.json' }
}

// ---------------------------------------------------------------------------
// 1. Operaciones
// ---------------------------------------------------------------------------

describe('operaciones: RouteSpec ⇄ OpenAPI', () => {
  it('cada operación del OpenAPI tiene su RouteSpec', () => {
    expect([...openApiOps].filter((op) => !routeOps.includes(op))).toEqual([])
  })

  it('cada RouteSpec existe en el OpenAPI o está adelantada por un contrato de ola', () => {
    expect(routeOps.filter((op) => !openApiOps.has(op) && !ahead.has(op))).toEqual([])
    expect(new Set(routeOps).size).toBe(routeOps.length)
  })

  it('pendientes.json: las adelantadas aún no están en el OpenAPI (si llegan, se borran de aquí) y los cambios sí', () => {
    expect([...ahead.keys()].filter((op) => openApiOps.has(op))).toEqual([])
    expect([...changed.keys()].filter((op) => !openApiOps.has(op))).toEqual([])
    expect([...ahead.keys(), ...changed.keys()].filter((op) => !routeOps.includes(op))).toEqual([])
  })

  it('pendientes.json: cada entrada cita su contrato de ola y el motivo', () => {
    for (const e of [...pending.adelantadas, ...pending.cambios]) {
      expect(e.contrato, opKey(e.method, e.path)).toMatch(/^plan\/contratos\/o\d+-[\w-]+\.md §\d+/)
      expect(e.motivo.length).toBeGreaterThan(10)
    }
    for (const [name, e] of Object.entries(pending.camposExtra)) {
      expect(e.contrato, name).toMatch(/^(plan\/contratos\/o\d+-[\w-]+\.md §\d+|docs\/CONTRATO\.md §\d+)/)
      expect(e.campos.length, name).toBeGreaterThan(0)
    }
    for (const [name, e] of Object.entries(pending.enumCambios)) {
      expect(e.contrato, name).toMatch(/^plan\/contratos\/o\d+-[\w-]+\.md §\d+/)
      expect(e.valores.length, name).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_COMPONENTS: Array<[name: string, rows: unknown[], dto: string]> = [
  ['wineries.json', erpFixtures.wineries, 'WineryResponseDto'],
  // Sin `_mock` (credencial de demo, solo existe en los mocks).
  ['users.json', erpFixtures.users.map(({ _mock: _meta, ...user }) => user), 'UserProfileResponseDto'],
  ['wallets.json', erpFixtures.wallets, 'WalletResponseDto'],
  ['auth-login.json', Object.values(erpFixtures.authLogin), 'AuthResponseDto'],
  ['terroirs.json', erpFixtures.terroirs, 'TerroirResponseDto'],
  ['harvest-batches.json', erpFixtures.harvestBatches, 'HarvestBatchResponseDto'],
  ['fermentation-tanks.json', erpFixtures.fermentationTanks, 'FermentationTankResponseDto'],
  ['fermentation-logs.json', erpFixtures.fermentationLogs, 'CreateFermentationLogDto'],
  ['enological-treatments.json', erpFixtures.enologicalTreatments, 'CreateEnologicalTreatmentDto'],
  ['wine-aging.json', erpFixtures.wineAging, 'WineAgingResponseDto'],
  ['production-batches.json', erpFixtures.productionBatches, 'ProductionBatchResponseDto'],
  ['bottling.json', erpFixtures.bottling, 'BottlingBatchResponseDto'],
  ['lab-analyses.json', erpFixtures.labAnalyses, 'BatchLabAnalysisResponseDto'],
]

describe('fixtures ⇄ esquemas del OpenAPI', () => {
  it.each(FIXTURE_COMPONENTS.map(([name, rows, dto]) => ({ name, rows, dto })))('$name valida contra $dto', ({ name, rows, dto }) => {
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((row, i) => expectValid(component(dto), row, `${name}[${i}] ⇄ ${dto}`))
  })

  it('la normalización no vacía la prueba: un campo requerido ausente o de otro tipo falla', () => {
    const withoutId: Partial<(typeof erpFixtures.wineries)[number]> = { ...erpFixtures.wineries[0]! }
    delete withoutId.id
    expect(validator(component('WineryResponseDto'))(withoutId)).toBe(false)
    expect(validator(component('WineryResponseDto'))({ ...erpFixtures.wineries[0]!, certificationStatus: 'NOPE' })).toBe(false)
    expect(validator(component('WineryResponseDto'))({ ...erpFixtures.wineries[0]!, address: 42 })).toBe(false)
    expect(validator(component('WineryResponseDto'))({ ...erpFixtures.wineries[0]!, taxIdNit: null })).toBe(false)
    expect(validator(component('WineryResponseDto'))({ ...erpFixtures.wineries[0]!, legalNameRenamed: 'x' })).toBe(false)
  })

  it('los esquemas zod ($zod) tampoco admiten campos desconocidos ni tipos distintos', () => {
    const detail = backofficeFixtures.wineryDetails[0]!
    const check = validator({ $zod: 'WineryDetailSchema' })
    expect(check(detail)).toBe(true)
    expect(check({ ...detail, tradeNameRenamed: 'x' })).toBe(false)
    expect(check({ ...detail, status: 'PENDING' })).toBe(false)
    expect(check({ ...detail, lotPrefix: 'altos' })).toBe(false)
    expect(validator({ $page: 'zod:AuditEventSchema' })({ items: backofficeFixtures.audit.slice(0, 3), total: 3, limit: 20, offset: 0 })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Respuestas de ejemplo de cada operación
// ---------------------------------------------------------------------------

const server = setupMockServer({ baseUrl: API })
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetErpDb()
})
afterAll(() => server.close())

const F = erpFixtures
const winery = (name: string) => F.wineries.find((w) => w.commercialName === name)!
const ALTOS = winery('Bodega Altos de Calamuchita')
const CINTI = winery('Destilería Cinti Viejo')
const URIONDO = winery('Casa Uriondo')
const PENDING = F.wineries.find((w) => w.certificationStatus === 'INVITED')!
const altosTerroir = F.terroirs.find((t) => t.wineryId === ALTOS.id && t.altitudeMasl >= 1600)!
const altosHarvest = F.harvestBatches.find((h) => h.wineryId === ALTOS.id)!
const altosTank = F.fermentationTanks.find((t) => t.wineryId === ALTOS.id)!
const altosAging = F.wineAging.find((a) => a.wineryId === ALTOS.id)!
const cintiTank = F.fermentationTanks.find((t) => t.wineryId === CINTI.id)!
const readyProduction = F.productionBatches.find((p) => p.restStatus === 'READY')!
const bottlingWithLab = F.bottling.find((b) => F.labAnalyses.some((l) => l.bottlingBatchId === b.id))!
const bottlingWithoutLab = F.bottling.find((b) => !F.labAnalyses.some((l) => l.bottlingBatchId === b.id))!
const maria = F.users.find((u) => u._mock.key === 'maria')!

type Vars = Record<string, string>

interface Sample {
  /** Clave del usuario (token estático `mock.access.<clave>`); sin ella, petición pública. */
  as?: string
  url: string | ((v: Vars) => string)
  body?: unknown | ((v: Vars) => unknown)
  form?: () => FormData
  status: number
  /** Pasos previos (p. ej. pedir un enlace y leerlo del buzón). */
  setup?: () => Promise<Vars>
}

const SAMPLES: Record<string, Sample> = {
  'GET /v1/health': { url: '/v1/health', status: 200 },
  'POST /v1/auth/signup': { url: '/v1/auth/signup', body: { email: 'contrato@tribu.test', password: 'clave123', fullName: 'Contrato' }, status: 201 },
  'POST /v1/auth/login': { url: '/v1/auth/login', body: { email: 'sofia@aramayo.test', password: 'demo1234' }, status: 200 },
  'POST /v1/auth/refresh': { url: '/v1/auth/refresh', body: { refreshToken: 'mock.refresh.altos_admin' }, status: 200 },
  'POST /v1/auth/switch-organization': { as: 'sofia', url: '/v1/auth/switch-organization', body: { organizationId: URIONDO.id }, status: 200 },
  'POST /v1/auth/logout': { as: 'altos_admin', url: '/v1/auth/logout', body: {}, status: 204 },
  'POST /v1/auth/logout-all': { as: 'altos_admin', url: '/v1/auth/logout-all', body: {}, status: 204 },
  'GET /v1/users/me': { as: 'ines', url: '/v1/users/me', status: 200 },
  'PATCH /v1/users/me': { as: 'altos_admin', url: '/v1/users/me', body: { fullName: 'Martín C.' }, status: 200 },
  'GET /v1/users/me/wallet': { as: 'altos_admin', url: '/v1/users/me/wallet', status: 200 },
  'POST /v1/wineries': {
    as: 'maria',
    url: '/v1/wineries',
    body: { legalName: 'Nueva S.R.L.', commercialName: 'Nueva', beverageCategory: 'WINERY', taxIdNit: '5550001', geographicRegion: 'Valle Central de Tarija', contactEmail: 'hola@nueva.test' },
    status: 201,
  },
  'GET /v1/wineries': { as: 'admin', url: '/v1/wineries', status: 200 },
  'GET /v1/wineries/my': { as: 'altos_admin', url: '/v1/wineries/my', status: 200 },
  'PATCH /v1/wineries/my': { as: 'altos_admin', url: '/v1/wineries/my', body: { address: 'Camino a Calamuchita km 9' }, status: 200 },
  'POST /v1/wineries/my/members': { as: 'altos_admin', url: '/v1/wineries/my/members', body: { userId: maria.id, memberRole: 'ACCOUNTANT' }, status: 201 },
  'GET /v1/wineries/my/members': { as: 'altos_admin', url: '/v1/wineries/my/members', status: 200 },
  'POST /v1/wineries/my/members/create': {
    as: 'altos_admin',
    url: '/v1/wineries/my/members/create',
    body: { email: 'contable@altos.test', password: 'clave123', fullName: 'Contable', memberRole: 'ACCOUNTANT' },
    status: 201,
  },
  'GET /v1/wineries/pending': { as: 'admin', url: '/v1/wineries/pending', status: 200 },
  'POST /v1/wineries/{id}/approve': { as: 'admin', url: `/v1/wineries/${PENDING.id}/approve`, body: {}, status: 200 },
  'POST /v1/wineries/{id}/reject': { as: 'admin', url: `/v1/wineries/${PENDING.id}/reject`, body: { rejectionReason: 'Falta el registro SENASAG' }, status: 200 },
  'POST /v1/terroirs': {
    as: 'altos_agronomo',
    url: '/v1/terroirs',
    body: { parcelName: 'Cuartel 9 · Prueba', surfaceHectares: 1.5, altitudeMasl: 1900, rawMaterialType: 'uva', varietyName: 'Tannat' },
    status: 201,
  },
  'GET /v1/terroirs': { as: 'altos_agronomo', url: '/v1/terroirs', status: 200 },
  'GET /v1/terroirs/{id}': { as: 'altos_agronomo', url: `/v1/terroirs/${altosTerroir.id}`, status: 200 },
  'PATCH /v1/terroirs/{id}': { as: 'altos_agronomo', url: `/v1/terroirs/${altosTerroir.id}`, body: { soilType: 'Franco' }, status: 200 },
  'POST /v1/harvest-batches': {
    as: 'altos_enologa',
    url: '/v1/harvest-batches',
    body: { terroirId: altosTerroir.id, intakeDate: '2026-09-25', harvestYear: 2026, grossWeightKg: 5200, tareWeightKg: 100, brixDegrees: 24, initialPh: 3.5, initialAcidityGl: 6 },
    status: 201,
  },
  'GET /v1/harvest-batches': { as: 'altos_enologa', url: '/v1/harvest-batches', status: 200 },
  'GET /v1/harvest-batches/{id}': { as: 'altos_enologa', url: `/v1/harvest-batches/${altosHarvest.id}`, status: 200 },
  'PATCH /v1/harvest-batches/{id}/phyto-status': {
    as: 'altos_agronomo',
    url: `/v1/harvest-batches/${altosHarvest.id}/phyto-status`,
    body: { phytosanitaryStatus: 'APPROVED' },
    status: 200,
  },
  'POST /v1/fermentation-tanks': { as: 'altos_enologa', url: '/v1/fermentation-tanks', body: { harvestBatchId: altosHarvest.id, tankCode: 'TK-C1', startDate: '2026-09-25' }, status: 201 },
  'GET /v1/fermentation-tanks': { as: 'altos_enologa', url: '/v1/fermentation-tanks', status: 200 },
  'GET /v1/fermentation-tanks/{id}': { as: 'altos_enologa', url: `/v1/fermentation-tanks/${altosTank.id}`, status: 200 },
  'POST /v1/fermentation-tanks/{id}/logs': {
    as: 'altos_enologa',
    url: `/v1/fermentation-tanks/${altosTank.id}/logs`,
    body: { temperatureCelsius: 22.4, recordedAt: '2026-09-26T08:00:00Z' },
    status: 201,
  },
  'POST /v1/fermentation-tanks/{id}/treatments': {
    as: 'altos_enologa',
    url: `/v1/fermentation-tanks/${altosTank.id}/treatments`,
    body: { treatmentType: 'SO2_ADDITION', additiveName: 'Metabisulfito', dosageAppliedGPerHl: 30, regulatoryAuthCode: 'SENASAG-1', appliedAt: '2026-09-25' },
    status: 201,
  },
  'POST /v1/wine-aging': { as: 'altos_enologa', url: '/v1/wine-aging', body: { fermentationTankId: altosTank.id, containerType: 'Barrica', plannedMonths: 12 }, status: 201 },
  'GET /v1/wine-aging': { as: 'altos_enologa', url: '/v1/wine-aging', status: 200 },
  'GET /v1/wine-aging/{id}': { as: 'altos_enologa', url: `/v1/wine-aging/${altosAging.id}`, status: 200 },
  'POST /v1/production-batches/distillation': {
    as: 'cvj_enologa',
    url: '/v1/production-batches/distillation',
    body: { fermentationTankId: cintiTank.id, equipmentIdentifier: 'AL-01', processStartDate: '2026-09-25' },
    status: 201,
  },
  'GET /v1/production-batches/{id}/rest-status': { as: 'cvj_enologa', url: `/v1/production-batches/${readyProduction.id}/rest-status`, status: 200 },
  'GET /v1/production-batches/{id}': { as: 'cvj_enologa', url: `/v1/production-batches/${readyProduction.id}`, status: 200 },
  'GET /v1/production-batches': { as: 'cvj_enologa', url: '/v1/production-batches', status: 200 },
  'POST /v1/bottling': {
    as: 'cvj_enologa',
    url: '/v1/bottling',
    body: { productionBatchId: readyProduction.id, productType: 'SINGANI', finalAlcoholAbv: 40, waterDilutionLiters: 300, totalBottlesPackaged: 1000, packagingFormatCl: 75, bottlingDate: '2026-09-25' },
    status: 201,
  },
  'GET /v1/bottling': { as: 'cvj_enologa', url: '/v1/bottling', status: 200 },
  'GET /v1/bottling/{id}': { as: 'admin', url: `/v1/bottling/${bottlingWithLab.id}`, status: 200 },
  'POST /v1/lab-analyses': {
    // Plataforma sobre una bodega: `?wineryId=` obligatorio en las escrituras (OP-07).
    as: 'admin',
    url: `/v1/lab-analyses?wineryId=${bottlingWithoutLab.wineryId}`,
    body: {
      bottlingBatchId: bottlingWithoutLab.id,
      certifiedLaboratoryName: 'Laboratorio Tarija',
      accreditedLabCertificationCode: 'LAB-1',
      testPerformedAt: '2026-09-26',
      actualAlcoholAbv: 13.5,
      totalAcidityTartaricGl: 5,
      volatileAcidityAceticGl: 0.4,
      laboratoryReportPdfUrl: '/mocks/uploads/lab-reports/x.pdf',
    },
    status: 201,
  },
  'GET /v1/lab-analyses/batch/{bottlingBatchId}': { as: 'admin', url: `/v1/lab-analyses/batch/${bottlingWithLab.id}`, status: 200 },
  'GET /v1/traceability/dag/{bottlingBatchId}': { as: 'admin', url: `/v1/traceability/dag/${bottlingWithLab.id}`, status: 200 },
  'GET /v1/traceability/public/{lotCode}': { url: `/v1/traceability/public/${bottlingWithLab.internationalLotCode}`, status: 200 },
  'POST /v1/uploads': {
    as: 'altos_enologa',
    url: '/v1/uploads?folder=inspections',
    form: () => {
      const form = new FormData()
      form.append('file', new File([new Uint8Array([37, 80, 68, 70])], 'acta.pdf', { type: 'application/pdf' }))
      return form
    },
    status: 201,
  },
}

// ---------------------------------------------------------------------------
// Ola 1 (plan/contratos/o1-backoffice-y-bodegas.md)
// ---------------------------------------------------------------------------

const app = (key: string) => uid(`application:${key}`)
const invitation = (key: string) => uid(`invitation:${key}`)
const member = (userKey: string, wineryKey: string) =>
  F.wineries.find((w) => w.id === uid(`winery:${wineryKey}`))!.members!.find((m) => m.userId === uid(`user:${userKey}`))!.id
const platformMembership = (userKey: string) => uid(`membership:platform:${uid(`user:${userKey}`)}`)
const PADCAYA = F.wineries.find((w) => w.commercialName === 'Bodega Sol de Padcaya')!
const REASON = 'Prueba de contrato de la Ola 1'

async function post(path: string, body: unknown, as?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (as) headers.Authorization = `Bearer mock.access.${as}`
  const res = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, data: text ? ((JSON.parse(text) as { data: Record<string, unknown> }).data ?? {}) : {} }
}

/** `mfaToken` del login de una persona de plataforma. */
async function mfaToken(email: string): Promise<string> {
  const { data } = await post('/v1/auth/login', { email, password: 'demo1234' })
  return (data.mfa as { mfaToken: string }).mfaToken
}

const OLA1_SAMPLES: Record<string, Sample> = {
  // Cuenta y segundo factor
  'POST /v1/auth/mfa/verify': {
    url: '/v1/auth/mfa/verify',
    setup: async () => ({ mfaToken: await mfaToken('gestor@drinksonchain.test') }),
    body: (v: Vars) => ({ mfaToken: v.mfaToken, code: generateTotp(DEMO_TOTP_SECRET) }),
    status: 200,
  },
  'POST /v1/auth/mfa/enroll': {
    url: '/v1/auth/mfa/enroll',
    setup: async () => ({ mfaToken: await mfaToken('analista@drinksonchain.test') }),
    body: (v: Vars) => ({ mfaToken: v.mfaToken }),
    status: 200,
  },
  'POST /v1/auth/mfa/enroll/confirm': {
    url: '/v1/auth/mfa/enroll/confirm',
    setup: async () => {
      const token = await mfaToken('analista@drinksonchain.test')
      const { data } = await post('/v1/auth/mfa/enroll', { mfaToken: token })
      return { mfaToken: token, secret: data.secret as string }
    },
    body: (v: Vars) => ({ mfaToken: v.mfaToken, code: generateTotp(v.secret!) }),
    status: 200,
  },
  'POST /v1/auth/forgot-password': {
    url: '/v1/auth/forgot-password',
    body: { email: 'admin@altos.test', captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' },
    status: 202,
  },
  'POST /v1/auth/reset-password': {
    url: '/v1/auth/reset-password',
    setup: async () => {
      await post('/v1/auth/forgot-password', { email: 'admin@altos.test', captchaToken: 'ok' })
      return { token: mockMailbox.latest({ to: 'admin@altos.test', template: 'PASSWORD_RESET' })!.token! }
    },
    body: (v: Vars) => ({ token: v.token, password: DEMO_NEW_PASSWORD }),
    status: 204,
  },
  'POST /v1/auth/resend-verification': {
    url: '/v1/auth/resend-verification',
    body: { email: 'maria@tribu.test', captchaToken: 'ok' },
    status: 202,
  },
  'POST /v1/auth/verify-email': {
    url: '/v1/auth/verify-email',
    setup: async () => {
      await post('/v1/auth/resend-verification', { email: 'maria@tribu.test', captchaToken: 'ok' })
      return { token: mockMailbox.latest({ to: 'maria@tribu.test', template: 'EMAIL_VERIFY' })!.token! }
    },
    body: (v: Vars) => ({ token: v.token }),
    status: 204,
  },
  'POST /v1/users/me/password': {
    as: 'altos_admin',
    url: '/v1/users/me/password',
    body: { currentPassword: 'demo1234', newPassword: DEMO_NEW_PASSWORD },
    status: 204,
  },
  'POST /v1/platform/users/{membershipId}/reset-mfa': {
    as: 'bo_admin',
    url: `/v1/platform/users/${platformMembership('operaciones')}/reset-mfa`,
    body: { reason: REASON },
    status: 200,
  },
  // Invitaciones
  'GET /v1/invitations/{token}': { url: '/v1/invitations/demo-invitacion-padcaya', status: 200 },
  'POST /v1/invitations/{token}/accept': {
    url: '/v1/invitations/demo-invitacion-padcaya/accept',
    body: { fullName: 'Gabriela Ríos', password: DEMO_NEW_PASSWORD },
    status: 200,
  },
  'POST /v1/invitations/{id}/resend': {
    as: 'operaciones',
    url: `/v1/invitations/${invitation('guadalquivir-owner')}/resend`,
    body: { reason: REASON },
    status: 200,
  },
  'POST /v1/invitations/{id}/revoke': { as: 'altos_admin', url: `/v1/invitations/${invitation('altos-enologo')}/revoke`, body: {}, status: 200 },
  'GET /v1/organizations/current/invitations': { as: 'altos_admin', url: '/v1/organizations/current/invitations', status: 200 },
  'POST /v1/organizations/current/invitations': {
    as: 'altos_admin',
    url: '/v1/organizations/current/invitations',
    body: { email: 'nuevo@altos.test', role: 'OPERATOR' },
    status: 201,
  },
  // Solicitudes
  'POST /v1/public/winery-applications': {
    url: '/v1/public/winery-applications',
    body: {
      legalName: 'Bodega Contrato S.R.L.',
      tradeName: 'Bodega Contrato',
      taxId: '7123456789',
      category: 'WINERY',
      region: 'Valle Central de Tarija · San Lorenzo',
      contactName: 'Persona de Contrato',
      contactEmail: 'contrato@bodega.test',
      captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
      website: '',
    },
    status: 202,
  },
  'POST /v1/public/winery-applications/verify': {
    url: '/v1/public/winery-applications/verify',
    body: { token: 'demo-verificacion-alto-camargo' },
    status: 204,
  },
  'GET /v1/platform/winery-applications': { as: 'soporte', url: '/v1/platform/winery-applications', status: 200 },
  'GET /v1/platform/winery-applications/{id}': { as: 'soporte', url: `/v1/platform/winery-applications/${app('tierra-cintis')}`, status: 200 },
  'POST /v1/platform/winery-applications/{id}/take': { as: 'operaciones', url: `/v1/platform/winery-applications/${app('andina')}/take`, body: {}, status: 200 },
  'POST /v1/platform/winery-applications/{id}/notes': {
    as: 'operaciones',
    url: `/v1/platform/winery-applications/${app('tierra-cintis')}/notes`,
    body: { text: 'Nota de la prueba de contrato' },
    status: 200,
  },
  'POST /v1/platform/winery-applications/{id}/schedule-meeting': {
    as: 'operaciones',
    url: `/v1/platform/winery-applications/${app('tierra-cintis')}/schedule-meeting`,
    body: { scheduledAt: '2026-10-01T15:00:00Z', channel: 'CALL' },
    status: 200,
  },
  'POST /v1/platform/winery-applications/{id}/meeting-done': {
    as: 'operaciones',
    url: `/v1/platform/winery-applications/${app('angostura')}/meeting-done`,
    body: { notes: 'Reunión hecha: interesados en la preventa.' },
    status: 200,
  },
  'POST /v1/platform/winery-applications/{id}/approve': {
    as: 'operaciones',
    url: `/v1/platform/winery-applications/${app('tierra-cintis')}/approve`,
    body: {},
    status: 200,
  },
  'POST /v1/platform/winery-applications/{id}/reject': {
    as: 'operaciones',
    url: `/v1/platform/winery-applications/${app('tierra-cintis')}/reject`,
    body: { reason: 'Falta el padrón de viñedos' },
    status: 200,
  },
  // Bodegas
  'POST /v1/platform/wineries': {
    as: 'operaciones',
    url: '/v1/platform/wineries',
    body: {
      legalName: 'Alta Directa S.R.L.',
      tradeName: 'Bodega Alta Directa',
      taxId: '7234567890',
      category: 'DISTILLERY',
      region: 'Valle de Cinti · Camargo',
      contactEmail: 'hola@altadirecta.test',
      ownerEmail: 'duena@altadirecta.test',
      ownerFullName: 'Dueña de Alta Directa',
    },
    status: 201,
  },
  'GET /v1/platform/wineries': { as: 'soporte', url: '/v1/platform/wineries?status=ACTIVE', status: 200 },
  'GET /v1/platform/wineries/{id}': { as: 'soporte', url: `/v1/platform/wineries/${ALTOS.id}`, status: 200 },
  'PATCH /v1/platform/wineries/{id}': {
    as: 'operaciones',
    url: `/v1/platform/wineries/${ALTOS.id}`,
    body: { address: 'Camino a Calamuchita km 9,5', reason: REASON },
    status: 200,
  },
  'POST /v1/platform/wineries/{id}/suspend': { as: 'operaciones', url: `/v1/platform/wineries/${ALTOS.id}/suspend`, body: { reason: REASON }, status: 200 },
  'POST /v1/platform/wineries/{id}/reactivate': { as: 'operaciones', url: `/v1/platform/wineries/${URIONDO.id}/reactivate`, body: { reason: REASON }, status: 200 },
  'POST /v1/platform/wineries/{id}/revoke': { as: 'bo_admin', url: `/v1/platform/wineries/${PADCAYA.id}/revoke`, body: { reason: REASON }, status: 200 },
  'POST /v1/platform/wineries/{id}/transfer-ownership': {
    as: 'bo_admin',
    url: `/v1/platform/wineries/${ALTOS.id}/transfer-ownership`,
    body: { newOwnerEmail: 'enologa@altos.test', reason: REASON, keepPreviousOwnerAs: 'ENOLOGIST' },
    status: 200,
  },
  'GET /v1/organizations/current': { as: 'altos_enologa', url: '/v1/organizations/current', status: 200 },
  'PATCH /v1/organizations/current': {
    as: 'altos_admin',
    url: '/v1/organizations/current',
    body: { publicStory: 'Historia de la prueba de contrato.' },
    status: 200,
  },
  'GET /v1/public/wineries/{slug}': { url: '/v1/public/wineries/altos-de-calamuchita', status: 200 },
  // Equipo
  'GET /v1/organizations/current/members': { as: 'altos_admin', url: '/v1/organizations/current/members', status: 200 },
  'PATCH /v1/organizations/current/members/{membershipId}': {
    as: 'altos_admin',
    url: `/v1/organizations/current/members/${member('altos_operario', 'altos')}`,
    body: { role: 'ACCOUNTANT' },
    status: 200,
  },
  'POST /v1/organizations/current/members/{membershipId}/block': {
    as: 'altos_admin',
    url: `/v1/organizations/current/members/${member('altos_operario', 'altos')}/block`,
    body: { reason: 'Vacaciones' },
    status: 200,
  },
  'POST /v1/organizations/current/members/{membershipId}/unblock': {
    as: 'altos_admin',
    url: `/v1/organizations/current/members/${member('ines', 'altos')}/unblock`,
    body: {},
    status: 200,
  },
  'GET /v1/platform/organizations/{organizationId}/members': { as: 'soporte', url: `/v1/platform/organizations/${CINTI.id}/members`, status: 200 },
  'PATCH /v1/platform/organizations/{organizationId}/members/{membershipId}': {
    as: 'soporte',
    url: `/v1/platform/organizations/${CINTI.id}/members/${member('cvj_operario', 'cintiviejo')}`,
    body: { role: 'AGRONOMIST', reason: REASON },
    status: 200,
  },
  'POST /v1/platform/organizations/{organizationId}/members/{membershipId}/block': {
    as: 'soporte',
    url: `/v1/platform/organizations/${CINTI.id}/members/${member('cvj_operario', 'cintiviejo')}/block`,
    body: { reason: REASON },
    status: 200,
  },
  'POST /v1/platform/organizations/{organizationId}/members/{membershipId}/unblock': {
    as: 'soporte',
    url: `/v1/platform/organizations/${CINTI.id}/members/${member('cvj_contable', 'cintiviejo')}/unblock`,
    body: { reason: REASON },
    status: 200,
  },
  'POST /v1/platform/organizations/{organizationId}/invitations': {
    as: 'soporte',
    url: `/v1/platform/organizations/${ALTOS.id}/invitations`,
    body: { email: 'bodega@altos.test', role: 'OPERATOR', reason: REASON },
    status: 201,
  },
  // Usuarios internos
  'GET /v1/platform/users': { as: 'bo_admin', url: '/v1/platform/users', status: 200 },
  'POST /v1/platform/users': {
    as: 'bo_admin',
    url: '/v1/platform/users',
    body: { email: 'soporte3@drinksonchain.test', role: 'SUPPORT' },
    status: 201,
  },
  'PATCH /v1/platform/users/{membershipId}': {
    as: 'bo_admin',
    url: `/v1/platform/users/${platformMembership('soporte')}`,
    body: { role: 'OPERATIONS', reason: REASON },
    status: 200,
  },
  'POST /v1/platform/users/{membershipId}/block': {
    as: 'bo_admin',
    url: `/v1/platform/users/${platformMembership('soporte')}/block`,
    body: { reason: REASON },
    status: 200,
  },
  'POST /v1/platform/users/{membershipId}/unblock': {
    as: 'bo_admin',
    url: `/v1/platform/users/${platformMembership('operaciones')}/unblock`,
    setup: async () => {
      await post(`/v1/platform/users/${platformMembership('operaciones')}/block`, { reason: REASON }, 'bo_admin')
      return {}
    },
    body: { reason: REASON },
    status: 200,
  },
  'POST /v1/platform/accounts/{userId}/block': {
    as: 'bo_admin',
    url: `/v1/platform/accounts/${maria.id}/block`,
    body: { reason: REASON },
    status: 200,
  },
  'POST /v1/platform/accounts/{userId}/unblock': {
    as: 'bo_admin',
    url: `/v1/platform/accounts/${maria.id}/unblock`,
    setup: async () => {
      await post(`/v1/platform/accounts/${maria.id}/block`, { reason: REASON }, 'bo_admin')
      return {}
    },
    body: { reason: REASON },
    status: 200,
  },
  'POST /v1/platform/users/{userId}/send-password-reset': {
    as: 'soporte',
    url: `/v1/platform/users/${uid('user:altos_admin')}/send-password-reset`,
    body: {},
    status: 202,
  },
  'GET /v1/platform/permissions': { as: 'soporte', url: '/v1/platform/permissions', status: 200 },
  // Configuración
  'GET /v1/platform/settings': { as: 'soporte', url: '/v1/platform/settings', status: 200 },
  'PUT /v1/platform/settings/{key}': {
    as: 'bo_admin',
    url: '/v1/platform/settings/compra.minutosReserva',
    body: { value: 20, reason: REASON },
    status: 200,
  },
  'GET /v1/platform/settings/{key}/overrides': { as: 'soporte', url: '/v1/platform/settings/compra.maxBotellasPorCompra/overrides', status: 200 },
  'PUT /v1/platform/settings/{key}/overrides': {
    as: 'bo_admin',
    url: '/v1/platform/settings/compra.maxBotellasPorCompra/overrides',
    body: { wineryIds: [ALTOS.id], value: 8, reason: REASON },
    status: 200,
  },
  'POST /v1/platform/settings/{key}/overrides/reset': {
    as: 'bo_admin',
    url: '/v1/platform/settings/compra.maxBotellasPorCompra/overrides/reset',
    body: { wineryIds: 'ALL', reason: REASON },
    status: 200,
  },
  'GET /v1/platform/settings/{key}/history': { as: 'soporte', url: '/v1/platform/settings/canje.ventanaDias/history', status: 200 },
  'GET /v1/organizations/current/settings': { as: 'altos_enologa', url: '/v1/organizations/current/settings', status: 200 },
  // Bitácora y tablero
  'GET /v1/platform/audit': { as: 'soporte', url: '/v1/platform/audit?limit=50', status: 200 },
  'GET /v1/platform/audit/export': { as: 'soporte', url: '/v1/platform/audit/export?from=2026-09-01', status: 200 },
  'GET /v1/platform/audit/verify': { as: 'bo_admin', url: '/v1/platform/audit/verify', status: 200 },
  'GET /v1/organizations/current/audit': { as: 'altos_admin', url: '/v1/organizations/current/audit', status: 200 },
  'GET /v1/platform/dashboard': { as: 'operaciones', url: '/v1/platform/dashboard', status: 200 },
}
Object.assign(SAMPLES, OLA1_SAMPLES)

describe('respuestas de ejemplo ⇄ esquemas de respuesta', () => {
  it('hay una petición de ejemplo por cada RouteSpec', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...routeOps].sort())
  })

  it.each(routeOps)('%s', async (key) => {
    const sample = SAMPLES[key]!
    const method = key.split(' ')[0]!
    const vars = sample.setup ? await sample.setup() : {}
    const headers: Record<string, string> = {}
    if (sample.as) headers.Authorization = `Bearer mock.access.${sample.as}`
    let body: BodyInit | undefined
    const rawBody = typeof sample.body === 'function' ? (sample.body as (v: Vars) => unknown)(vars) : sample.body
    if (sample.form) body = sample.form()
    else if (rawBody !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(rawBody)
    }
    const url = typeof sample.url === 'function' ? sample.url(vars) : sample.url
    const res = await fetch(`${API}${url}`, { method, headers, body })
    const text = await res.text()
    expect(res.status, text).toBe(sample.status)
    const { schema, source } = responseSchema(key, sample.status)
    if (sample.status === 204) {
      expect(text).toBe('')
      return
    }
    if (schema?.$csv) {
      expect(res.headers.get('content-type')).toMatch(/^text\/csv/)
      expect(text.split('\r\n')[0]).toMatch(/^seq,occurredAt,/)
      return
    }
    const envelope = JSON.parse(text) as { success: boolean; data: unknown }
    expect(envelope.success).toBe(true)
    if (!schema) return // el OpenAPI no declara esquema (docs/CONTRATO.md punto 4)
    expectValid(schema, envelope.data, `${key} ⇄ ${source}`)
  })

  it('las operaciones sin esquema de respuesta en el OpenAPI están identificadas', () => {
    const withoutSchema = routeOps.filter((key) => {
      const sample = SAMPLES[key]!
      return sample.status !== 204 && !responseSchema(key, sample.status).schema
    })
    expect(withoutSchema.sort()).toEqual(
      [
        'GET /v1/production-batches/{id}/rest-status',
        'GET /v1/traceability/dag/{bottlingBatchId}',
        'GET /v1/traceability/public/{lotCode}',
        'POST /v1/fermentation-tanks/{id}/logs',
        'POST /v1/fermentation-tanks/{id}/treatments',
      ].sort(),
    )
  })
})
