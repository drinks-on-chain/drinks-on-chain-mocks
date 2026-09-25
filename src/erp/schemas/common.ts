import { z } from 'zod'

/** Fecha y hora ISO 8601 tal como la devuelve el backend (`2026-09-25T12:00:00Z` o con milisegundos). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true })

/** Fecha de entrada en los DTO de creación: el backend acepta `YYYY-MM-DD` o fecha y hora ISO. */
export const DateInputSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })])

/** Objeto libre (`additionalParams`, polígonos GeoJSON…). */
export const JsonObjectSchema = z.record(z.string(), z.unknown())

/** Polígono GeoJSON de una parcela. */
export const GeoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
})
export type GeoJsonPolygon = z.infer<typeof GeoJsonPolygonSchema>

/** Geometría GeoJSON genérica tal como la guarda el backend (`type: object` en el OpenAPI). */
export const GeoJsonGeometrySchema = z.looseObject({
  type: z.string(),
  coordinates: z.array(z.unknown()),
})
export type GeoJsonGeometry = z.infer<typeof GeoJsonGeometrySchema>
