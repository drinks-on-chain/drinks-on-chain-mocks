import { buildDagGraph, type PassportChain } from '../../derive'
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_IMAGE_BYTES,
  type BottlingBatchResponse,
  type HealthStatus,
  type Liveness,
  type SignedUrlResponse,
  type UploadMimeType,
  type UploadResponse,
} from '../../schemas'
import { anyUser, type AuthContext } from '../auth-context'
import { CLOCK_START, getErpDb, newId, tick } from '../db'
import { ApiError, badRequest, fieldError, invalid, notFound } from '../errors'
import { created, ok, strParam, type RouteSpec } from '../http'
import { findBottling } from './bottling-lab'

// /v1/traceability/*, /v1/uploads*, /v1/health*

function chainOf(): PassportChain {
  const db = getErpDb()
  return {
    wineries: db.wineries,
    terroirs: db.terroirs,
    harvestBatches: db.harvestBatches,
    tanks: db.tanks,
    wineAgings: db.wineAgings,
    productionBatches: db.productionBatches,
    labAnalyses: db.labAnalyses,
  }
}

const dagOf = (b: BottlingBatchResponse) => buildDagGraph(b, chainOf())

// ----- Archivos (almacenamiento privado con URL firmada, como `UploadsService` del backend) -----

/** Vida de la URL firmada (15 min). */
const SIGNED_URL_TTL_MS = 15 * 60_000

/** Tipo real del archivo por su firma de bytes (el backend no se fía del tipo declarado). */
function detectFileType(bytes: Uint8Array): { mimeType: UploadMimeType; extension: string; maxBytes: number } | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (starts(0x25, 0x50, 0x44, 0x46)) return { mimeType: 'application/pdf', extension: '.pdf', maxBytes: UPLOAD_MAX_BYTES }
  if (starts(0xff, 0xd8, 0xff)) return { mimeType: 'image/jpeg', extension: '.jpg', maxBytes: UPLOAD_MAX_IMAGE_BYTES }
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mimeType: 'image/png', extension: '.png', maxBytes: UPLOAD_MAX_IMAGE_BYTES }
  if (starts(0x47, 0x49, 0x46, 0x38)) return { mimeType: 'image/gif', extension: '.gif', maxBytes: UPLOAD_MAX_IMAGE_BYTES }
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mimeType: 'image/webp', extension: '.webp', maxBytes: UPLOAD_MAX_IMAGE_BYTES }
  }
  return null
}

/** Prefijo de la organización activa (`org/<id>`, `org/platform`); solo personal. */
function organizationPrefix(auth: AuthContext): string {
  if (auth.audience !== 'STAFF') throw new ApiError(403, 'FORBIDDEN', 'Solo el personal de una organización puede subir archivos')
  if (auth.organizationType === 'PLATFORM') return 'org/platform'
  if (auth.organizationId) return `org/${auth.organizationId}`
  throw new ApiError(403, 'FORBIDDEN', 'Necesitas una organización activa para subir archivos')
}

function signedUrl(key: string): SignedUrlResponse {
  const expires = getErpDb().clock + SIGNED_URL_TTL_MS
  return {
    key,
    url: `/mocks/uploads/${key}?expires=${Math.floor(expires / 1000)}&signature=mock`,
    expiresAt: new Date(expires).toISOString(),
  }
}

export const traceabilitySystemRoutes: RouteSpec[] = [
  {
    method: 'get',
    path: '/v1/traceability/dag/:bottlingBatchId',
    access: anyUser,
    // El backend no filtra por bodega (cualquier sesión); los mocks sí: una bodega activa solo ve sus lotes.
    handle: ({ auth, params }) => ok(dagOf(findBottling(auth.organizationType === 'WINERY' ? auth : null, params.bottlingBatchId!))),
  },
  {
    method: 'get',
    path: '/v1/traceability/public/:lotCode',
    access: 'public',
    handle({ params }) {
      const code = decodeURIComponent(params.lotCode!)
      const b = getErpDb().bottlings.find((x) => x.internationalLotCode.toUpperCase() === code.toUpperCase() || x.id === code)
      if (!b) throw notFound(`Lote de embotellado con identificador "${code}" no encontrado`)
      return ok(dagOf(b))
    },
  },
  {
    method: 'post',
    path: '/v1/uploads',
    access: anyUser,
    async handle({ request, query, auth }) {
      const prefix = organizationPrefix(auth)
      let form: FormData
      try {
        form = await request.formData()
      } catch {
        throw badRequest('Envíe multipart/form-data con el campo "file"')
      }
      const file = form.get('file')
      if (!file || typeof file === 'string' || file.size === 0) {
        throw invalid([fieldError('file', 'Debe proporcionar un archivo en el campo multipart/form-data "file".')])
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const detected = detectFileType(bytes)
      const declared = (file.type || '').toLowerCase().replace('image/jpg', 'image/jpeg')
      if (!detected || detected.mimeType !== declared) {
        throw new ApiError(422, 'FILE_TYPE_NOT_ALLOWED', 'Tipo de archivo no permitido', [
          fieldError('file', `Tipo de archivo no permitido: el contenido no es ${declared || 'un tipo admitido'}. Se admiten JPEG, PNG, WEBP, GIF y PDF.`),
        ])
      }
      if (bytes.length > detected.maxBytes) {
        throw new ApiError(413, 'FILE_TOO_LARGE', `El archivo supera el máximo de ${Math.round(detected.maxBytes / (1024 * 1024))} MB para ${detected.mimeType}`)
      }
      const folder = (strParam(query, 'folder') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50).toLowerCase() || 'general'
      const now = new Date(Date.parse(tick()))
      const month = String(now.getUTCMonth() + 1).padStart(2, '0')
      const key = `${prefix}/${folder}/${now.getUTCFullYear()}/${month}/${newId('upload')}${detected.extension}`
      const upload: UploadResponse = {
        ...signedUrl(key),
        originalName: (file.name || 'archivo').replace(/[\r\n"]/g, '').slice(0, 255),
        mimeType: detected.mimeType,
        sizeBytes: bytes.length,
      }
      return created(upload)
    },
  },
  {
    method: 'get',
    path: '/v1/uploads/url',
    access: anyUser,
    handle({ query, auth }) {
      if (auth.audience !== 'STAFF') throw new ApiError(403, 'AUTH_INSUFFICIENT_PERMISSIONS', 'No tiene permisos para esta operación')
      const key = strParam(query, 'key')
      if (!key) throw invalid([fieldError('key', 'Campo obligatorio')])
      // La plataforma lee cualquiera; el resto, solo los de su organización (los mocks no guardan los archivos).
      const own = auth.organizationType === 'PLATFORM' ? /^org\/[\w-]+\// : new RegExp(`^org/${auth.organizationId ?? '-'}/`)
      if (key.includes('..') || !own.test(key)) throw new ApiError(404, 'FILE_NOT_FOUND', 'Archivo no encontrado')
      return ok(signedUrl(key))
    },
  },
  {
    method: 'get',
    path: '/v1/health',
    access: 'public',
    handle: () => ok(health()),
  },
  {
    method: 'get',
    path: '/v1/health/live',
    access: 'public',
    handle() {
      const live: Liveness = { status: 'ok', uptime: uptime(), release: null }
      return ok(live)
    },
  },
  {
    method: 'get',
    path: '/v1/health/ready',
    access: 'public',
    handle: () => ok(health()),
  },
]

const uptime = () => (getErpDb().clock - CLOCK_START) / 1000 + 1

function health(): HealthStatus {
  return { status: 'ok', database: 'connected', redis: 'connected', storage: 'connected', worker: 'up', uptime: uptime() }
}
