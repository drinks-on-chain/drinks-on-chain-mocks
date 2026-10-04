import { z } from 'zod'
import { IsoDateTimeSchema } from './common'

// GET /v1/health, /v1/health/live, /v1/health/ready · POST /v1/uploads, GET /v1/uploads/url

/** `HealthStatusDataDto`: `/v1/health` y `/v1/health/ready` (503 con `degraded` si falta una dependencia). */
export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.string(),
  redis: z.string(),
  storage: z.enum(['connected', 'disconnected', 'not_configured']),
  worker: z.enum(['up', 'down']),
  uptime: z.number(),
})
export type HealthStatus = z.infer<typeof HealthStatusSchema>

/** `LivenessDataDto`: `/v1/health/live` (el proceso responde). */
export const LivenessSchema = z.object({
  status: z.string(),
  uptime: z.number(),
  release: z.string().nullable(),
})
export type Liveness = z.infer<typeof LivenessSchema>

/** Carpetas usadas por el ERP en `POST /v1/uploads?folder=…` (el backend admite cualquiera: letras, números, `-` y `_`). */
export const UPLOAD_FOLDERS = ['inspections', 'labels', 'lab-reports', 'certificates', 'logos', 'licenses'] as const

/** Tipos admitidos por el backend (reconocidos por el contenido del archivo, no por la extensión). */
export const UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const
export const UploadMimeTypeSchema = z.enum(UPLOAD_MIME_TYPES)
export type UploadMimeType = z.infer<typeof UploadMimeTypeSchema>
/** Tamaño máximo de un PDF (15 MB). */
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024
/** Tamaño máximo de una imagen (5 MB). */
export const UPLOAD_MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * `UploadResponseDto`: el archivo queda en el almacenamiento privado. Se guarda `key`
 * (`org/<organización>/<carpeta>/<aaaa>/<mm>/<uuid>.<ext>`); `url` es una URL firmada que caduca
 * en `expiresAt` (15 min) y se vuelve a pedir con `GET /v1/uploads/url?key=`.
 */
export const UploadResponseSchema = z.object({
  key: z.string(),
  url: z.string(),
  expiresAt: IsoDateTimeSchema,
  originalName: z.string(),
  mimeType: UploadMimeTypeSchema,
  sizeBytes: z.number(),
  /** Huella SHA-256 (hexadecimal) del contenido: la que guardan los registros de la trazabilidad junto a la `key`. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type UploadResponse = z.infer<typeof UploadResponseSchema>

/** `SignedUrlResponseDto`: `GET /v1/uploads/url?key=`. */
export const SignedUrlResponseSchema = z.object({
  key: z.string(),
  url: z.string(),
  expiresAt: IsoDateTimeSchema,
})
export type SignedUrlResponse = z.infer<typeof SignedUrlResponseSchema>
