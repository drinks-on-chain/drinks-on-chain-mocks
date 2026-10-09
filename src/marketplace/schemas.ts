import { z } from 'zod'
import { ChainNetworkSchema, ChainTxRefSchema } from '../chain/schemas'
import { IsoDateTimeSchema } from '../erp/schemas/common'
import { CollectionPriceInputSchema } from '../tokenization/schemas'

// BORRADOR del dominio `marketplace` (contrato de la Ola 3 §13.1): cuenta del consumidor (pantalla
// 2B) y compra con pasarela de prueba (2C). **No está en el OpenAPI del backend**: lo fijará el
// contrato de la Ola 4 (`plan/contratos/o4-marketplace.md`, pendiente) y puede cambiar sin aviso.
// Las rutas responden `X-Mock-Draft` y quedan fuera de la prueba de contrato contra el OpenAPI.

/** Contrato que adelanta el borrador (valor de `RouteSpec.draft` y de `X-Mock-Draft`). */
export const MARKETPLACE_DRAFT_CONTRACT = 'plan/contratos/o3-tokenizacion.md §13.1'

/** @experimental Borrador (§13.1): perfil del consumidor con su dirección custodial informativa. */
export const ConsumerProfileSchema = z.object({
  userId: z.string(),
  fullName: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  /** Dirección derivada que gestiona Drinks on Chain (solo lectura); `null` si aún no se asignó. */
  address: z.object({ address: z.string(), network: ChainNetworkSchema, explorerUrl: z.string(), custodial: z.literal(true) }).nullable(),
  preferences: z.object({ lotProgress: z.boolean(), redemptionReminders: z.boolean(), promotions: z.boolean() }),
  createdAt: IsoDateTimeSchema,
})
/** @experimental */
export type ConsumerProfile = z.infer<typeof ConsumerProfileSchema>

/**
 * @experimental `POST /v1/auth/signup` del borrador (§13.1): alta del consumidor con captcha, campo
 * trampa y verificación del correo. El OpenAPI vigente sigue declarando el alta sin captcha (201 con
 * sesión): los mocks responden con esta forma **solo si el cuerpo trae `captchaToken`**.
 */
export const ConsumerSignupSchema = z.object({
  email: z.email('El correo no es válido'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
  fullName: z.string().trim().min(1, 'El nombre es obligatorio'),
  phoneNumber: z.string().nullish(),
  preferredLocale: z.string().nullish(),
  acceptTerms: z.literal(true, 'Debes aceptar los términos'),
  ageDeclaration: z.literal(true, 'Debes declarar que eres mayor de edad'),
  captchaToken: z.string().min(1, 'Falta el captcha'),
  /** Campo trampa: los navegadores lo dejan vacío; relleno → 202 sin crear nada. */
  website: z.string().nullish(),
})
/** @experimental */
export type ConsumerSignupDto = z.infer<typeof ConsumerSignupSchema>

/** @experimental Respuesta 202 del alta del borrador: el correo de verificación va en camino. */
export const ConsumerSignupAcceptedSchema = z.object({ status: z.literal('VERIFICATION_SENT') })
/** @experimental */
export type ConsumerSignupAccepted = z.infer<typeof ConsumerSignupAcceptedSchema>

/** @experimental `GET /v1/public/purchase-settings` del borrador: lo que el Marketplace necesita saber antes de comprar. */
export const PurchaseSettingsSchema = z.object({
  /** `compra.maxBotellasPorCompra`: máximo de botellas por pedido (más → 422 `MKT_MAX_PER_ORDER`). */
  maxBottlesPerOrder: z.number().int().min(1),
  /** `compra.minutosReserva`: minutos que se guardan las botellas de un pedido sin pagar. */
  reservationMinutes: z.number().int().min(1),
  currency: z.literal('BOB'),
})
/** @experimental */
export type PurchaseSettings = z.infer<typeof PurchaseSettingsSchema>

/** Cuenta de consumidor de demostración con pedidos sembrados (`GET /v1/orders`). */
export const MARKETPLACE_DEMO_ACCOUNT = { key: 'maria', email: 'maria@tribu.test' } as const

export const ORDER_STATUSES = ['CREATED', 'AWAITING_PAYMENT', 'PAID', 'DELIVERING', 'COMPLETED', 'EXPIRED', 'PAYMENT_FAILED'] as const
/** @experimental */
export const OrderStatusSchema = z.enum(ORDER_STATUSES)
/** @experimental */
export type OrderStatus = z.infer<typeof OrderStatusSchema>

export const PAYMENT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const

/** @experimental Borrador (§13.1): pedido de botellas de una colección. */
export const OrderSchema = z.object({
  id: z.string(),
  status: OrderStatusSchema,
  collection: z.object({ id: z.string(), slug: z.string(), name: z.string(), coverImageUrl: z.string().nullable(), winery: z.object({ slug: z.string(), tradeName: z.string() }) }),
  quantity: z.number().int().min(1),
  unitPrice: CollectionPriceInputSchema,
  total: CollectionPriceInputSchema,
  /** Hasta cuándo se guardan las botellas (`compra.minutosReserva`); `null` cuando ya no aplica. */
  reservedUntil: IsoDateTimeSchema.nullable(),
  payment: z.object({ id: z.string(), provider: z.literal('TEST'), status: z.enum(PAYMENT_STATUSES), paidAt: IsoDateTimeSchema.nullable() }),
  /** NFT del pedido: vacío hasta `PAID` («pago recibido» antes de mostrarlos, A-23). */
  tokens: z.array(z.object({ tokenId: z.number().int().min(0), bottleNumber: z.number().int().min(1), transfer: ChainTxRefSchema.nullable() })),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
/** @experimental */
export type Order = z.infer<typeof OrderSchema>

/** @experimental `POST /v1/orders`. */
export const CreateOrderSchema = z.object({ collectionId: z.string().min(1), quantity: z.number().int().min(1) })
/** @experimental */
export type CreateOrderDto = z.infer<typeof CreateOrderSchema>

export const PAYMENT_SIMULATION_OUTCOMES = ['APPROVE', 'REJECT', 'DELAY'] as const
/** @experimental `POST /v1/payments/test/{paymentId}/simulate` (solo desarrollo y mocks). */
export const SimulatePaymentSchema = z.object({ outcome: z.enum(PAYMENT_SIMULATION_OUTCOMES) })
/** @experimental */
export type SimulatePaymentDto = z.infer<typeof SimulatePaymentSchema>

/** Códigos de error del borrador (los definitivos serán los `MKT_…` del contrato de la Ola 4). */
export const MARKETPLACE_DRAFT_ERROR_CODES = ['MKT_COLLECTION_NOT_FOUND', 'MKT_COLLECTION_NOT_ON_SALE', 'MKT_PRICE_UNDEFINED', 'MKT_MAX_PER_ORDER', 'MKT_NOT_ENOUGH_STOCK', 'MKT_ORDER_NOT_FOUND', 'MKT_PAYMENT_NOT_FOUND', 'MKT_PAYMENT_NOT_PENDING'] as const
