import { effectiveSetting, prefsOf } from '../backoffice/handlers/support'
import { tokensOf, type StoredToken } from '../chain/state'
import { explorerAccountUrl } from '../chain/views'
import { anyUser, type AuthContext } from '../erp/handlers/auth-context'
import { getErpDb, newId, nowStamp, tick } from '../erp/handlers/db'
import { ApiError, forbidden } from '../erp/handlers/errors'
import { created, listResult, ok, parseBody, type RouteSpec } from '../erp/handlers/http'
import { rankedCollections } from '../public/collections'
import { publicWineryOf } from '../public/handlers'
import { mockAccountAddress } from '../shared/strkey'
import { CreateOrderSchema, MARKETPLACE_DRAFT_CONTRACT, SimulatePaymentSchema, type ConsumerProfile, type Order } from './schemas'

// BORRADOR de la Etapa 4 (contrato de la Ola 3 §13.1) para las pantallas 2B y 2C del Marketplace:
// perfil del consumidor con su dirección informativa y compra con pasarela de prueba. No está en
// el OpenAPI del backend y puede cambiar. Con una colección real publicada, el pedido mueve sus
// NFT (`MINTED → RESERVED → SOLD`); con una del catálogo de demostración, solo sus cifras.

/** Pedido guardado: el DTO más quién lo hizo y qué NFT reales aparta. */
export type StoredOrder = Order & { userId: string; tokenIds: string[] }

export interface MarketplaceState {
  orders: StoredOrder[]
  /** Botellas vendidas o apartadas de las colecciones del catálogo de demostración, por `slug`. */
  sold: Record<string, number>
}

export const emptyMarketplaceState = (): MarketplaceState => ({ orders: [], sold: {} })

/** Dirección custodial derivada de un consumidor (forma válida; no existe en testnet). */
export const consumerAddressOf = (userId: string): string => mockAccountAddress(`consumer:${userId}`)

const market = () => getErpDb().marketplace

function consumer(auth: AuthContext): AuthContext {
  if (auth.audience !== 'CONSUMER') throw forbidden('Solo para cuentas de consumidor')
  return auth
}

const error = (status: number, code: string, message: string, field: string | null = null, extra: Record<string, unknown> = {}) =>
  new ApiError(status, code, message, [{ field, message, code, ...extra }])

function catalog() {
  return rankedCollections(getErpDb(), publicWineryOf, nowStamp(), market().sold)
}

/** Devuelve al inventario lo apartado por un pedido que ya no se pagará. */
function release(order: StoredOrder): void {
  const db = getErpDb()
  if (order.tokenIds.length > 0) {
    for (const t of db.chain.tokens) if (order.tokenIds.includes(t.id) && t.status === 'RESERVED') t.status = 'MINTED'
  } else market().sold[order.collection.slug] = Math.max(0, (market().sold[order.collection.slug] ?? 0) - order.quantity)
  order.tokens = []
  order.reservedUntil = null
}

/** Caduca los pedidos sin pagar cuya reserva venció (reloj de los mocks). */
function expireOrders(): void {
  const now = nowStamp()
  for (const order of market().orders) {
    if (order.status !== 'AWAITING_PAYMENT' || !order.reservedUntil || order.reservedUntil > now) continue
    order.status = 'EXPIRED'
    order.updatedAt = now
    release(order)
  }
}

const view = ({ userId: _userId, tokenIds: _tokenIds, ...order }: StoredOrder): Order => order

function findOrder(auth: AuthContext, id: string): StoredOrder {
  const order = market().orders.find((o) => o.id === id && o.userId === auth.user.id)
  if (!order) throw new ApiError(404, 'MKT_ORDER_NOT_FOUND', 'Pedido no encontrado')
  return order
}

export const marketplaceDraftRoutes: RouteSpec[] = [
  {
    method: 'get',
    path: '/v1/me/consumer',
    access: anyUser,
    draft: MARKETPLACE_DRAFT_CONTRACT,
    handle({ auth }) {
      const { user } = consumer(auth)
      const prefs = prefsOf(user.id)
      const address = consumerAddressOf(user.id)
      const profile: ConsumerProfile = {
        userId: user.id,
        fullName: user.fullName,
        email: user.email,
        emailVerified: true,
        address: { address, network: getErpDb().chain.network, explorerUrl: explorerAccountUrl(address), custodial: true },
        preferences: { lotProgress: true, redemptionReminders: true, promotions: prefs.promotionsConsent },
        createdAt: user.createdAt,
      }
      return ok(profile)
    },
  },
  {
    method: 'post',
    path: '/v1/orders',
    access: anyUser,
    idempotent: true,
    draft: MARKETPLACE_DRAFT_CONTRACT,
    async handle({ request, auth }) {
      const { user } = consumer(auth)
      const body = await parseBody(request, CreateOrderSchema)
      expireOrders()
      const db = getErpDb()
      const item = catalog().find((c) => c.id === body.collectionId)
      if (!item) throw new ApiError(404, 'MKT_COLLECTION_NOT_FOUND', 'Colección no encontrada')
      if (item.status === 'SOLD_OUT') throw error(409, 'MKT_NOT_ENOUGH_STOCK', 'La colección está agotada', 'quantity', { expected: 0, actual: body.quantity })
      if (!item.price) throw error(422, 'MKT_PRICE_UNDEFINED', 'Esta colección aún no tiene precio: «Precio por anunciar»')
      const max = effectiveSetting('compra.maxBotellasPorCompra').value
      if (typeof max === 'number' && body.quantity > max) throw error(422, 'MKT_MAX_PER_ORDER', `Puedes comprar hasta ${max} botellas por pedido`, 'quantity', { rule: 'compra.maxBotellasPorCompra', expected: max, actual: body.quantity })
      if (body.quantity > item.availability.available) {
        throw error(409, 'MKT_NOT_ENOUGH_STOCK', `Solo quedan ${item.availability.available} botellas disponibles`, 'quantity', { expected: item.availability.available, actual: body.quantity })
      }
      const at = tick()
      const real = db.chain.collections.find((c) => c.id === item.id)
      let reserved: StoredToken[] = []
      if (real) {
        reserved = tokensOf(db.chain, real.id)
          .filter((t) => t.status === 'MINTED')
          .sort((a, b) => a.bottleNumber - b.bottleNumber)
          .slice(0, body.quantity)
        for (const t of reserved) t.status = 'RESERVED'
      } else market().sold[item.slug] = (market().sold[item.slug] ?? 0) + body.quantity
      const minutes = Number(effectiveSetting('compra.minutosReserva').value) || 15
      const order: StoredOrder = {
        id: newId('order'),
        userId: user.id,
        tokenIds: reserved.map((t) => t.id),
        // El pedido nace `CREATED` y pasa enseguida a esperar el pago.
        status: 'AWAITING_PAYMENT',
        collection: { id: item.id, slug: item.slug, name: item.name, coverImageUrl: item.imageUrl, winery: { slug: item.winery.slug, tradeName: item.winery.tradeName } },
        quantity: body.quantity,
        unitPrice: item.price,
        total: { amountMinor: item.price.amountMinor * body.quantity, currency: 'BOB' },
        reservedUntil: new Date(Date.parse(at) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        payment: { id: newId('payment'), provider: 'TEST', status: 'PENDING', paidAt: null },
        tokens: [],
        createdAt: at,
        updatedAt: at,
      }
      market().orders.push(order)
      return created(view(order))
    },
  },
  {
    method: 'get',
    path: '/v1/orders',
    access: anyUser,
    list: 'paged',
    draft: MARKETPLACE_DRAFT_CONTRACT,
    handle({ auth, query }) {
      consumer(auth)
      expireOrders()
      return listResult(
        market()
          .orders.filter((o) => o.userId === auth.user.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(view),
        query,
      )
    },
  },
  {
    method: 'get',
    path: '/v1/orders/:id',
    access: anyUser,
    draft: MARKETPLACE_DRAFT_CONTRACT,
    handle({ auth, params }) {
      consumer(auth)
      expireOrders()
      return ok(view(findOrder(auth, params.id!)))
    },
  },
  {
    // Pasarela de prueba: aprobar, rechazar o demorar el pago (solo desarrollo y mocks).
    method: 'post',
    path: '/v1/payments/test/:paymentId/simulate',
    access: anyUser,
    draft: MARKETPLACE_DRAFT_CONTRACT,
    async handle({ request, auth, params }) {
      consumer(auth)
      const body = await parseBody(request, SimulatePaymentSchema)
      expireOrders()
      const db = getErpDb()
      const order = market().orders.find((o) => o.payment.id === params.paymentId && o.userId === auth.user.id)
      if (!order) throw new ApiError(404, 'MKT_PAYMENT_NOT_FOUND', 'Pago no encontrado')
      if (order.status !== 'AWAITING_PAYMENT') throw error(409, 'MKT_PAYMENT_NOT_PENDING', 'Este pago ya no está pendiente', null, { meta: { status: order.status } })
      // `DELAY`: la pasarela aún no responde; el pedido sigue esperando el pago.
      if (body.outcome === 'DELAY') return ok(view(order))
      const at = tick()
      order.updatedAt = at
      if (body.outcome === 'REJECT') {
        order.status = 'PAYMENT_FAILED'
        order.payment.status = 'REJECTED'
        release(order)
        return ok(view(order))
      }
      order.status = 'PAID'
      order.payment = { ...order.payment, status: 'APPROVED', paidAt: at }
      order.reservedUntil = null
      if (order.tokenIds.length > 0) {
        const address = consumerAddressOf(order.userId)
        const collection = db.chain.collections.find((c) => c.id === order.collection.id)
        const windowDays = Number(effectiveSetting('canje.ventanaDias', collection?.wineryId ?? null).value) || 365
        const tokens = db.chain.tokens.filter((t) => order.tokenIds.includes(t.id))
        for (const t of tokens) {
          // Tras el anclaje, lo vendido es canjeable desde la entrega (contrato §7.2).
          const redeemable = Boolean(collection?.redeemableSince)
          Object.assign(t, {
            status: redeemable ? 'REDEEMABLE' : 'SOLD',
            owner: { kind: 'CONSUMER', address },
            soldAt: at,
            redeemableAt: redeemable ? at : null,
            redeemWindowEndsAt: redeemable ? new Date(Date.parse(at) + windowDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
          })
        }
        // La entrega en la red (`OPERATOR_TRANSFER`) es de la Ola 4: `transfer` queda en `null`.
        order.tokens = tokens.map((t) => ({ tokenId: t.tokenId, bottleNumber: t.bottleNumber, transfer: null }))
      } else {
        const first = (market().sold[order.collection.slug] ?? order.quantity) - order.quantity
        order.tokens = Array.from({ length: order.quantity }, (_, i) => ({ tokenId: first + i, bottleNumber: first + i + 1, transfer: null }))
      }
      return ok(view(order))
    },
  },
]
