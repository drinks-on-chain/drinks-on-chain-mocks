import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as pkg from '../src'
import { RETIRED_INPUT_FIELDS } from '../src'
import { backofficeFixtures, chainFixtures, DEMO_NEW_PASSWORD, DEMO_TOTP_SECRET, erpFixtures, generateTotp, PREVENTA_CASE, publicFixtures, SINGANI_CASE, tokenizationFixtures } from '../src/fixtures'
import { COLLECTIONS_DRAFT_CONTRACT, getErpDb, MARKETPLACE_DRAFT_CONTRACT, MOCK_ROUTE_SPECS, mockChain, mockMailbox, resetScenario, setScenario } from '../src/handlers'
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
  // Ola 3: `stellar.toml` (texto) y las imágenes de las colecciones (bytes) se comprueban por su tipo.
  if (content && !content['application/json']) {
    if (content['text/plain']) return { schema: { $text: true }, source: 'openapi/erp.json' }
    if (Object.keys(content).every((type) => type.startsWith('image/'))) return { schema: { $binary: Object.keys(content) }, source: 'openapi/erp.json' }
  }
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

  it('no queda ninguna ruta obsoleta: ni el OpenAPI del cierre H2 ni los mocks marcan `deprecated`', () => {
    type Op = { deprecated?: boolean }
    const inSpec = Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.entries(ops as Record<string, Op>)
        .filter(([, op]) => op.deprecated)
        .map(([m]) => opKey(m, p)),
    )
    expect(inSpec).toEqual([])
    // La única obsoleta de los mocks es un borrador fuera del OpenAPI: la ficha del catálogo por `slug`
    // (rc.2: el `slug` es único por bodega; se retira en 0.6.0).
    expect(MOCK_ROUTE_SPECS.filter((r) => r.deprecated && !r.draft).map((r) => opKey(r.method, r.path))).toEqual([])
    expect(MOCK_ROUTE_SPECS.filter((r) => r.deprecated).map((r) => [opKey(r.method, r.path), r.deprecated])).toEqual([['GET /v1/public/collections/{slug}', '/v1/public/collections/{winerySlug}/{slug}']])
  })

  it('lo retirado en el cierre H2 (contrato de la Ola 2 §16.2) no está en el OpenAPI ni en los mocks: rutas, DTO y campos de entrada', () => {
    const retired = [
      'PATCH /v1/harvest-batches/{id}/phyto-status',
      'POST /v1/bottling',
      'POST /v1/lab-analyses',
      'GET /v1/traceability/dag/{bottlingBatchId}',
      'GET /v1/traceability/public/{lotCode}',
    ]
    expect(retired.filter((op) => openApiOps.has(op) || routeOps.includes(op))).toEqual([])
    const schemas = spec.components.schemas
    for (const name of ['CreateBatchLabAnalysisDto', 'CreateBottlingBatchDto', 'DagGraphResponseDto', 'DagNodeDto', 'DagOperatorDto', 'UpdatePhytoStatusDto']) expect(schemas[name], name).toBeUndefined()
    // Cada campo que los mocks rechazan como retirado falta de verdad en el DTO de entrada del OpenAPI.
    const props = (name: string) => Object.keys((schemas[name]?.properties as Json | undefined) ?? {})
    for (const [dto, fields] of Object.entries(RETIRED_INPUT_FIELDS)) {
      expect(schemas[dto], dto).toBeDefined()
      expect(props(dto).filter((p) => (fields as readonly string[]).includes(p)), dto).toEqual([])
    }
    expect(props('CreateHarvestBatchDto')).not.toContain('phytosanitaryStatus')
    // Los que pasaron a obligatorios.
    const required = (name: string) => (schemas[name]?.required as string[] | undefined) ?? []
    expect(required('CreateFermentationTankDto')).toEqual(expect.arrayContaining(['inputs', 'volumeFilledLiters']))
    expect(required('CreateDistillationBatchDto')).toContain('inputVolumeLiters')
    expect(required('CreateLotLabAnalysisDto')).toContain('laboratoryReportKey')
    expect(required('UploadResponseDto')).toContain('sha256')
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

  it('los borradores fuera del OpenAPI están declarados en la ruta y en pendientes.json (catálogo, contrato de la Ola 2 §17.1; Marketplace, contrato de la Ola 3 §13.1)', () => {
    // Exclusión explícita de la prueba estricta: el backend no implementa el catálogo en esta ola,
    // así que estas rutas solo se validan contra el esquema zod de los mocks (`$zod`).
    const drafts = MOCK_ROUTE_SPECS.filter((r) => r.draft).map((r) => opKey(r.method, r.path)).sort()
    expect(drafts).toEqual([
      'GET /v1/me/consumer',
      'GET /v1/orders',
      'GET /v1/orders/{id}',
      'GET /v1/public/collections',
      'GET /v1/public/collections/{slug}',
      'GET /v1/public/collections/{winerySlug}/{slug}',
      'GET /v1/public/purchase-settings',
      'POST /v1/orders',
      'POST /v1/payments/test/{paymentId}/simulate',
    ])
    expect(pending.adelantadas.filter((e) => e.borrador).map((e) => opKey(e.method, e.path)).sort()).toEqual(drafts)
    for (const r of MOCK_ROUTE_SPECS.filter((x) => x.draft)) {
      expect([COLLECTIONS_DRAFT_CONTRACT, MARKETPLACE_DRAFT_CONTRACT]).toContain(r.draft)
      // El catálogo de la Ola 2 (lista y ficha por `slug`) cita su contrato; lo demás, el §13.1 de la Ola 3.
      expect(r.draft).toBe(['/v1/public/collections', '/v1/public/collections/:slug'].includes(r.path) ? COLLECTIONS_DRAFT_CONTRACT : MARKETPLACE_DRAFT_CONTRACT)
      expect(ahead.get(opKey(r.method, r.path))?.contrato).toBe(r.draft)
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
  // Ola 3: cadena y tokenización (las vistas de `fixtures/chain/` y `fixtures/tokenization/`).
  ['chain/identities.json', chainFixtures.identities, 'WineryChainIdentityDto'],
  ['chain/transactions.json', chainFixtures.transactions, 'ChainTransactionDto'],
  ['chain/platform-accounts.json', [chainFixtures.platformAccounts], 'PlatformChainAccountsDto'],
  ['chain/alerts.json', chainFixtures.alerts, 'ChainAlertDto'],
  ['chain/events.json', chainFixtures.events, 'ChainEventDto'],
  ['chain/reconciliation-runs.json', chainFixtures.reconciliationRuns, 'ReconciliationRunDto'],
  ['chain/registry.json', [chainFixtures.registry], 'PublicChainRegistryDto'],
  ['chain/winery-accounts.json', Object.values(chainFixtures.wineryAccounts), 'WineryChainAccountViewDto'],
  ['chain/verifications.json', Object.values(chainFixtures.verifications), 'PublicDossierVerificationDto'],
  ['tokenization/requests.json', tokenizationFixtures.requests, 'PlatformTokenizationRequestDto'],
  ['tokenization/collections.json', tokenizationFixtures.collections, 'CollectionDto'],
  ['tokenization/tokens.json', tokenizationFixtures.tokens, 'TokenDto'],
  ['tokenization/lot-closures.json', tokenizationFixtures.lotClosures, 'LotClosureDto'],
  ['tokenization/lot-status.json', Object.values(tokenizationFixtures.lotStatus), 'LotTokenizationStatusDto'],
  ['tokenization/nft-metadata.json', Object.values(tokenizationFixtures.nftMetadata), 'PublicNftMetadataDto'],
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
const restingProduction = F.productionBatches.find((p) => p.restStatus === 'RESTING')!
/** Destilación abierta de «Singani El Molino 2026» (5.800 L de entrada). */
const openProduction = F.productionBatches.find((p) => p.wineryId === CINTI.id && !p.processEndDate)!
const bottlingWithLab = F.bottling.find((b) => F.labAnalyses.some((l) => l.bottlingBatchId === b.id))!
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
  /** Envía `Idempotency-Key` (obligatoria en varias operaciones de la Ola 3). */
  idem?: boolean
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
  // Ola 3 (SE-02): el personal → 404 `CHN_WALLET_NOT_AVAILABLE`; el consumidor, su dirección derivada.
  'GET /v1/users/me/wallet': { as: 'maria', url: '/v1/users/me/wallet', status: 200 },
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
    body: { terroirId: altosTerroir.id, intakeDate: '2026-09-25', harvestYear: 2026, grossWeightKg: 5200, tareWeightKg: 100, maturity: { brixDegrees: 24, ph: 3.5, acidityGl: 6 } },
    status: 201,
  },
  'GET /v1/harvest-batches': { as: 'altos_enologa', url: '/v1/harvest-batches', status: 200 },
  'GET /v1/harvest-batches/{id}': { as: 'altos_enologa', url: `/v1/harvest-batches/${altosHarvest.id}`, status: 200 },
  'POST /v1/fermentation-tanks': {
    as: 'altos_enologa',
    url: '/v1/fermentation-tanks',
    // La uva entra a un tanque con el dictamen aprobado.
    setup: async () => {
      await post(`/v1/harvest-batches/${altosPendingHarvest.id}/phyto-decisions`, { decision: 'APPROVED' }, 'altos_agronomo')
      return {}
    },
    body: { inputs: [{ harvestBatchId: altosPendingHarvest.id }], tankCode: 'TK-C1', capacityLiters: 6000, volumeFilledLiters: 4100, startDate: '2026-09-25' },
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
  'POST /v1/wine-aging': {
    as: 'altos_enologa',
    url: '/v1/wine-aging',
    // Solo un tanque `COMPLETED` es origen de una crianza (cierre H2).
    setup: async () => {
      await post(`/v1/fermentation-tanks/${altosTank.id}/complete`, { endDate: '2026-09-25', finalVolumeLiters: 8000, destination: 'WINE_AGING' }, 'altos_enologa')
      return {}
    },
    body: { fermentationTankId: altosTank.id, containerType: 'Barrica', volumeLiters: 8000, plannedMonths: 12 },
    status: 201,
  },
  'GET /v1/wine-aging': { as: 'altos_enologa', url: '/v1/wine-aging', status: 200 },
  'GET /v1/wine-aging/{id}': { as: 'altos_enologa', url: `/v1/wine-aging/${altosAging.id}`, status: 200 },
  'POST /v1/production-batches/distillation': {
    as: 'cvj_enologa',
    url: '/v1/production-batches/distillation',
    // Uva recibida sin lote → dictamen → tanque → fermentación completada con destino singani: solo entonces se destila (cierre H2).
    setup: async () => {
      await post(`/v1/harvest-batches/${unassignedHarvest.id}/phyto-decisions`, { decision: 'APPROVED' }, 'cvj_agronomo')
      const { data } = await post('/v1/fermentation-tanks', { inputs: [{ harvestBatchId: unassignedHarvest.id }], tankCode: 'TK-C3', volumeFilledLiters: 2700, startFermentation: true, startDate: '2026-09-25' }, 'cvj_enologa')
      const done = await post(`/v1/fermentation-tanks/${data.id as string}/complete`, { endDate: '2026-09-25', finalVolumeLiters: 2600, destination: 'SINGANI_DIST' }, 'cvj_enologa')
      if (done.status !== 200) throw new Error(`El tanque de la muestra no se completó (${done.status})`)
      return { tankId: data.id as string }
    },
    body: (v: Vars) => ({ fermentationTankId: v.tankId, equipmentIdentifier: 'AL-01', processStartDate: '2026-09-25', inputVolumeLiters: 2600 }),
    status: 201,
  },
  'GET /v1/production-batches/{id}/rest-status': { as: 'cvj_enologa', url: `/v1/production-batches/${restingProduction.id}/rest-status`, status: 200 },
  'GET /v1/production-batches/{id}': { as: 'cvj_enologa', url: `/v1/production-batches/${restingProduction.id}`, status: 200 },
  'GET /v1/production-batches': { as: 'cvj_enologa', url: '/v1/production-batches', status: 200 },
  'GET /v1/bottling': { as: 'cvj_enologa', url: '/v1/bottling', status: 200 },
  'GET /v1/bottling/{id}': { as: 'admin', url: `/v1/bottling/${bottlingWithLab.id}`, status: 200 },
  'GET /v1/lab-analyses/batch/{bottlingBatchId}': { as: 'admin', url: `/v1/lab-analyses/batch/${bottlingWithLab.id}`, status: 200 },
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
// ---------------------------------------------------------------------------
// Ola 3 (plan/contratos/o3-tokenizacion.md): tokenización y cadena
// ---------------------------------------------------------------------------

const TF = tokenizationFixtures
const requestBy = (lotName: string, status: string) => TF.requests.find((r) => r.lot.name === lotName && r.status === status)!
const collectionBy = (name: string) => TF.collections.find((c) => c.name === name)!
/** En revisión, con los datos completos (Cinti Viejo): se puede aprobar. */
const reqInReview = requestBy('Singani El Molino 2026', 'IN_REVIEW')
/** Con cambios pedidos (Altos): falta la portada. */
const reqChanges = requestBy('Tannat La Angostura 2024', 'CHANGES_REQUESTED')
/** Ampliación enviada sin tomar (Altos). */
const reqSubmitted = requestBy('Singani El Portillo 2025', 'SUBMITTED')
const colPreventa = collectionBy(PREVENTA_CASE.name)
const colGranReserva = collectionBy(SINGANI_CASE.name)
const colPortillo = collectionBy('Singani El Portillo 2025')
const O3_REASON = 'Prueba de contrato de la Ola 3'
const authHeaders = (as: string, idem?: string) => ({ Authorization: `Bearer mock.access.${as}`, 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': uid(`contract-setup:${idem}`) } : {}) })
async function send<T = unknown>(as: string, method: string, url: string, body?: unknown, idem?: string): Promise<T> {
  const res = await fetch(`${API}${url}`, { method, headers: authHeaders(as, idem), body: body === undefined ? undefined : JSON.stringify(body) })
  const json = (await res.json()) as { success: boolean; data: T; error?: { code: string } }
  if (!json.success) throw new Error(`setup ${method} ${url}: ${res.status} ${json.error?.code}`)
  return json.data
}
/** Aplica un escenario de datos (lo hace la primera petición) y devuelve la base. */
async function withScenario(name: Parameters<typeof setScenario>[0]) {
  setScenario(name)
  await send('soporte', 'GET', '/v1/platform/chain/accounts')
  return getErpDb()
}
const newOrder = () => send<{ id: string; payment: { id: string } }>('maria', 'POST', '/v1/orders', { collectionId: colGranReserva.id, quantity: 2 })

const OLA3_SAMPLES: Record<string, Sample> = {
  // ERP: estado del lote y solicitudes
  'GET /v1/lots/{id}/tokenization': { as: 'cvj_enologa', url: `/v1/lots/${originLot.id}/tokenization`, status: 200 },
  'POST /v1/lots/{id}/tokenization-requests': {
    as: 'cvj_admin',
    idem: true,
    url: `/v1/lots/${originLot.id}/tokenization-requests`,
    body: { quantity: 300, commercial: { name: 'Singani Edición Aniversario 2026', description: 'Edición limitada por el aniversario de la destilería, en preventa.' }, notes: 'Preventa de aniversario', confirm: true },
    status: 201,
  },
  'GET /v1/tokenization-requests': { as: 'cvj_enologa', url: '/v1/tokenization-requests?limit=50', status: 200 },
  'GET /v1/tokenization-requests/{id}': { as: 'cvj_admin', url: `/v1/tokenization-requests/${reqInReview.id}`, status: 200 },
  'PATCH /v1/tokenization-requests/{id}': {
    as: 'altos_admin',
    url: `/v1/tokenization-requests/${reqChanges.id}`,
    body: { quantity: 1000, commercial: { imageKeys: [{ key: `org/${ALTOS.id}/collections/2026/tannat-la-angostura.jpg`, alt: 'Botella de Tannat La Angostura 2024', isCover: true }] }, notes: 'Añadida la portada' },
    status: 200,
  },
  'POST /v1/tokenization-requests/{id}/resubmit': { as: 'altos_admin', idem: true, url: `/v1/tokenization-requests/${reqChanges.id}/resubmit`, body: { message: 'Ya está la portada' }, status: 200 },
  'POST /v1/tokenization-requests/{id}/withdraw': { as: 'altos_admin', url: `/v1/tokenization-requests/${reqSubmitted.id}/withdraw`, body: { reason: O3_REASON }, status: 200 },
  'GET /v1/collections': { as: 'cvj_admin', url: '/v1/collections', status: 200 },
  'GET /v1/collections/{id}': { as: 'cvj_enologa', url: `/v1/collections/${colPreventa.id}`, status: 200 },
  'GET /v1/collections/{id}/tokens': { as: 'cvj_admin', url: `/v1/collections/${colPreventa.id}/tokens?status=MINTED&fromNumber=10&toNumber=40&limit=5`, status: 200 },
  'GET /v1/collections/{id}/closure': { as: 'cvj_admin', url: `/v1/collections/${colGranReserva.id}/closure`, status: 200 },
  'GET /v1/organizations/current/chain-account': { as: 'cvj_operario', url: '/v1/organizations/current/chain-account', status: 200 },

  // Back office: bandeja
  'GET /v1/platform/tokenization-requests': { as: 'soporte', url: '/v1/platform/tokenization-requests?q=singani', status: 200 },
  'GET /v1/platform/tokenization-requests/{id}': { as: 'soporte', url: `/v1/platform/tokenization-requests/${reqInReview.id}`, status: 200 },
  'POST /v1/platform/tokenization-requests/{id}/take': { as: 'operaciones', url: `/v1/platform/tokenization-requests/${reqSubmitted.id}/take`, body: {}, status: 200 },
  'POST /v1/platform/tokenization-requests/{id}/notes': { as: 'operaciones', url: `/v1/platform/tokenization-requests/${reqInReview.id}/notes`, body: { text: 'Nota de la prueba de contrato' }, status: 201 },
  'PATCH /v1/platform/tokenization-requests/{id}': {
    as: 'operaciones',
    url: `/v1/platform/tokenization-requests/${reqInReview.id}`,
    body: { commercial: { pairing: 'Con queso de cabra' }, price: { amountMinor: 21000, currency: 'BOB' }, reason: O3_REASON },
    status: 200,
  },
  'POST /v1/platform/tokenization-requests/{id}/request-changes': {
    as: 'operaciones',
    url: `/v1/platform/tokenization-requests/${reqInReview.id}/request-changes`,
    body: { message: 'Revisa la fecha estimada de canje', fields: ['commercial.estimatedRedeemDate'] },
    status: 200,
  },
  'POST /v1/platform/tokenization-requests/{id}/approve': {
    as: 'operaciones',
    idem: true,
    url: `/v1/platform/tokenization-requests/${reqInReview.id}/approve`,
    body: { price: { amountMinor: 19500, currency: 'BOB' }, publishOnMint: true, reason: O3_REASON },
    status: 201,
  },
  'POST /v1/platform/tokenization-requests/{id}/reject': { as: 'operaciones', url: `/v1/platform/tokenization-requests/${reqInReview.id}/reject`, body: { reason: O3_REASON }, status: 200 },

  // Back office: colecciones y cierre
  'GET /v1/platform/collections': { as: 'soporte', url: '/v1/platform/collections?status=PUBLISHED&saleState=PRESALE', status: 200 },
  'GET /v1/platform/collections/{id}': { as: 'soporte', url: `/v1/platform/collections/${colGranReserva.id}`, status: 200 },
  'PATCH /v1/platform/collections/{id}': {
    as: 'operaciones',
    url: `/v1/platform/collections/${colPortillo.id}`,
    body: { commercial: { tastingNotes: 'Flor blanca y cítricos' }, price: { amountMinor: 16500, currency: 'BOB' }, estimatedRedeemDate: '2026-12-01', reason: O3_REASON },
    status: 200,
  },
  'POST /v1/platform/collections/{id}/publish': { as: 'operaciones', idem: true, url: `/v1/platform/collections/${colPortillo.id}/publish`, body: {}, status: 200 },
  'POST /v1/platform/collections/{id}/pause': { as: 'operaciones', idem: true, url: `/v1/platform/collections/${colPreventa.id}/pause`, body: { reason: O3_REASON }, status: 200 },
  'POST /v1/platform/collections/{id}/resume': {
    as: 'operaciones',
    idem: true,
    setup: async () => {
      await send('operaciones', 'POST', `/v1/platform/collections/${colPreventa.id}/pause`, { reason: O3_REASON }, 'pause')
      return {}
    },
    url: `/v1/platform/collections/${colPreventa.id}/resume`,
    body: { reason: O3_REASON },
    status: 200,
  },
  'POST /v1/platform/collections/{id}/close': { as: 'operaciones', url: `/v1/platform/collections/${colPortillo.id}/close`, body: { reason: O3_REASON }, status: 200 },
  'GET /v1/platform/collections/{id}/tokens': { as: 'soporte', url: `/v1/platform/collections/${colPreventa.id}/tokens?limit=3`, status: 200 },
  'GET /v1/platform/collections/{id}/transactions': { as: 'soporte', url: `/v1/platform/collections/${colPreventa.id}/transactions`, status: 200 },
  'GET /v1/platform/collections/{id}/metrics': { as: 'soporte', url: `/v1/platform/collections/${colGranReserva.id}/metrics`, status: 200 },
  'GET /v1/platform/lot-closures': { as: 'soporte', url: '/v1/platform/lot-closures?status=NO_SHORTFALL', status: 200 },
  'GET /v1/platform/collections/{id}/closure': { as: 'soporte', url: `/v1/platform/collections/${colGranReserva.id}/closure`, status: 200 },
  'POST /v1/platform/collections/{id}/closure/decide': {
    as: 'bo_admin',
    idem: true,
    // El escenario rehace la colección de El Portillo (otro id) con 20 NFT más que botellas.
    setup: async () => ({ id: (await withScenario('faltante-botellas')).chain.collections.find((c) => c.lotId === colPortillo.lotId)!.id }),
    url: (v) => `/v1/platform/collections/${v.id}/closure/decide`,
    body: { unsoldPolicy: 'KEEP_ON_SALE', reason: O3_REASON },
    status: 200,
  },
  'POST /v1/platform/collections/{id}/closure/items/{tokenId}/resolve': {
    as: 'operaciones',
    // Faltante de 20 con solo 5 NFT sin vender: 15 vendidos se quedan sin botella (proceso manual, A-30).
    setup: async () => {
      const db = await withScenario('faltante-botellas')
      const id = db.chain.collections.find((c) => c.lotId === colPortillo.lotId)!.id
      const tokens = db.chain.tokens.filter((t) => t.collectionId === id).sort((a, b) => a.bottleNumber - b.bottleNumber)
      tokens.slice(0, tokens.length - 5).forEach((t, i) => Object.assign(t, { status: 'SOLD', soldAt: new Date(Date.UTC(2026, 8, 20, 12, 0, i)).toISOString() }))
      const closure = await send<{ items: { tokenId: number; status: string }[] }>('soporte', 'GET', `/v1/platform/collections/${id}/closure`)
      return { id, tokenId: String(closure.items.find((i) => i.status === 'SOLD')!.tokenId) }
    },
    url: (v) => `/v1/platform/collections/${v.id}/closure/items/${v.tokenId}/resolve`,
    body: { outcome: 'MANUAL_REFUND', note: 'Devolución acordada con el comprador' },
    status: 200,
  },

  // Back office: cadena
  'GET /v1/platform/chain/transactions': { as: 'soporte', url: '/v1/platform/chain/transactions?kind=MINT_BATCH&status=CONFIRMED&from=2026-09-01', status: 200 },
  'GET /v1/platform/chain/transactions/{id}': { as: 'soporte', url: `/v1/platform/chain/transactions/${chainFixtures.transactions[0]!.id}`, status: 200 },
  'POST /v1/platform/chain/transactions/{id}/retry': {
    as: 'operaciones',
    idem: true,
    setup: async () => {
      const db = await withScenario('emision-fallida')
      return { id: db.chain.transactions.find((t) => t.status === 'FAILED')!.id }
    },
    url: (v) => `/v1/platform/chain/transactions/${v.id}/retry`,
    body: { reason: O3_REASON },
    status: 200,
  },
  'POST /v1/platform/chain/transactions/{id}/abandon': {
    as: 'bo_admin',
    // Una pausa del contrato que falla en la red sí se puede abandonar (una emisión o un anclaje, no).
    setup: async () => {
      mockChain.failNext({ kind: 'PAUSE_CONTRACT' })
      await send('bo_admin', 'POST', `/v1/platform/wineries/${CINTI.id}/chain/pause`, { reason: O3_REASON }, 'pause-fail')
      mockChain.settle()
      return { id: getErpDb().chain.transactions.find((t) => t.kind === 'PAUSE_CONTRACT' && t.status === 'FAILED')!.id }
    },
    url: (v) => `/v1/platform/chain/transactions/${v.id}/abandon`,
    body: { reason: O3_REASON },
    status: 200,
  },
  'GET /v1/platform/chain/accounts': { as: 'soporte', url: '/v1/platform/chain/accounts', status: 200 },
  'GET /v1/platform/chain/events': { as: 'soporte', url: '/v1/platform/chain/events?type=lot_minted&unmatched=false', status: 200 },
  'GET /v1/platform/chain/reconciliation/runs': { as: 'soporte', url: '/v1/platform/chain/reconciliation/runs?status=OK', status: 200 },
  'POST /v1/platform/chain/reconciliation/runs': { as: 'operaciones', url: '/v1/platform/chain/reconciliation/runs', body: { scope: 'ALL', depth: 'FULL' }, status: 202 },
  'GET /v1/platform/chain/reconciliation/runs/{id}': {
    as: 'soporte',
    url: `/v1/platform/chain/reconciliation/runs/${chainFixtures.reconciliationRuns.find((r) => r.status === 'DIFFERENCES')!.id}`,
    status: 200,
  },
  'GET /v1/platform/chain/alerts': { as: 'soporte', url: '/v1/platform/chain/alerts?status=open&level=WARNING', status: 200 },
  'POST /v1/platform/chain/alerts/{id}/resolve': {
    as: 'operaciones',
    url: `/v1/platform/chain/alerts/${chainFixtures.alerts.find((a) => a.resolvedAt === null)!.id}/resolve`,
    body: { note: 'Extensión de TTL lanzada a mano' },
    status: 200,
  },
  'GET /v1/platform/wineries/{id}/chain-account': { as: 'soporte', url: `/v1/platform/wineries/${CINTI.id}/chain-account`, status: 200 },
  'POST /v1/platform/wineries/{id}/chain/provision': {
    as: 'operaciones',
    setup: async () => {
      await withScenario('identidad-preparandose')
      return {}
    },
    url: `/v1/platform/wineries/${ALTOS.id}/chain/provision`,
    body: { reason: O3_REASON },
    status: 202,
  },
  'POST /v1/platform/wineries/{id}/chain/pause': { as: 'bo_admin', idem: true, url: `/v1/platform/wineries/${CINTI.id}/chain/pause`, body: { reason: O3_REASON }, status: 202 },
  'POST /v1/platform/wineries/{id}/chain/unpause': {
    as: 'bo_admin',
    idem: true,
    setup: async () => {
      await send('bo_admin', 'POST', `/v1/platform/wineries/${CINTI.id}/chain/pause`, { reason: O3_REASON }, 'pause')
      mockChain.settle()
      return {}
    },
    url: `/v1/platform/wineries/${CINTI.id}/chain/unpause`,
    body: { reason: O3_REASON },
    status: 202,
  },

  // Público
  'GET /.well-known/stellar.toml': { url: '/.well-known/stellar.toml', status: 200 },
  'GET /v1/public/chain/registry': { url: '/v1/public/chain/registry', status: 200 },
  'GET /v1/public/lots/{lotCode}/verification': { url: `/v1/public/lots/${CASE.lotCode}/verification`, status: 200 },
  'GET /v1/public/nft/{winerySlug}/{tokenId}': { url: `/v1/public/nft/${colPreventa.winery.slug}/${TF.tokens.find((t) => t.collectionId === colPreventa.id)!.tokenId}`, status: 200 },
  'GET /v1/public/collections/images/{imageId}': { url: `/v1/public/collections/images/${colPreventa.commercial.images[0]!.id}`, status: 200 },

  // BORRADOR del Marketplace (§13.1): fuera del OpenAPI; se valida con el esquema zod de pendientes.json.
  'GET /v1/public/collections/{winerySlug}/{slug}': { url: `/v1/public/collections/${colPreventa.winery.slug}/${colPreventa.slug}`, status: 200 },
  'GET /v1/public/purchase-settings': { url: '/v1/public/purchase-settings', status: 200 },
  'GET /v1/me/consumer': { as: 'maria', url: '/v1/me/consumer', status: 200 },
  'POST /v1/orders': { as: 'maria', idem: true, url: '/v1/orders', body: { collectionId: colGranReserva.id, quantity: 2 }, status: 201 },
  'GET /v1/orders': {
    as: 'maria',
    setup: async () => {
      await newOrder()
      return {}
    },
    url: '/v1/orders',
    status: 200,
  },
  'GET /v1/orders/{id}': { as: 'maria', setup: async () => ({ id: (await newOrder()).id }), url: (v) => `/v1/orders/${v.id}`, status: 200 },
  'POST /v1/payments/test/{paymentId}/simulate': {
    as: 'maria',
    setup: async () => ({ paymentId: (await newOrder()).payment.id }),
    url: (v) => `/v1/payments/test/${v.paymentId}/simulate`,
    body: { outcome: 'APPROVE' },
    status: 200,
  },
}

Object.assign(OLA1_SAMPLES, WAITLIST_SAMPLES)
Object.assign(SAMPLES, OLA1_SAMPLES, OLA2_SAMPLES, OLA3_SAMPLES)

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
    if (sample.idem) headers['Idempotency-Key'] = uid(`contract:${key}`)
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
    if (schema?.$text) {
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
      expect(text).toMatch(/NETWORK_PASSPHRASE=/)
      return
    }
    if (schema?.$binary) {
      expect(schema.$binary).toContain(res.headers.get('content-type'))
      // Firma PNG.
      expect(text.slice(1, 4)).toBe('PNG')
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
