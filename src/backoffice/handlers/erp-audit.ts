import type { RouteContext, RouteResult, RouteSpec } from '../../erp/handlers/http'
import type { WineryResponse } from '../../erp/schemas'
import { SYSTEM_NAME, now, profileOf, recordAudit } from './support'

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
  'POST /v1/auth/signup': ['USER_CREATED', 'USER'],
  'POST /v1/terroirs': ['TERROIR_CREATED', 'TERROIR'],
  'PATCH /v1/terroirs/:id': ['TERROIR_UPDATED', 'TERROIR'],
  'POST /v1/harvest-batches': ['HARVEST_BATCH_CREATED', 'HARVEST_BATCH'],
  'PATCH /v1/harvest-batches/:id/phyto-status': ['PHYTOSANITARY_STATUS_CHANGED', 'HARVEST_BATCH'],
  'POST /v1/fermentation-tanks': ['FERMENTATION_TANK_CREATED', 'FERMENTATION_TANK'],
  'POST /v1/fermentation-tanks/:id/logs': ['FERMENTATION_LOG_RECORDED', 'FERMENTATION_LOG'],
  'POST /v1/fermentation-tanks/:id/treatments': ['ENOLOGICAL_TREATMENT_RECORDED', 'ENOLOGICAL_TREATMENT'],
  'POST /v1/wine-aging': ['WINE_AGING_STARTED', 'WINE_AGING'],
  'POST /v1/production-batches/distillation': ['DISTILLATION_RECORDED', 'PRODUCTION_BATCH'],
  'POST /v1/bottling': ['BOTTLING_RECORDED', 'BOTTLING_BATCH'],
  'POST /v1/lab-analyses': ['LAB_ANALYSIS_RECORDED', 'LAB_ANALYSIS'],
  'POST /v1/uploads': ['FILE_UPLOADED', 'UPLOAD'],
  'POST /v1/wineries': ['WINERY_CREATED', 'WINERY'],
  'PATCH /v1/wineries/my': ['WINERY_UPDATED', 'WINERY'],
  'POST /v1/wineries/my/members': ['MEMBER_JOINED', 'MEMBERSHIP'],
  'POST /v1/wineries/my/members/create': ['MEMBER_JOINED', 'MEMBERSHIP'],
  'POST /v1/wineries/:id/approve': ['WINERY_ACTIVATED', 'WINERY'],
  'POST /v1/wineries/:id/reject': ['WINERY_REVOKED', 'WINERY'],
  'PATCH /v1/users/me': ['', 'USER'], // lo registra la propia ruta (antes y después)
}

const keyOf = (spec: RouteSpec) => `${spec.method.toUpperCase()} ${spec.path}`

function erpAfterSuccess(spec: RouteSpec): RouteSpec['afterSuccess'] {
  const entry = ERP_ACTIONS[keyOf(spec)]
  if (!entry || !entry[0]) return undefined
  const [action, resourceType] = entry
  return (ctx: RouteContext, result: RouteResult) => {
    const data = (result.data ?? {}) as Record<string, unknown>
    const user = data.user as { id?: unknown } | undefined
    const id = typeof data.id === 'string' ? data.id : typeof data.url === 'string' ? data.url : typeof user?.id === 'string' ? user.id : null
    const auth = ctx.optionalAuth
    const organizationId = (typeof data.wineryId === 'string' ? data.wineryId : null) ?? auth?.wineryId ?? null
    // Aprobar/rechazar por las rutas del ERP también deja rastro en el historial de la bodega.
    if (keyOf(spec) === 'POST /v1/wineries/:id/approve' || keyOf(spec) === 'POST /v1/wineries/:id/reject') {
      const winery = data as unknown as WineryResponse
      profileOf(winery).statusHistory.push({
        status: winery.certificationStatus,
        at: now(),
        by: auth?.user.fullName ?? SYSTEM_NAME,
        reason: null,
      })
      recordAudit(ctx, { action, resource: { type: resourceType, id: winery.id }, organizationId: winery.id, after: { status: winery.certificationStatus } })
      return
    }
    recordAudit(ctx, {
      action,
      resource: { type: resourceType, id },
      organizationId: resourceType === 'WINERY' && id ? id : organizationId,
      after: pickSummary(data),
    })
  }
}

/** Resumen sin datos sensibles del recurso creado o cambiado. */
function pickSummary(data: Record<string, unknown>): Record<string, unknown> | null {
  const keys = ['harvestBatchCode', 'tankCode', 'parcelName', 'internationalLotCode', 'status', 'agingStatus', 'restStatus', 'phytosanitaryStatus', 'commercialName', 'memberRole', 'treatmentType', 'url']
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
