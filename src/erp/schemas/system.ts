import { z } from 'zod'

// GET /v1/health · POST /v1/uploads

export const HealthStatusSchema = z.object({
  status: z.string(),
  database: z.string(),
  redis: z.string(),
  uptime: z.number(),
})
export type HealthStatus = z.infer<typeof HealthStatusSchema>

/** Carpetas usadas por el ERP en `POST /v1/uploads?folder=…`. */
export const UPLOAD_FOLDERS = ['inspections', 'labels', 'lab-reports', 'certificates', 'logos', 'licenses'] as const

/** Tipos MIME admitidos por el backend (≤ 15 MB). */
export const UPLOAD_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'image/gif',
] as const
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024

export const UploadResponseSchema = z.object({
  url: z.string(),
  key: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
})
export type UploadResponse = z.infer<typeof UploadResponseSchema>
