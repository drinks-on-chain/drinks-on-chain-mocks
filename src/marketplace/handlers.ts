import { bo, checkCaptcha, checkPassword, effectiveSetting, prefsOf, recordAudit, personActor, sendMail } from '../backoffice/handlers/support'
import { emailVerifyMail } from '../backoffice/mail'
import { tokensOf, type StoredToken } from '../chain/state'
import { explorerAccountUrl } from '../chain/views'
import { anyUser, type AuthContext } from '../erp/handlers/auth-context'
import { CLOCK_START, getErpDb, newId, nowStamp, tick } from '../erp/handlers/db'
import { ApiError, forbidden, notFound } from '../erp/handlers/errors'
import { accepted, created, listResult, ok, parseBody, validate, type RouteContext, type RouteResult, type RouteSpec } from '../erp/handlers/http'
import type { MockUser } from '../erp/schemas'
import { rankedCollections, type RankedCollection } from '../public/collections'
import { publicWineryOf } from '../public/handlers'
import { mockAccountAddress } from '../shared/strkey'
import { uid } from '../shared/uuid'
import { ConsumerSignupSchema, CreateOrderSchema, MARKETPLACE_DEMO_ACCOUNT, MARKETPLACE_DRAFT_CONTRACT, SimulatePaymentSchema, type ConsumerProfile, type ConsumerSignupAccepted, type Order, type PurchaseSettings } from './schemas'

// BORRADOR de la Etapa 4 (contrato de la Ola 3 §13.1) para las pantallas 2B y 2C del Marketplace:
// perfil del consumidor con su dirección informativa y compra con pasarela de prueba. No está en
// el OpenAPI del backend y puede cambiar. Con una colección real publicada, el pedido mueve sus
// NFT (`MINTED → RESERVED → SOLD`); con una del catálogo de demostración, solo sus cifras.

/** Pedido guardado: el DTO más quién lo hizo y qué NFT reales aparta. */
export type StoredOrder = Order & { userId: string; tokenIds: string[] }

export interface MarketplaceState {
  orders: StoredOrder[]
  /** Botellas vendidas o apartadas en la sesión de las colecciones del catálogo de demostración, por **id** de colección. */
  sold: Record<string, number>
  /** Ya se sembraron los pedidos de la cuenta de demostración. */
  seeded?: boolean
}

export const emptyMarketplaceState = (): MarketplaceState => ({ orders: [], sold: {} })

/** Dirección custodial derivada de un consumidor (forma válida; no existe en testnet). */
export const consumerAddressOf = (userId: string): string => mockAccountAddress(`consumer:${userId}`)

/** Estado del borrador; la primera vez siembra los pedidos de la cuenta de demostración. */
function market(): MarketplaceState {
  const state = getErpDb().marketplace
  if (!state.seeded) {
    state.seeded = true
    seedDemoOrders(state)
  }
  return state
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

const orderCollection = (item: RankedCollection): Order['collection'] => ({ id: item.id, slug: item.slug, name: item.name, coverImageUrl: item.imageUrl, winery: { slug: item.winery.slug, tradeName: item.winery.tradeName } })

/**
 * Pedidos de la cuenta de demostración (`MARKETPLACE_DEMO_ACCOUNT`, María): dos pagados, uno con
 * el pago rechazado y uno caducado, sobre colecciones del catálogo de demostración (sus botellas ya
 * están dentro de lo vendido de cada una: no cambian la disponibilidad). Fechas relativas al día
 * de referencia.
 */
function seedDemoOrders(state: MarketplaceState): void {
  const db = getErpDb()
  const user = db.users.find((u) => u._mock.key === MARKETPLACE_DEMO_ACCOUNT.key)
  if (!user) return
  const real = new Set(db.chain.collections.map((c) => c.id))
  const demo = rankedCollections(db, publicWineryOf, iso(CLOCK_START), {}).filter((c) => !real.has(c.id) && c.price !== null)
  const onSale = demo.filter((c) => c.status === 'ON_SALE')
  const presale = demo.filter((c) => c.status === 'PRESALE')
  const DAY = 86_400_000
  const plan: Array<{ item: RankedCollection | undefined; quantity: number; daysAgo: number; status: Order['status'] }> = [
    { item: onSale[1] ?? onSale[0], quantity: 1, daysAgo: 20, status: 'PAID' },
    { item: onSale[0], quantity: 2, daysAgo: 6, status: 'PAID' },
    { item: presale[0] ?? onSale[0], quantity: 3, daysAgo: 3, status: 'PAYMENT_FAILED' },
    { item: onSale[0], quantity: 1, daysAgo: 1, status: 'EXPIRED' },
  ]
  plan.forEach(({ item, quantity, daysAgo, status }, i) => {
    if (!item?.price) return
    const createdAt = CLOCK_START - daysAgo * DAY - (i + 1) * 3_600_000
    const paidAt = status === 'PAID' ? iso(createdAt + 4 * 60_000) : null
    // Números de botella dentro de lo ya vendido de la colección (los primeros).
    const first = 10 + i * 7
    state.orders.push({
      id: uid(`demo-order:${MARKETPLACE_DEMO_ACCOUNT.key}:${i + 1}`),
      userId: user.id,
      tokenIds: [],
      status,
      collection: orderCollection(item),
      quantity,
      unitPrice: item.price,
      total: { amountMinor: item.price.amountMinor * quantity, currency: 'BOB' },
      reservedUntil: null,
      payment: { id: uid(`demo-payment:${MARKETPLACE_DEMO_ACCOUNT.key}:${i + 1}`), provider: 'TEST', status: status === 'PAID' ? 'APPROVED' : status === 'PAYMENT_FAILED' ? 'REJECTED' : 'PENDING', paidAt },
      tokens: status === 'PAID' ? Array.from({ length: quantity }, (_, k) => ({ tokenId: first + k, bottleNumber: first + k + 1, transfer: null })) : [],
      createdAt: iso(createdAt),
      updatedAt: paidAt ?? iso(createdAt + (status === 'EXPIRED' ? 15 : 5) * 60_000),
    })
  })
}

// ---------------------------------------------------------------------------
// Alta del consumidor con verificación del correo (§13.1)
// ---------------------------------------------------------------------------

/** ¿El cuerpo es el del alta del borrador (trae captcha, campo trampa o las declaraciones)? */
export function isDraftSignup(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && ['captchaToken', 'website', 'acceptTerms', 'ageDeclaration'].some((k) => k in raw)
}

/** ¿El consumidor verificó ya su correo? (los de los fixtures, sí; los que se dan de alta por el borrador, tras `verify-email`). */
export const isEmailVerified = (userId: string): boolean => !bo().emailUnverified?.[userId]

/** `POST /v1/auth/verify-email`: el correo queda verificado. */
export function markEmailVerified(userId: string): void {
  const pending = bo().emailUnverified
  if (pending) delete pending[userId]
}

/**
 * Alta del borrador: valida, comprueba el captcha y la contraseña, crea la cuenta **sin abrir
 * sesión**, la deja con el correo por verificar y envía el enlace al buzón simulado. Responde
 * siempre 202 `{ status: 'VERIFICATION_SENT' }`: también con el campo trampa relleno o con un
 * correo ya registrado (sin crear nada), para no revelar qué correos existen.
 */
export function draftSignup(
  ctx: RouteContext,
  raw: unknown,
  users: { findByEmail: (email: string) => MockUser | undefined; create: (input: { email: string; password: string; fullName: string; phoneNumber?: string | null; preferredLocale?: string | null }) => MockUser },
): RouteResult {
  const body = validate(raw, ConsumerSignupSchema)
  checkCaptcha(body.captchaToken)
  const sent: ConsumerSignupAccepted = { status: 'VERIFICATION_SENT' }
  const result: RouteResult = { ...accepted(sent), headers: { 'X-Mock-Draft': MARKETPLACE_DRAFT_CONTRACT } }
  if (body.website?.trim()) return result
  checkPassword(body.password)
  if (users.findByEmail(body.email)) return result
  const user = users.create({ email: body.email, password: body.password, fullName: body.fullName, phoneNumber: body.phoneNumber, preferredLocale: body.preferredLocale })
  const state = bo()
  state.emailUnverified = { ...state.emailUnverified, [user.id]: true }
  const token = `vfy_${uid(`signup:${user.id}:${getErpDb().clock}`).replace(/-/g, '')}`
  state.emailTokens[token] = { userId: user.id, usedAt: null }
  sendMail(emailVerifyMail({ to: user.email, token, app: 'MARKETPLACE' }))
  recordAudit(ctx, { action: 'USER_CREATED', resource: { type: 'user', id: user.id }, organizationId: null, actor: personActor(user, null, null), after: { emailVerified: false } })
  return result
}

function consumer(auth: AuthContext): AuthContext {
  if (auth.audience !== 'CONSUMER') throw forbidden('Solo para cuentas de consumidor')
  return auth
}

const error = (status: number, code: string, message: string, field: string | null = null, extra: Record<string, unknown> = {}) =>
  new ApiError(status, code, message, [{ field, message, code, ...extra }])

function catalog() {
  return rankedCollections(getErpDb(), publicWineryOf, nowStamp(), market().sold)
}

/** Máximo por pedido y minutos de reserva vigentes (configuración del back office). */
export function purchaseSettings(): PurchaseSettings {
  const max = effectiveSetting('compra.maxBotellasPorCompra').value
  return { maxBottlesPerOrder: typeof max === 'number' && max >= 1 ? max : 6, reservationMinutes: Number(effectiveSetting('compra.minutosReserva').value) || 15, currency: 'BOB' }
}

/** Devuelve al inventario lo apartado por un pedido que ya no se pagará. */
function release(order: StoredOrder): void {
  const db = getErpDb()
  if (order.tokenIds.length > 0) {
    for (const t of db.chain.tokens) if (order.tokenIds.includes(t.id) && t.status === 'RESERVED') t.status = 'MINTED'
  } else market().sold[order.collection.id] = Math.max(0, (market().sold[order.collection.id] ?? 0) - order.quantity)
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
    // Ficha de una colección: el `slug` es único por bodega, así que se resuelve con el de la bodega.
    method: 'get',
    path: '/v1/public/collections/:winerySlug/:slug',
    access: 'public',
    draft: MARKETPLACE_DRAFT_CONTRACT,
    handle({ params }) {
      const found = catalog().find((c) => c.winery.slug === params.winerySlug && c.slug === params.slug)
      if (!found) throw notFound(`Colección "${params.winerySlug}/${params.slug}" no encontrada`)
      return ok((({ createdAt: _createdAt, ...collection }: RankedCollection) => collection)(found))
    },
  },
  {
    // Máximo por compra y minutos de reserva, sin sesión (para el selector de cantidad).
    method: 'get',
    path: '/v1/public/purchase-settings',
    access: 'public',
    draft: MARKETPLACE_DRAFT_CONTRACT,
    handle: () => ok(purchaseSettings()),
  },
  {
    method: 'get',
    path: '/v1/me/consumer',
    access: anyUser,
    draft: MARKETPLACE_DRAFT_CONTRACT,
    handle({ auth }) {
      const { user } = consumer(auth)
      const prefs = prefsOf(user.id)
      // La dirección custodial se asigna al verificar el correo: hasta entonces, `address: null`.
      const address = isEmailVerified(user.id) ? consumerAddressOf(user.id) : null
      const profile: ConsumerProfile = {
        userId: user.id,
        fullName: user.fullName,
        email: user.email,
        emailVerified: isEmailVerified(user.id),
        address: address ? { address, network: getErpDb().chain.network, explorerUrl: explorerAccountUrl(address), custodial: true } : null,
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
      const max = purchaseSettings().maxBottlesPerOrder
      if (body.quantity > max) throw error(422, 'MKT_MAX_PER_ORDER', `Puedes comprar hasta ${max} botellas por pedido`, 'quantity', { rule: 'compra.maxBotellasPorCompra', expected: max, actual: body.quantity })
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
      } else market().sold[item.id] = (market().sold[item.id] ?? 0) + body.quantity
      const minutes = purchaseSettings().reservationMinutes
      const order: StoredOrder = {
        id: newId('order'),
        userId: user.id,
        tokenIds: reserved.map((t) => t.id),
        // El pedido nace `CREATED` y pasa enseguida a esperar el pago.
        status: 'AWAITING_PAYMENT',
        collection: orderCollection(item),
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
            // El pedido que lo compró: sale en los ítems del cierre con faltante (`orderId`, `paidAt`).
            orderId: order.id,
            redeemableAt: redeemable ? at : null,
            redeemWindowEndsAt: redeemable ? new Date(Date.parse(at) + windowDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
          })
        }
        // La entrega en la red (`OPERATOR_TRANSFER`) es de la Ola 4: `transfer` queda en `null`.
        order.tokens = tokens.map((t) => ({ tokenId: t.tokenId, bottleNumber: t.bottleNumber, transfer: null }))
      } else {
        const first = (market().sold[order.collection.id] ?? order.quantity) - order.quantity
        order.tokens = Array.from({ length: order.quantity }, (_, i) => ({ tokenId: first + i, bottleNumber: first + i + 1, transfer: null }))
      }
      return ok(view(order))
    },
  },
]
