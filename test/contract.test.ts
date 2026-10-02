import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as pkg from '../src'
import { backofficeFixtures, DEMO_NEW_PASSWORD, DEMO_TOTP_SECRET, erpFixtures, generateTotp, publicFixtures, SINGANI_CASE } from '../src/fixtures'
import { COLLECTIONS_DRAFT_CONTRACT, MOCK_ROUTE_SPECS, mockMailbox, resetScenario, setScenario } from '../src/handlers'
import { resetErpDb, setupMockServer } from '../src/node'
import type { ErpDb } from '../src/erp/handlers/db'
import { logView, treatmentView } from '../src/erp/handlers/views'
import { uid } from '../src/shared/uuid'
import { API } from './helpers'

// Prueba de contrato (plan/04 §4): los mocks frente a openapi/erp.json.
// 1. Cada RouteSpec existe en el OpenAPI o está en openapi/pendientes.json como «adelantada»
//    por un contrato de ola; cada operación del OpenAPI tiene su RouteSpec.
// 2. Cada fixture con DTO valida contra su esquema del OpenAPI (Ajv).
// 3. Cada operación se ejecuta con una petición de ejemplo y su respuesta valida contra el
//    esquema del OpenAPI (o el de pendientes.json cuando el contrato de ola lo cambia).
//
// Validación estricta (docs/CONTRATO.md §5): desde la Ola 1 el OpenAPI del backend declara
// `nullable` en cada campo que puede ser `null`, así que un `null` solo vale donde el DTO lo dice
// y un campo opcional se omite (no se manda `null`). Normalización mínima de lo que genera NestJS:
// - `{ type: 'object' }` sin propiedades (solo quedan en DTO de entrada) → tipo del `example`;
// - `nullable` + `allOf: [ref]` (relación opcional) → `anyOf: [ref, null]`;
// - ningún objeto admite campos que el DTO no declare (`additionalProperties: false`), salvo los
//   `camposExtra` de pendientes.json: así un campo renombrado rompe la prueba.

const root = join(import.meta.dirname, '..')
/** Base con los fixtures, para convertir las filas de la semilla en respuestas. */
const fixtureDb = { wineries: erpFixtures.wineries, tanks: erpFixtures.fermentationTanks } as unknown as ErpDb
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
  /** Borrador que no implementa el backend en esta ola: fuera de la comparación con el OpenAPI. */
  borrador?: boolean
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
    return obj
  }
  const out = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalize(v)])) as Json
  // `nullable` + `allOf: [ref]` (relación opcional de NestJS): el `allOf` no admitiría `null`.
  if (out.nullable === true && Array.isArray(out.allOf)) {
    const rest = Object.fromEntries(Object.entries(out).filter(([k]) => !['nullable', 'type', 'allOf'].includes(k)))
    return { ...rest, anyOf: [...(out.allOf as Json[]), { type: 'null' }] }
  }
  // `nullable` + `oneOf` sin `type` (valor de un parámetro de configuración): `null` es otra opción.
  if (out.nullable === true && !('type' in out) && Array.isArray(out.oneOf)) {
    out.oneOf = [...(out.oneOf as Json[]), { type: 'null' }]
    delete out.nullable
  }
  if (Array.isArray(out.enum) && out.nullable === true && !out.enum.includes(null)) out.enum = [...(out.enum as unknown[]), null]
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
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
  const content = spec.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)]?.content
  // Una operación que solo responde CSV se comprueba por su cabecera; con JSON y CSV, por el JSON.
  if (content?.['text/csv'] && !content['application/json']) return { schema: { $csv: true }, source: 'openapi/erp.json' }
  return { schema: content?.['application/json']?.schema ?? null, source: 'openapi/erp.json' }
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

  it('las rutas obsoletas son las del OpenAPI (y su sustituta, la de x-replaced-by si la declara): las tres legadas que se retiran en H2', () => {
    type Op = { deprecated?: boolean; 'x-replaced-by'?: string }
    const inSpec = Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.entries(ops as Record<string, Op>)
        .filter(([, op]) => op.deprecated)
        .map(([m, op]) => [opKey(m, p), op['x-replaced-by']] as const),
    )
    const inMocks = new Map(MOCK_ROUTE_SPECS.filter((r) => r.deprecated).map((r) => [opKey(r.method, r.path), r.deprecated] as const))
    expect([...inMocks.keys()].sort()).toEqual(inSpec.map(([op]) => op).sort())
    for (const [op, replacedBy] of inSpec) if (replacedBy) expect(inMocks.get(op), op).toBe(replacedBy)
    // El OpenAPI de la apertura de la Ola 2 las marca `deprecated` sin `x-replaced-by`: la sustituta es la del contrato §16.2.
    expect(Object.fromEntries(inMocks)).toEqual({
      'PATCH /v1/harvest-batches/{id}/phyto-status': '/v1/harvest-batches/{id}/phyto-decisions',
      'GET /v1/traceability/dag/{bottlingBatchId}': '/v1/lots/{id}/graph',
      'GET /v1/traceability/public/{lotCode}': '/v1/public/passports/{code}',
    })
  })

  it('lo retirado en H1 no está en el OpenAPI ni en los mocks', () => {
    const retired = [
      'POST /v1/wineries',
      'GET /v1/wineries/pending',
      'POST /v1/wineries/{id}/approve',
      'POST /v1/wineries/{id}/reject',
      'GET /v1/wineries/my/members',
      'POST /v1/wineries/my/members',
      'POST /v1/wineries/my/members/create',
    ]
    expect(retired.filter((op) => openApiOps.has(op) || routeOps.includes(op))).toEqual([])
    const props = (name: string) => Object.keys((spec.components.schemas[name]?.properties as Json | undefined) ?? {})
    expect(props('AuthTokensDto')).not.toContain('refreshToken')
    for (const name of ['AuthUserDto', 'MeUserDto']) {
      expect(props(name).filter((p) => ['userRole', 'wineryId', 'memberRole'].includes(p))).toEqual([])
    }
    expect(props('SignupDto')).not.toContain('userRole')
    expect(props('SwitchOrganizationDto')).toEqual(['organizationId'])
  })

  it('pendientes.json: las adelantadas aún no están en el OpenAPI (si llegan, se borran de aquí) y los cambios sí', () => {
    expect([...ahead.keys()].filter((op) => openApiOps.has(op))).toEqual([])
    expect([...changed.keys()].filter((op) => !openApiOps.has(op))).toEqual([])
    expect([...ahead.keys(), ...changed.keys()].filter((op) => !routeOps.includes(op))).toEqual([])
  })

  it('los borradores fuera del OpenAPI están declarados en la ruta y en pendientes.json (catálogo, contrato de la Ola 2 §17.1)', () => {
    // Exclusión explícita de la prueba estricta: el backend no implementa el catálogo en esta ola,
    // así que estas rutas solo se validan contra el esquema zod de los mocks (`$zod`).
    const drafts = MOCK_ROUTE_SPECS.filter((r) => r.draft).map((r) => opKey(r.method, r.path)).sort()
    expect(drafts).toEqual(['GET /v1/public/collections', 'GET /v1/public/collections/{slug}'])
    expect(pending.adelantadas.filter((e) => e.borrador).map((e) => opKey(e.method, e.path)).sort()).toEqual(drafts)
    for (const r of MOCK_ROUTE_SPECS.filter((x) => x.draft)) {
      expect(r.draft).toBe(COLLECTIONS_DRAFT_CONTRACT)
      expect(ahead.get(opKey(r.method, r.path))?.contrato).toBe(COLLECTIONS_DRAFT_CONTRACT)
      expect(openApiOps.has(opKey(r.method, r.path))).toBe(false)
    }
    // Todo lo demás es del OpenAPI: no queda ninguna otra operación adelantada.
    expect(pending.adelantadas.filter((e) => !e.borrador)).toEqual([])
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
  // `user` de `GET /v1/users/me`: sin `_mock` (credencial de demo) y con la audiencia de la sesión.
  [
    'users.json',
    erpFixtures.users.map(({ _mock: meta, ...user }) => ({ ...user, audience: erpFixtures.authLogin[meta.key]!.user.audience })),
    'MeUserDto',
  ],
  ['wallets.json', erpFixtures.wallets, 'WalletResponseDto'],
  ['auth-login.json', Object.values(erpFixtures.authLogin), 'AuthResponseDto'],
  ['terroirs.json', erpFixtures.terroirs, 'TerroirResponseDto'],
  ['harvest-batches.json', erpFixtures.harvestBatches, 'HarvestBatchResponseDto'],
  ['fermentation-tanks.json', erpFixtures.fermentationTanks, 'FermentationTankResponseDto'],
  // Filas de la semilla (compartidas con la del backend) → respuesta de la API.
  ['fermentation-logs.json', erpFixtures.fermentationLogs.map((l) => logView(l, fixtureDb)), 'FermentationLogResponseDto'],
  ['enological-treatments.json', erpFixtures.enologicalTreatments.map((t) => treatmentView(t, fixtureDb)), 'EnologicalTreatmentResponseDto'],
  ['wine-aging.json', erpFixtures.wineAging, 'WineAgingResponseDto'],
  ['production-batches.json', erpFixtures.productionBatches, 'ProductionBatchResponseDto'],
  ['production-rest-status.json', erpFixtures.productionRestStatus, 'RestStatusResponseDto'],
  ['bottling.json', erpFixtures.bottling, 'BottlingBatchResponseDto'],
  ['lab-analyses.json', erpFixtures.labAnalyses, 'BatchLabAnalysisResponseDto'],
  ['traceability-public.json', Object.values(erpFixtures.traceabilityPublic), 'DagGraphResponseDto'],
  // Lista de espera (contrato O1b): el fixture es la respuesta del back office tal cual.
  ['backoffice/waitlist.json', backofficeFixtures.waitlist, 'WaitlistEntryDto'],
  // Ola 2: lote del servidor y sus colecciones (los eventos y los adjuntos, sin el `lotId` con el que se guardan).
  ['lots.json', erpFixtures.lots, 'LotDto'],
  ['lot-events.json', erpFixtures.lotEvents.map(({ lotId: _lotId, ...event }) => event), 'LotEventDto'],
  ['maturity-analyses.json', erpFixtures.maturityAnalyses, 'MaturityAnalysisResponseDto'],
  ['phyto-decisions.json', erpFixtures.phytoDecisions, 'PhytoDecisionResponseDto'],
  ['corrections.json', erpFixtures.corrections, 'CorrectionDto'],
  ['lot-dossiers.json', erpFixtures.lotDossiers, 'LotDossierDto'],
  ['public/passports.json', Object.values(publicFixtures.passports), 'PublicLotPassportDto'],
  ['public/wineries.json', publicFixtures.wineries, 'PublicWineryProfileDto'],
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
  resetScenario()
})
afterAll(() => server.close())

const F = erpFixtures
const winery = (name: string) => F.wineries.find((w) => w.commercialName === name)!
const ALTOS = winery('Bodega Altos de Calamuchita')
const CINTI = winery('Destilería Cinti Viejo')
const URIONDO = winery('Casa Uriondo')
const altosTerroir = F.terroirs.find((t) => t.wineryId === ALTOS.id && t.altitudeMasl >= 1600)!
const altosHarvest = F.harvestBatches.find((h) => h.wineryId === ALTOS.id)!
/** Pesaje de Altos aún sin dictamen (y sin tanque). */
const altosPendingHarvest = F.harvestBatches.find((h) => h.wineryId === ALTOS.id && h.phytosanitaryStatus === 'PENDING_INSPECTION')!
/** Tanque de Altos en fermentación (TK-04, destino vino). */
const altosTank = F.fermentationTanks.find((t) => t.wineryId === ALTOS.id && t.status === 'FERMENTING')!
const altosTransferredTank = F.fermentationTanks.find((t) => t.wineryId === ALTOS.id && t.status === 'TRANSFERRED')!
const altosAging = F.wineAging.find((a) => a.wineryId === ALTOS.id && a.agingStatus === 'AGING')!
const cintiTank = F.fermentationTanks.find((t) => t.wineryId === CINTI.id)!
const restingProduction = F.productionBatches.find((p) => p.restStatus === 'RESTING')!
/** Destilación abierta de «Singani El Molino 2026» (5.800 L de entrada). */
const openProduction = F.productionBatches.find((p) => p.wineryId === CINTI.id && !p.processEndDate)!
const bottlingWithLab = F.bottling.find((b) => F.labAnalyses.some((l) => l.bottlingBatchId === b.id))!
const bottlingWithoutLab = F.bottling.find((b) => !F.labAnalyses.some((l) => l.bottlingBatchId === b.id))!
const maria = F.users.find((u) => u._mock.key === 'maria')!

// Ola 2: lotes de los fixtures que sirven de ejemplo.
const lotBy = (pick: (l: (typeof F.lots)[number]) => boolean) => F.lots.find(pick)!
/** Caso del contrato §18: «Singani Gran Reserva 2026», certificado, 2.950 botellas. */
const CASE = lotBy((l) => l.id === SINGANI_CASE.lotId)
const originLot = lotBy((l) => l.stage === 'ORIGIN')
const distillingLot = lotBy((l) => l.stage === 'DISTILLING')
/** Lote migrado en reposo de Cinti Viejo (dos destilaciones abiertas). */
const restingLot = lotBy((l) => l.wineryId === CINTI.id && l.stage === 'RESTING')
/** Embotellado con laboratorio conforme y sin expediente: listo para cerrar. */
const readyToCloseLot = lotBy((l) => l.wineryId === CINTI.id && l.stage === 'BOTTLED' && l.labStatus === 'CONFORMING')
/** Embotellado sin laboratorio. */
const bottledWithoutLabLot = lotBy((l) => l.wineryId === CINTI.id && l.stage === 'BOTTLED' && l.labStatus === 'NOT_RECORDED')
const cintiPendingHarvest = F.harvestBatches.find((h) => h.wineryId === CINTI.id && h.phytosanitaryStatus === 'PENDING_INSPECTION' && h.lotId !== null)!
const unassignedHarvest = F.harvestBatches.find((h) => h.lotId === null)!
const caseCodes = publicFixtures.bottleCodes.find((b) => b.lotId === CASE.id)!
const caseLabel = F.lotAttachments.find((a) => a.lotId === CASE.id && a.visibility === 'PUBLIC')!
const anotherBottledCode = publicFixtures.bottleCodes.find((b) => b.lotId === readyToCloseLot.id)!.codes[0]!.code
const cintiFile = (folder: string, name: string) => `org/${CINTI.id}/${folder}/2026/09/${name}`
const BOTTLING_2950 = { bottlingDate: '2026-09-25', packagingFormatCl: 75, totalBottlesPackaged: 2950, finalAlcoholAbv: 40, waterDilutionLiters: 750 }

type Vars = Record<string, string>

interface Sample {
  /** Clave del usuario (token estático `mock.access.<clave>`); sin ella, petición pública. */
  as?: string
  url: string | ((v: Vars) => string)
  body?: unknown | ((v: Vars) => unknown)
  form?: () => FormData
  /** Cabecera `Cookie` (p. ej. el refresco `doc_rt`, que desde H1 solo viaja ahí). */
  cookie?: string
  status: number
  /** Pasos previos (p. ej. pedir un enlace y leerlo del buzón). */
  setup?: () => Promise<Vars>
  /** Cabecera (primera línea) esperada de una respuesta `text/csv`. */
  csvHeader?: RegExp
  /** Respuesta JSON sin el envoltorio `data` (los bytes canónicos del expediente). */
  raw?: boolean
}

const SAMPLES: Record<string, Sample> = {
  'GET /v1/health': { url: '/v1/health', status: 200 },
  'GET /v1/health/live': { url: '/v1/health/live', status: 200 },
  'GET /v1/health/ready': { url: '/v1/health/ready', status: 200 },
  'POST /v1/auth/signup': { url: '/v1/auth/signup', body: { email: 'contrato@tribu.test', password: 'clave123', fullName: 'Contrato' }, status: 201 },
  'POST /v1/auth/login': { url: '/v1/auth/login', body: { email: 'sofia@aramayo.test', password: 'demo1234' }, status: 200 },
  'POST /v1/auth/refresh': { url: '/v1/auth/refresh', cookie: 'doc_rt=mock.refresh.altos_admin', status: 200 },
  'POST /v1/auth/switch-organization': { as: 'sofia', url: '/v1/auth/switch-organization', body: { organizationId: URIONDO.id }, status: 200 },
  'POST /v1/auth/logout': { as: 'altos_admin', url: '/v1/auth/logout', body: {}, status: 204 },
  'POST /v1/auth/logout-all': { as: 'altos_admin', url: '/v1/auth/logout-all', body: {}, status: 204 },
  'GET /v1/users/me': { as: 'ines', url: '/v1/users/me', status: 200 },
  'PATCH /v1/users/me': { as: 'altos_admin', url: '/v1/users/me', body: { fullName: 'Martín C.' }, status: 200 },
  'GET /v1/users/me/wallet': { as: 'altos_admin', url: '/v1/users/me/wallet', status: 200 },
  'GET /v1/wineries': { as: 'admin', url: '/v1/wineries', status: 200 },
  'GET /v1/wineries/my': { as: 'altos_admin', url: '/v1/wineries/my', status: 200 },
  'PATCH /v1/wineries/my': { as: 'altos_admin', url: '/v1/wineries/my', body: { address: 'Camino a Calamuchita km 9' }, status: 200 },
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
    url: `/v1/harvest-batches/${altosPendingHarvest.id}/phyto-status`,
    body: { phytosanitaryStatus: 'APPROVED' },
    status: 200,
  },
  'POST /v1/fermentation-tanks': {
    as: 'altos_enologa',
    url: '/v1/fermentation-tanks',
    // La uva entra a un tanque con el dictamen aprobado.
    setup: async () => {
      await post(`/v1/harvest-batches/${altosPendingHarvest.id}/phyto-decisions`, { decision: 'APPROVED' }, 'altos_agronomo')
      return {}
    },
    body: { harvestBatchId: altosPendingHarvest.id, tankCode: 'TK-C1', capacityLiters: 6000, volumeFilledLiters: 4100, startDate: '2026-09-25' },
    status: 201,
  },
  'GET /v1/fermentation-tanks': { as: 'altos_enologa', url: '/v1/fermentation-tanks', status: 200 },
  'GET /v1/fermentation-tanks/{id}': { as: 'altos_enologa', url: `/v1/fermentation-tanks/${altosTank.id}`, status: 200 },
  'POST /v1/fermentation-tanks/{id}/logs': {
    as: 'altos_enologa',
    url: `/v1/fermentation-tanks/${altosTank.id}/logs`,
    body: { temperatureCelsius: 22.4, recordedAt: '2026-09-25T08:00:00Z' },
    status: 201,
  },
  'POST /v1/fermentation-tanks/{id}/treatments': {
    as: 'altos_enologa',
    url: `/v1/fermentation-tanks/${altosTank.id}/treatments`,
    body: { treatmentType: 'SO2_ADDITION', additiveName: 'Metabisulfito', dosageAppliedGPerHl: 30, regulatoryAuthCode: 'SENASAG-1', appliedAt: '2026-09-25' },
    status: 201,
  },
  'POST /v1/wine-aging': { as: 'altos_enologa', url: '/v1/wine-aging', body: { fermentationTankId: altosTank.id, containerType: 'Barrica', volumeLiters: 8000, plannedMonths: 12 }, status: 201 },
  'GET /v1/wine-aging': { as: 'altos_enologa', url: '/v1/wine-aging', status: 200 },
  'GET /v1/wine-aging/{id}': { as: 'altos_enologa', url: `/v1/wine-aging/${altosAging.id}`, status: 200 },
  'POST /v1/production-batches/distillation': {
    as: 'cvj_enologa',
    url: '/v1/production-batches/distillation',
    body: { fermentationTankId: cintiTank.id, equipmentIdentifier: 'AL-01', processStartDate: '2026-09-25' },
    status: 201,
  },
  'GET /v1/production-batches/{id}/rest-status': { as: 'cvj_enologa', url: `/v1/production-batches/${restingProduction.id}/rest-status`, status: 200 },
  'GET /v1/production-batches/{id}': { as: 'cvj_enologa', url: `/v1/production-batches/${restingProduction.id}`, status: 200 },
  'GET /v1/production-batches': { as: 'cvj_enologa', url: '/v1/production-batches', status: 200 },
  'POST /v1/bottling': {
    // Ruta legada sobre el caso del §18 con el reposo cumplido (escenario `lote-listo`).
    as: 'cvj_enologa',
    url: '/v1/bottling',
    setup: async () => {
      setScenario('lote-listo')
      const lot = await get(`/v1/lots/${CASE.id}`, 'cvj_enologa')
      return { productionBatchId: (lot.links as { productionBatchIds: string[] }).productionBatchIds[0]! }
    },
    body: (v: Vars) => ({ productionBatchId: v.productionBatchId, productType: 'SINGANI', ...BOTTLING_2950 }),
    status: 201,
  },
  'GET /v1/bottling': { as: 'cvj_enologa', url: '/v1/bottling', status: 200 },
  'GET /v1/bottling/{id}': { as: 'admin', url: `/v1/bottling/${bottlingWithLab.id}`, status: 200 },
  'POST /v1/lab-analyses': {
    // Ruta legada. La plataforma ya no escribe la trazabilidad (S-25): lo registra la enóloga.
    as: 'cvj_enologa',
    url: '/v1/lab-analyses',
    body: {
      bottlingBatchId: bottlingWithoutLab.id,
      certifiedLaboratoryName: 'Laboratorio Tarija',
      accreditedLabCertificationCode: 'LAB-1',
      testPerformedAt: '2026-09-25',
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
  'GET /v1/uploads/url': {
    as: 'altos_enologa',
    url: `/v1/uploads/url?key=${encodeURIComponent(`org/${ALTOS.id}/inspections/2026/09/acta.pdf`)}`,
    status: 200,
  },
}

// ---------------------------------------------------------------------------
// Ola 2 (plan/contratos/o2-erp-confiable.md): lote del servidor, pasaporte público y catálogo
// ---------------------------------------------------------------------------

const OLA2_SAMPLES: Record<string, Sample> = {
  // Lote
  'GET /v1/lots': { as: 'cvj_enologa', url: '/v1/lots?limit=100', status: 200 },
  'POST /v1/lots': {
    as: 'cvj_enologa',
    url: '/v1/lots',
    body: { name: 'Singani de contrato 2026', harvestYear: 2026, productType: 'SINGANI', estimatedBottles: 1200, plannedFormatCl: 75, targetAbvPercent: 40, plannedTerroirIds: [F.terroirs.find((t) => t.wineryId === CINTI.id)!.id] },
    status: 201,
  },
  'GET /v1/lots/{id}': { as: 'cvj_operario', url: `/v1/lots/${CASE.id}`, status: 200 },
  'PATCH /v1/lots/{id}': { as: 'cvj_enologa', url: `/v1/lots/${originLot.id}`, body: { estimatedBottles: 1900, reason: 'Ajuste de la previsión de la vendimia' }, status: 200 },
  'POST /v1/lots/{id}/discard': { as: 'cvj_admin', url: `/v1/lots/${originLot.id}/discard`, body: { reason: 'Se cancela la edición de aniversario' }, status: 200 },
  'GET /v1/lots/{id}/timeline': { as: 'cvj_operario', url: `/v1/lots/${CASE.id}/timeline`, status: 200 },
  'GET /v1/lots/{id}/graph': { as: 'soporte', url: `/v1/lots/${CASE.id}/graph`, status: 200 },
  'GET /v1/lots/{id}/balance': { as: 'cvj_enologa', url: `/v1/lots/${CASE.id}/balance`, status: 200 },
  // Embotellado
  'POST /v1/lots/{id}/bottling/preview': {
    as: 'cvj_enologa',
    url: `/v1/lots/${restingLot.id}/bottling/preview`,
    body: { bottlingDate: '2026-09-25', packagingFormatCl: 75, totalBottlesPackaged: 4000, finalAlcoholAbv: 40, waterDilutionLiters: 1200 },
    status: 200,
  },
  'POST /v1/lots/{id}/bottling': {
    as: 'cvj_enologa',
    url: `/v1/lots/${CASE.id}/bottling`,
    setup: async () => {
      setScenario('lote-listo')
      return {}
    },
    body: BOTTLING_2950,
    status: 201,
  },
  // Códigos de botella
  'GET /v1/lots/{id}/bottle-codes': { as: 'cvj_enologa', url: `/v1/lots/${CASE.id}/bottle-codes?fromSerial=10&toSerial=30`, status: 200 },
  'GET /v1/lots/{id}/bottle-codes/export': {
    as: 'cvj_enologa',
    url: `/v1/lots/${CASE.id}/bottle-codes/export?format=csv&fromSerial=1&toSerial=50`,
    status: 200,
    csvHeader: /^serial,code,codeFormatted,qrUrl,lotCode,lotName,productType,bottlingDate$/,
  },
  'POST /v1/lots/{id}/bottle-codes/exports': {
    as: 'cvj_enologa',
    url: `/v1/lots/${CASE.id}/bottle-codes/exports`,
    body: { format: 'ZIP', fromSerial: 1, toSerial: 500, qr: { imageFormat: 'SVG', sizePx: 512, margin: 2 } },
    status: 202,
  },
  'GET /v1/lots/{id}/bottle-codes/exports/{exportId}': {
    as: 'cvj_enologa',
    setup: async () => {
      const { data } = await post(`/v1/lots/${CASE.id}/bottle-codes/exports`, { format: 'ZIP', qr: { imageFormat: 'PNG' } }, 'cvj_enologa')
      return { exportId: data.exportId as string }
    },
    url: (v: Vars) => `/v1/lots/${CASE.id}/bottle-codes/exports/${v.exportId}`,
    status: 200,
  },
  'POST /v1/bottle-codes/{code}/void': {
    as: 'cvj_enologa',
    url: `/v1/bottle-codes/${anotherBottledCode}/void`,
    body: { reason: 'Etiqueta dañada en el almacén', replace: true },
    status: 200,
  },
  // Laboratorio
  'POST /v1/lots/{id}/lab-analyses': {
    as: 'cvj_enologa',
    url: `/v1/lots/${bottledWithoutLabLot.id}/lab-analyses`,
    body: {
      certifiedLaboratoryName: 'Laboratorio de Servicios Analíticos ISO 17025',
      accreditedLabCertificationCode: 'LAB-SENASAG-2026-901',
      testPerformedAt: '2026-09-25',
      actualAlcoholAbv: 13.8,
      totalAcidityTartaricGl: 5.4,
      volatileAcidityAceticGl: 0.5,
      laboratoryReportKey: cintiFile('lab-reports', 'informe.pdf'),
    },
    status: 201,
  },
  'GET /v1/lots/{id}/lab-analyses': { as: 'cvj_operario', url: `/v1/lots/${CASE.id}/lab-analyses`, status: 200 },
  // Correcciones
  'POST /v1/lots/{id}/corrections': {
    as: 'cvj_operario',
    url: `/v1/lots/${restingLot.id}/corrections`,
    body: {
      target: { type: 'HARVEST_BATCH', id: F.harvestBatches.find((h) => h.lotId === restingLot.id)!.id },
      kind: 'AMEND',
      changes: { temperatureAtIntakeC: 16.4 },
      reason: 'Temperatura mal transcrita en la planilla de recepción',
    },
    status: 201,
  },
  'GET /v1/lots/{id}/corrections': { as: 'cvj_operario', url: `/v1/lots/${CASE.id}/corrections`, status: 200 },
  'POST /v1/terroirs/{id}/corrections': {
    as: 'altos_agronomo',
    url: `/v1/terroirs/${altosHarvest.terroirId}/corrections`,
    body: { changes: { altitudeMasl: 1865 }, reason: 'Altitud corregida con el levantamiento topográfico' },
    status: 201,
  },
  // Expediente
  'GET /v1/lots/{id}/dossier/preview': { as: 'cvj_operario', url: `/v1/lots/${readyToCloseLot.id}/dossier/preview`, status: 200 },
  'POST /v1/lots/{id}/dossier/close': { as: 'cvj_enologa', url: `/v1/lots/${readyToCloseLot.id}/dossier/close`, body: { confirm: true }, status: 200 },
  'GET /v1/lots/{id}/dossier': { as: 'cvj_operario', url: `/v1/lots/${CASE.id}/dossier`, status: 200 },
  'GET /v1/lots/{id}/dossier/canonical': { as: 'cvj_operario', url: `/v1/lots/${CASE.id}/dossier/canonical`, status: 200, raw: true },
  // Archivos del lote
  'POST /v1/lots/{id}/attachments': {
    as: 'cvj_operario',
    url: `/v1/lots/${distillingLot.id}/attachments`,
    body: { key: cintiFile('photos', 'alambique.jpg'), kind: 'PHOTO', title: 'Alambique AL-02 en marcha' },
    status: 201,
  },
  'GET /v1/lots/{id}/attachments': { as: 'cvj_operario', url: `/v1/lots/${CASE.id}/attachments`, status: 200 },
  'POST /v1/lots/{id}/attachments/{attachmentId}/visibility': {
    as: 'cvj_enologa',
    url: `/v1/lots/${CASE.id}/attachments/${caseLabel.id}/visibility`,
    body: { visibility: 'PRIVATE' },
    status: 200,
  },
  // Vendimia: análisis de madurez y dictamen aparte
  'POST /v1/harvest-batches/{id}/maturity-analyses': {
    as: 'cvj_agronomo',
    url: `/v1/harvest-batches/${cintiPendingHarvest.id}/maturity-analyses`,
    body: { brixDegrees: 22.5, ph: 3.5, acidityGl: 6.1, measuredAt: '2026-09-25T10:00:00Z' },
    status: 201,
  },
  'GET /v1/harvest-batches/{id}/maturity-analyses': { as: 'cvj_operario', url: `/v1/harvest-batches/${cintiPendingHarvest.id}/maturity-analyses`, status: 200 },
  'POST /v1/harvest-batches/{id}/phyto-decisions': {
    as: 'cvj_agronomo',
    url: `/v1/harvest-batches/${cintiPendingHarvest.id}/phyto-decisions`,
    body: { decision: 'QUARANTINE', notes: 'Focos de botritis en dos cajas', inspectionReportKey: cintiFile('inspections', 'acta.pdf') },
    status: 201,
  },
  'GET /v1/harvest-batches/{id}/phyto-decisions': { as: 'cvj_operario', url: `/v1/harvest-batches/${F.harvestBatches.find((h) => h.lotId === CASE.id)!.id}/phyto-decisions`, status: 200 },
  // Tanques: transiciones por acciones
  'POST /v1/fermentation-tanks/{id}/start': {
    as: 'cvj_enologa',
    // Uva recibida sin lote → dictamen → tanque (crea su lote) → inicio de la fermentación.
    setup: async () => {
      await post(`/v1/harvest-batches/${unassignedHarvest.id}/phyto-decisions`, { decision: 'APPROVED' }, 'cvj_agronomo')
      const { data } = await post('/v1/fermentation-tanks', { inputs: [{ harvestBatchId: unassignedHarvest.id }], tankCode: 'TK-C2', volumeFilledLiters: 2700, startDate: '2026-09-25' }, 'cvj_enologa')
      return { tankId: data.id as string }
    },
    url: (v: Vars) => `/v1/fermentation-tanks/${v.tankId}/start`,
    body: {},
    status: 200,
  },
  'POST /v1/fermentation-tanks/{id}/complete': {
    as: 'altos_enologa',
    url: `/v1/fermentation-tanks/${altosTank.id}/complete`,
    body: { endDate: '2026-09-25', finalVolumeLiters: 8000, destination: 'WINE_AGING' },
    status: 200,
  },
  'POST /v1/fermentation-tanks/{id}/clean': { as: 'altos_enologa', url: `/v1/fermentation-tanks/${altosTransferredTank.id}/clean`, body: {}, status: 200 },
  // Crianza y destilación
  'POST /v1/wine-aging/{id}/discard': { as: 'altos_enologa', url: `/v1/wine-aging/${altosAging.id}/discard`, body: { reason: 'Barrica contaminada' }, status: 200 },
  'POST /v1/production-batches/{id}/close': {
    as: 'cvj_enologa',
    url: `/v1/production-batches/${openProduction.id}/close`,
    body: { processEndDate: '2026-09-25', cuts: { headsLiters: 60, heartLiters: 720, tailsLiters: 105 }, heartAbvPercent: 61.5 },
    status: 200,
  },
  'POST /v1/production-batches/{id}/discard': { as: 'cvj_enologa', url: `/v1/production-batches/${restingProduction.id}/discard`, body: { reason: 'Corazón turbio tras el reposo' }, status: 200 },
  // Panel y reportes
  'GET /v1/traceability/dashboard': { as: 'cvj_enologa', url: '/v1/traceability/dashboard', status: 200 },
  'GET /v1/traceability/reports/production': { as: 'cvj_admin', url: '/v1/traceability/reports/production?from=2025-01-01&to=2026-12-31', status: 200 },
  // Público
  'GET /v1/public/passports/{code}': { url: `/v1/public/passports/${caseCodes.codes[0]!.code}`, status: 200 },
  'GET /v1/public/lots/{lotCode}': { url: `/v1/public/lots/${CASE.lotCode}`, status: 200 },
  'GET /v1/public/bottles/{code}': { url: `/v1/public/bottles/${caseCodes.codes.at(-1)!.code}`, status: 200 },
  'GET /v1/public/lots/{lotCode}/dossier': { url: `/v1/public/lots/${CASE.lotCode}/dossier`, status: 200, raw: true },
  'GET /v1/public/lots/{lotCode}/attachments/{attachmentId}': { url: `/v1/public/lots/${CASE.lotCode}/attachments/${caseLabel.id}`, status: 302 },
  'GET /v1/public/wineries': { url: '/v1/public/wineries?region=cinti', status: 200 },
  // Borrador del catálogo (§17.1): fuera del OpenAPI; se valida con el esquema zod de pendientes.json.
  'GET /v1/public/collections': { url: '/v1/public/collections?productType=SINGANI', status: 200 },
  'GET /v1/public/collections/{slug}': { url: '/v1/public/collections/singani-gran-reserva-2026', status: 200 },
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

/** `data` de un GET con el token estático de un usuario. */
async function get(path: string, as: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer mock.access.${as}` } })
  return ((await res.json()) as { data: Record<string, unknown> }).data
}

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
    // Altos: sin límite de colaboradores (Cinti Viejo está lleno: desbloquear → 422).
    url: `/v1/platform/organizations/${ALTOS.id}/members/${member('ines', 'altos')}/unblock`,
    body: { reason: REASON },
    status: 200,
  },
  'GET /v1/platform/organizations/{organizationId}/invitations': {
    as: 'soporte',
    url: `/v1/platform/organizations/${ALTOS.id}/invitations?status=PENDING`,
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
  'GET /v1/platform/accounts/{userId}': { as: 'soporte', url: `/v1/platform/accounts/${uid('user:sofia')}`, status: 200 },
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
  'GET /v1/platform/audit/export': { as: 'soporte', url: '/v1/platform/audit/export?from=2026-09-01', status: 200, csvHeader: /^seq,occurredAt,/ },
  'GET /v1/platform/audit/verify': { as: 'bo_admin', url: '/v1/platform/audit/verify', status: 200 },
  'GET /v1/organizations/current/audit': { as: 'altos_admin', url: '/v1/organizations/current/audit', status: 200 },
  'GET /v1/platform/dashboard': { as: 'operaciones', url: '/v1/platform/dashboard', status: 200 },
}

// ---------------------------------------------------------------------------
// Lista de espera (plan/contratos/o1b-lista-de-espera.md, backend v0.1.1)
// ---------------------------------------------------------------------------

const waitlistEntry = backofficeFixtures.waitlist.find((e) => e.status === 'NEW')!

const WAITLIST_SAMPLES: Record<string, Sample> = {
  'POST /v1/public/waitlist': {
    url: '/v1/public/waitlist',
    body: { type: 'CONSUMER', fullName: 'Persona de Contrato', email: 'contrato@example.com', isAdult: true, consent: true, source: 'tarija-2026', website: '' },
    status: 201,
  },
  'GET /v1/public/waitlist/stats': { url: '/v1/public/waitlist/stats', status: 200 },
  'GET /v1/platform/waitlist': { as: 'soporte', url: '/v1/platform/waitlist?limit=100', status: 200 },
  'GET /v1/platform/waitlist/sources': { as: 'soporte', url: '/v1/platform/waitlist/sources', status: 200 },
  'PATCH /v1/platform/waitlist/{id}': {
    as: 'operaciones',
    url: `/v1/platform/waitlist/${waitlistEntry.id}`,
    body: { status: 'CONTACTED', notes: 'Nota de la prueba de contrato' },
    status: 200,
  },
  'GET /v1/platform/waitlist/export': {
    as: 'operaciones',
    url: '/v1/platform/waitlist/export?type=WINERY',
    status: 200,
    csvHeader: /^position,type,status,fullName,email,/,
  },
}
Object.assign(OLA1_SAMPLES, WAITLIST_SAMPLES)
Object.assign(SAMPLES, OLA1_SAMPLES, OLA2_SAMPLES)

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
    if (sample.cookie) headers.Cookie = sample.cookie
    let body: BodyInit | undefined
    const rawBody = typeof sample.body === 'function' ? (sample.body as (v: Vars) => unknown)(vars) : sample.body
    if (sample.form) body = sample.form()
    else if (rawBody !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(rawBody)
    }
    const url = typeof sample.url === 'function' ? sample.url(vars) : sample.url
    const res = await fetch(`${API}${url}`, { method, headers, body, redirect: 'manual' })
    const text = await res.text()
    expect(res.status, text).toBe(sample.status)
    const { schema, source } = responseSchema(key, sample.status)
    if (sample.status === 204) {
      expect(text).toBe('')
      return
    }
    if (sample.status === 302) {
      // Redirección a la URL firmada del archivo: sin cuerpo.
      expect(res.headers.get('location')).toMatch(/^\/mocks\/uploads\/org\//)
      expect(text).toBe('')
      return
    }
    if (sample.raw) {
      // Bytes canónicos del expediente: JSON sin el envoltorio.
      expect(res.headers.get('content-type')).toMatch(/^application\/json/)
      if (!schema) throw new Error(`${key}: sin esquema de respuesta en el OpenAPI`)
      expectValid(schema, JSON.parse(text), `${key} ⇄ ${source}`)
      return
    }
    if (schema?.$csv) {
      expect(res.headers.get('content-type')).toMatch(/^text\/csv/)
      expect(sample.csvHeader, `${key}: falta csvHeader en la petición de ejemplo`).toBeDefined()
      // `res.text()` ya quita el BOM (lo comprueba test/waitlist.test.ts sobre los bytes).
      expect(text.split('\r\n')[0]).toMatch(sample.csvHeader!)
      return
    }
    const envelope = JSON.parse(text) as { success: boolean; data: unknown }
    expect(envelope.success).toBe(true)
    if (!schema) throw new Error(`${key}: sin esquema de respuesta en el OpenAPI`)
    expectValid(schema, envelope.data, `${key} ⇄ ${source}`)
  })

  it('las operaciones sin esquema de respuesta en el OpenAPI están identificadas', () => {
    const withoutSchema = routeOps.filter((key) => {
      const sample = SAMPLES[key]!
      return sample.status !== 204 && sample.status !== 302 && !responseSchema(key, sample.status).schema
    })
    // Desde la Ola 1 el OpenAPI declara la respuesta de todas las operaciones.
    expect(withoutSchema).toEqual([])
  })
})
