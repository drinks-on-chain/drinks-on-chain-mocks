import type { RouteContext, RouteResult, RouteSpec } from '../../erp/handlers/http'
import { recordAudit } from './support'

// Bitácora de las escrituras de las rutas del ERP (AUD-01: "toda escritura deja una entrada") y
// operaciones que aceptan `Idempotency-Key`. No cambia las respuestas del ERP.

/** Los 9 POST de alta del ERP que aceptan `Idempotency-Key` (backend O0-BE-2, `@Idempotent()`). */
export const IDEMPOTENT_ERP_OPERATIONS = new Set([
  'POST /v1/terroirs',
  'POST /v1/harvest-batches',
  'POST /v1/fermentation-tanks',
  'POST /v1/fermentation-tanks/:id/logs',
  'POST /v1/fermentation-tanks/:id/treatments',
  'POST /v1/wine-aging',
  'POST /v1/production-batches/distillation',
  'POST /v1/bottling',
  'POST /v1/lab-analyses',
])

/** Acción y tipo de recurso de cada escritura del ERP. */
const ERP_ACTIONS: Record<string, [action: string, resourceType: string]> = {
  'POST /v1/auth/signup': ['USER_CREATED', 'user'],
  'POST /v1/terroirs': ['TERROIR_CREATED', 'terroir'],
  'PATCH /v1/terroirs/:id': ['TERROIR_UPDATED', 'terroir'],
  'POST /v1/harvest-batches': ['HARVEST_BATCH_CREATED', 'harvest_batch'],
  // Ola 2 (contrato §15); las rutas de `/v1/lots` registran su propia entrada.
  'POST /v1/terroirs/:id/corrections': ['CORRECTION_REGISTERED', 'correction'],
  'POST /v1/harvest-batches/:id/maturity-analyses': ['MATURITY_ANALYZED', 'maturity_analysis'],
  'POST /v1/harvest-batches/:id/phyto-decisions': ['PHYTO_DECIDED', 'harvest_batch'],
  'POST /v1/fermentation-tanks/:id/start': ['TANK_TRANSITION', 'fermentation_tank'],
  'POST /v1/fermentation-tanks/:id/complete': ['TANK_TRANSITION', 'fermentation_tank'],
  'POST /v1/fermentation-tanks/:id/clean': ['TANK_TRANSITION', 'fermentation_tank'],
  'POST /v1/wine-aging/:id/discard': ['WINE_AGING_BATCH_DISCARDED', 'wine_aging_batch'],
  'POST /v1/production-batches/:id/close': ['DISTILLATION_CLOSED', 'production_batch'],
  'POST /v1/production-batches/:id/discard': ['PRODUCTION_BATCH_DISCARDED', 'production_batch'],
  'PATCH /v1/harvest-batches/:id/phyto-status': ['HARVEST_BATCH_PHYTO_STATUS_CHANGED', 'harvest_batch'],
  'POST /v1/fermentation-tanks': ['FERMENTATION_TANK_CREATED', 'fermentation_tank'],
  'POST /v1/fermentation-tanks/:id/logs': ['FERMENTATION_LOG_ADDED', 'fermentation_log'],
  'POST /v1/fermentation-tanks/:id/treatments': ['ENOLOGICAL_TREATMENT_ADDED', 'enological_treatment'],
  'POST /v1/wine-aging': ['WINE_AGING_BATCH_CREATED', 'wine_aging_batch'],
  'POST /v1/production-batches/distillation': ['PRODUCTION_BATCH_CREATED', 'production_batch'],
  'POST /v1/bottling': ['BOTTLING_BATCH_CREATED', 'bottling_batch'],
  'POST /v1/lab-analyses': ['LAB_ANALYSIS_CREATED', 'lab_analysis'],
  'POST /v1/uploads': ['FILE_UPLOADED', 'file'],
  'PATCH /v1/wineries/my': ['WINERY_UPDATED', 'winery'],
  'PATCH /v1/users/me': ['', 'user'], // lo registra la propia ruta (antes y después)
}

const keyOf = (spec: RouteSpec) => `${spec.method.toUpperCase()} ${spec.path}`

function erpAfterSuccess(spec: RouteSpec): RouteSpec['afterSuccess'] {
  const entry = ERP_ACTIONS[keyOf(spec)]
  if (!entry || !entry[0]) return undefined
  const [action, resourceType] = entry
  return (ctx: RouteContext, result: RouteResult) => {
    const data = (result.data ?? {}) as Record<string, unknown>
    const user = data.user as { id?: unknown } | undefined
    const id = typeof data.id === 'string' ? data.id : typeof data.key === 'string' ? data.key.slice(0, 100) : typeof user?.id === 'string' ? user.id : null
    const auth = ctx.optionalAuth
    const organizationId = (typeof data.wineryId === 'string' ? data.wineryId : null) ?? auth?.wineryId ?? null
    recordAudit(ctx, {
      action,
      resource: { type: resourceType, id },
      organizationId: resourceType === 'winery' && id ? id : organizationId,
      after: pickSummary(data),
    })
  }
}

/** Resumen sin datos sensibles del recurso creado o cambiado. */
function pickSummary(data: Record<string, unknown>): Record<string, unknown> | null {
  const keys = ['harvestBatchCode', 'tankCode', 'parcelName', 'internationalLotCode', 'status', 'agingStatus', 'restStatus', 'phytosanitaryStatus', 'commercialName', 'memberRole', 'treatmentType', 'key', 'mimeType', 'sizeBytes', 'originalName']
  const out = Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]))
  return Object.keys(out).length ? out : null
}

/** Añade la bitácora y la idempotencia a las rutas del ERP. */
export function withErpExtras(spec: RouteSpec): RouteSpec {
  const afterSuccess = erpAfterSuccess(spec)
  const idempotent = IDEMPOTENT_ERP_OPERATIONS.has(keyOf(spec))
  if (!afterSuccess && !idempotent) return spec
  return { ...spec, ...(afterSuccess ? { afterSuccess } : {}), ...(idempotent ? { idempotent: true } : {}) }
}
