import { recordAudit } from '../backoffice/handlers/support'
import { flushChainNotices } from '../chain/notices'
import { chainCtx } from '../chain/runtime'
import type { StoredRequest } from '../chain/state'
import { getErpDb, persistErpDb, tick } from '../erp/handlers/db'
import type { TraceActor } from '../erp/schemas'
import { findLot } from '../erp/trace/state'
import type { CollectionCommercialInput, CreateTokenizationRequest, TokenizationRequest } from './schemas'
import { createRequest, requestNotFound, resubmitRequest, updateRequest, withdrawRequest } from './service'
import { requestView } from './views'

// Ayudas de los mocks para simular **a la bodega** desde otra app (p. ej. el back office, que no
// tiene sesión de dueño): enviar una solicitud, atender los cambios pedidos y reenviar, o retirarla.
// Ejecutan los mismos servicios que las rutas del ERP, con el dueño de la bodega como autor, y
// dejan sus correos en el buzón. También en `window.__docMocks.tokenization`.

/** Dueño activo de la bodega (quien autoriza la tokenización, A-03). */
function ownerOf(wineryId: string): TraceActor {
  const winery = getErpDb().wineries.find((w) => w.id === wineryId)
  const member = winery?.members?.find((m) => m.memberRole === 'OWNER' && m.isActive)
  if (!winery || !member) throw new Error(`mockTokenization: la bodega ${wineryId} no tiene un dueño activo`)
  return { membershipId: member.id, userId: member.userId, fullName: member.fullName, role: 'OWNER' }
}

const ownerActor = (owner: TraceActor, organizationId: string) => ({ userId: owner.userId, fullName: owner.fullName, role: 'OWNER', organizationId, viaPlatform: false })

function requestById(id: string): StoredRequest {
  const request = getErpDb().chain.requests.find((r) => r.id === id)
  if (!request) throw requestNotFound()
  return request
}

/** Lo que la bodega completa por defecto, según los campos que señaló operaciones al pedir cambios. */
function defaultFix(request: StoredRequest): CollectionCommercialInput {
  const fields = new Set(request.changeRequests.filter((c) => c.resolvedAt === null).flatMap((c) => c.fields))
  const draft = request.commercialDraft
  const lot = getErpDb().lots.find((l) => l.id === request.lotId)
  const fix: CollectionCommercialInput = {}
  if (fields.has('commercial.name') || !draft.name) fix.name = draft.name ?? lot?.name ?? 'Colección de la bodega'
  if (fields.has('commercial.description') || !draft.description) fix.description = draft.description ?? `Edición de ${lot?.name ?? 'la bodega'} en preventa.`
  if (fields.has('commercial.tastingNotes')) fix.tastingNotes = 'Nariz floral y fruta fresca; boca limpia, de final largo.'
  if (fields.has('commercial.pairing')) fix.pairing = 'Quesos, frutos secos y cocina chapaca.'
  if (fields.has('commercial.imageKeys') || draft.imageKeys.length === 0) {
    fix.imageKeys = [{ key: `org/${request.wineryId}/collections/2026/portada-${request.id.slice(0, 8)}.jpg`, alt: `Botella de ${draft.name ?? lot?.name ?? 'la colección'}`, isCover: true }]
  }
  return fix
}

export interface ResubmitAsWineryOptions {
  /** Mensaje de la bodega al reenviar. */
  message?: string
  /** Cambios de los datos comerciales; sin indicarlos, se completa lo que pidió operaciones (`changeRequests[].fields`). */
  commercial?: CollectionCommercialInput
  /** Cantidad nueva (se revalida contra la cuota). */
  quantity?: number
}

export const mockTokenization = {
  /**
   * La bodega atiende los **cambios pedidos** y reenvía la solicitud (`CHANGES_REQUESTED → SUBMITTED`),
   * como haría su dueño desde el ERP con `PATCH …` + `POST …/resubmit`. Devuelve la solicitud tal
   * como la ve la bodega. En otro estado → 409 `TOK_REQUEST_INVALID_TRANSITION` (lanza `ApiError`).
   */
  resubmitAsWinery(requestId: string, options: ResubmitAsWineryOptions = {}): TokenizationRequest {
    const db = getErpDb()
    const request = requestById(requestId)
    const owner = ownerOf(request.wineryId)
    const lot = findLot(db, request.lotId, null)
    tick()
    if (request.status === 'CHANGES_REQUESTED') updateRequest(db, chainCtx(), request, lot, { commercial: options.commercial ?? defaultFix(request), ...(options.quantity === undefined ? {} : { quantity: options.quantity }) }, owner)
    tick()
    resubmitRequest(db, chainCtx(), request, lot, options.message ?? 'Atendidos los cambios pedidos.', owner)
    recordAudit(null, { action: 'TOKENIZATION_RESUBMITTED', resource: { type: 'tokenization_request', id: request.id }, organizationId: request.wineryId, actor: ownerActor(owner, request.wineryId) })
    flushChainNotices()
    persistErpDb()
    return requestView(db, chainCtx(), request)
  },
  /** La bodega autoriza una cuota nueva (o una ampliación) sobre un lote, como `POST /v1/lots/{id}/tokenization-requests`. */
  submitAsWinery(lotId: string, body: Omit<CreateTokenizationRequest, 'confirm'>): TokenizationRequest {
    const db = getErpDb()
    const lot = findLot(db, lotId, null)
    const owner = ownerOf(lot.wineryId)
    tick()
    const request = createRequest(db, chainCtx(), lot, { ...body, confirm: true }, owner)
    recordAudit(null, { action: 'TOKENIZATION_REQUESTED', resource: { type: 'tokenization_request', id: request.id }, organizationId: lot.wineryId, actor: ownerActor(owner, lot.wineryId), after: { reference: lot.reference, kind: request.kind, quantity: request.quantity } })
    flushChainNotices()
    persistErpDb()
    return requestView(db, chainCtx(), request)
  },
  /** La bodega retira una solicitud abierta. */
  withdrawAsWinery(requestId: string, reason = 'La bodega retiró la solicitud.'): TokenizationRequest {
    const db = getErpDb()
    const request = requestById(requestId)
    const owner = ownerOf(request.wineryId)
    tick()
    withdrawRequest(db, chainCtx(), request, reason, owner)
    recordAudit(null, { action: 'TOKENIZATION_WITHDRAWN', resource: { type: 'tokenization_request', id: request.id }, organizationId: request.wineryId, reason, actor: ownerActor(owner, request.wineryId) })
    flushChainNotices()
    persistErpDb()
    return requestView(db, chainCtx(), request)
  },
}
export type MockTokenization = typeof mockTokenization
