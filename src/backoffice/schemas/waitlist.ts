import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'

// Lista de espera (plan/contratos/o1b-lista-de-espera.md; backend v0.1.1). Inscripción pública de
// consumidores (landing) y bodegas (sitio de bodegas), y su gestión desde el back office. Los
// mensajes de validación son los del backend (`JoinWaitlistDto`, `UpdateWaitlistEntryDto`).

export const WAITLIST_TYPES = ['CONSUMER', 'WINERY'] as const
export const WaitlistTypeSchema = z.enum(WAITLIST_TYPES)
export type WaitlistType = z.infer<typeof WaitlistTypeSchema>

export const WAITLIST_STATUSES = ['NEW', 'CONTACTED', 'DISCARDED'] as const
export const WaitlistStatusSchema = z.enum(WAITLIST_STATUSES)
export type WaitlistStatus = z.infer<typeof WaitlistStatusSchema>

/** Consumidor: qué le interesa. */
export const WAITLIST_INTERESTS = ['WINE', 'SINGANI', 'BOTH'] as const
export const WaitlistInterestSchema = z.enum(WAITLIST_INTERESTS)
export type WaitlistInterest = z.infer<typeof WaitlistInterestSchema>

/** Bodega: qué produce. */
export const WAITLIST_PRODUCES = ['WINE', 'SINGANI', 'BOTH', 'OTHER'] as const
export const WaitlistProducesSchema = z.enum(WAITLIST_PRODUCES)
export type WaitlistProduces = z.infer<typeof WaitlistProducesSchema>

export const WAITLIST_LOCALES = ['es', 'en'] as const
export const WaitlistLocaleSchema = z.enum(WAITLIST_LOCALES)
export type WaitlistLocale = z.infer<typeof WaitlistLocaleSchema>

/** WhatsApp: 7–20 caracteres entre dígitos, espacios y `+ - ( )`. */
export const WAITLIST_PHONE_PATTERN = /^[0-9+\-() ]{7,20}$/
/** Origen de la inscripción: hasta 40 caracteres `[a-z0-9-]` (p. ej. `tarija-2026`). */
export const WAITLIST_SOURCE_PATTERN = /^[a-z0-9-]{1,40}$/
/** Tipo de recurso de la lista de espera en la bitácora. */
export const WAITLIST_RESOURCE_TYPE = 'waitlist_entry'
/** Inscripciones por hora de un mismo correo (más → 429 `TOO_MANY_REQUESTS` con `Retry-After`). */
export const WAITLIST_EMAIL_LIMIT_PER_HOUR = 3

// ---------------------------------------------------------------------------
// Inscripción pública
// ---------------------------------------------------------------------------

/** Texto recortado; vacío → `null` (como el backend). */
const emptyToNull = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
const lowerOrNull = (value: unknown): unknown => {
  const out = emptyToNull(value)
  return typeof out === 'string' ? out.toLowerCase() : out
}
/** Correo normalizado: minúsculas y sin espacios. */
const normalizeEmail = (value: unknown): unknown => (typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : value)

const FULL_NAME = 'El nombre debe tener entre 2 y 120 caracteres'
const WINERY_NAME = 'El nombre de la bodega debe tener entre 2 y 160 caracteres'
const wineryName = z.string('El nombre de la bodega es obligatorio').min(2, WINERY_NAME).max(160, WINERY_NAME)

const joinFields = {
  /** Persona (consumidor) o persona de contacto (bodega). */
  fullName: z.string('El nombre es obligatorio').trim().min(2, FULL_NAME).max(120, FULL_NAME),
  /** Se normaliza a minúsculas y sin espacios. */
  email: z.preprocess(normalizeEmail, z.email('El correo electrónico debe ser válido').max(255, 'El correo es demasiado largo')),
  /** WhatsApp, opcional. */
  phone: z.preprocess(
    emptyToNull,
    z.string().regex(WAITLIST_PHONE_PATTERN, 'El teléfono debe tener entre 7 y 20 caracteres: dígitos, espacios y + - ( )').nullish(),
  ),
  /** Consumidor. */
  city: z.preprocess(emptyToNull, z.string().max(80, 'La ciudad admite hasta 80 caracteres').nullish()),
  interest: z.enum(WAITLIST_INTERESTS, 'Interés no válido').nullish(),
  /** Bodega: valle o región. */
  region: z.preprocess(emptyToNull, z.string().max(80, 'La región admite hasta 80 caracteres').nullish()),
  produces: z.enum(WAITLIST_PRODUCES, 'Producción no válida').nullish(),
  message: z.preprocess(emptyToNull, z.string().max(500, 'El mensaje admite hasta 500 caracteres').nullish()),
  /** Acepta ser contactado y el aviso de privacidad. */
  consent: z.literal(true, 'Debes aceptar el aviso de privacidad para inscribirte'),
  /** Por defecto `es`. */
  locale: z.enum(WAITLIST_LOCALES, 'Idioma no válido (es o en)').nullish(),
  /** Origen de la inscripción (`?src=` de la landing); se pasa a minúsculas. */
  source: z.preprocess(
    lowerOrNull,
    z.string().regex(WAITLIST_SOURCE_PATTERN, 'El origen admite hasta 40 caracteres: letras minúsculas, números y guiones').nullish(),
  ),
  /**
   * Token de Cloudflare Turnstile: el backend solo lo exige con `WAITLIST_CAPTCHA_REQUIRED=true`.
   * En los mocks es opcional y, si llega con `fail`, responde 422 `CAPTCHA_INVALID`.
   */
  captchaToken: z.string().max(2048).nullish(),
  /** Campo trampa: debe llegar vacío; si no, 201 con una posición verosímil sin guardar nada. */
  website: z.string().max(500).nullish(),
}

/** Consumidor (landing): `isAdult` obligatorio y `true` (Ley 259). */
export const WaitlistConsumerJoinSchema = z.object({
  type: z.literal('CONSUMER'),
  ...joinFields,
  isAdult: z.literal(true, 'Debes confirmar que eres mayor de edad'),
  wineryName: z.preprocess(emptyToNull, wineryName.nullish()),
})

/** Bodega (sitio de bodegas): `wineryName` obligatorio. */
export const WaitlistWineryJoinSchema = z.object({
  type: z.literal('WINERY'),
  ...joinFields,
  isAdult: z.boolean('isAdult debe ser verdadero o falso').nullish(),
  wineryName: z.preprocess(emptyToNull, wineryName),
})

/** `POST /v1/public/waitlist`. */
export const WaitlistJoinRequestSchema = z.discriminatedUnion('type', [WaitlistConsumerJoinSchema, WaitlistWineryJoinSchema], {
  error: 'Tipo de lista no válido',
})
export type WaitlistJoinRequest = z.infer<typeof WaitlistJoinRequestSchema>

/** Respuesta 201: `position` = número de orden dentro de su tipo (desde 1). */
export const WaitlistJoinResponseSchema = z.object({
  type: WaitlistTypeSchema,
  position: z.number().int().min(1),
})
export type WaitlistJoinResponse = z.infer<typeof WaitlistJoinResponseSchema>

/** `GET /v1/public/waitlist/stats`: inscritos por tipo («ya somos N»). */
export const WaitlistStatsSchema = z.object({
  consumers: z.number().int().min(0),
  wineries: z.number().int().min(0),
})
export type WaitlistStats = z.infer<typeof WaitlistStatsSchema>

// ---------------------------------------------------------------------------
// Back office
// ---------------------------------------------------------------------------

/** Inscripción vista desde el back office (`WaitlistEntryDto`). */
export const WaitlistEntrySchema = z.object({
  id: z.string(),
  type: WaitlistTypeSchema,
  /** Número de orden dentro de su tipo (desde 1). */
  position: z.number().int().min(1),
  status: WaitlistStatusSchema,
  fullName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  interest: WaitlistInterestSchema.nullable(),
  wineryName: z.string().nullable(),
  region: z.string().nullable(),
  produces: WaitlistProducesSchema.nullable(),
  message: z.string().nullable(),
  locale: WaitlistLocaleSchema,
  /** `null` = inscripción sin origen. */
  source: z.string().nullable(),
  consentAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  contactedAt: IsoDateTimeSchema.nullable(),
  /** Nombre de quien lo marcó como contactado. */
  contactedBy: z.string().nullable(),
  /** Notas internas del back office. */
  notes: z.string().nullable(),
})
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>

/** Elemento de `GET /v1/platform/waitlist/sources`. */
export const WaitlistSourceSchema = z.object({
  source: z.string().nullable(),
  count: z.number().int().min(1),
})
export type WaitlistSource = z.infer<typeof WaitlistSourceSchema>

/** `GET /v1/platform/waitlist/sources`: arreglo plano, del origen más numeroso al menos. */
export const WaitlistSourcesSchema = z.array(WaitlistSourceSchema)

/**
 * `PATCH /v1/platform/waitlist/{id}`. Al pasar a `CONTACTED` se guardan `contactedAt` y quién; al
 * volver a `NEW` se borran. `notes: null` (o vacío) borra las notas.
 */
export const UpdateWaitlistEntrySchema = z.object({
  status: z.enum(WAITLIST_STATUSES, 'Estado no válido').optional(),
  notes: z.preprocess(emptyToNull, z.string().max(1000, 'Las notas admiten hasta 1000 caracteres').nullable().optional()),
})
export type UpdateWaitlistEntryDto = z.infer<typeof UpdateWaitlistEntrySchema>

/** Bloque `waitlist` del tablero (`GET /v1/platform/dashboard`). */
export const DashboardWaitlistSchema = z.object({
  consumers: z.number().int().min(0),
  wineries: z.number().int().min(0),
  /** Inscripciones de las últimas 24 h (los dos tipos). */
  last24h: z.number().int().min(0),
})
export type DashboardWaitlist = z.infer<typeof DashboardWaitlistSchema>

/** Columnas del CSV de `GET /v1/platform/waitlist/export`: las claves de `WaitlistEntry` sin `id`. */
export const WAITLIST_CSV_COLUMNS = [
  'position',
  'type',
  'status',
  'fullName',
  'email',
  'phone',
  'city',
  'interest',
  'wineryName',
  'region',
  'produces',
  'message',
  'locale',
  'source',
  'consentAt',
  'createdAt',
  'contactedAt',
  'contactedBy',
  'notes',
] as const satisfies readonly (keyof WaitlistEntry)[]

/** Máximo de filas de una exportación (más → 422 `WAITLIST_EXPORT_TOO_LARGE`). */
export const WAITLIST_EXPORT_MAX_ROWS = 50_000
