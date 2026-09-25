import { z } from 'zod'

// ÚNICO lugar donde vive la suposición sobre la forma de las listas (doc 09 §8 punto 1).
// El OpenAPI no declara el esquema de respuesta de los GET de colección. Hasta que backend
// lo confirme, los mocks responden `data: { items, total, limit, offset }`. Si backend
// confirma un array plano, basta con cambiar LIST_SHAPE a 'array'.

export type ListShape = 'paged' | 'array'
export const LIST_SHAPE: ListShape = 'paged'

export const DEFAULT_LIMIT = 50
export const DEFAULT_OFFSET = 0

export interface Paged<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

/** Lo que devuelve una lista según LIST_SHAPE. */
export type ListPayload<T> = Paged<T> | T[]

export function pagedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
}

/** Esquema de `data` de una lista, acorde a LIST_SHAPE. */
export function listSchema<T extends z.ZodType>(item: T) {
  return LIST_SHAPE === 'paged' ? pagedSchema(item) : z.array(item)
}

/** Construye `data` de una lista a partir de la página ya recortada. */
export function toListPayload<T>(page: Paged<T>, shape: ListShape = LIST_SHAPE): ListPayload<T> {
  return shape === 'paged' ? page : page.items
}

/**
 * Normaliza `data` de una lista, venga como array o como página. Para el cliente del ERP:
 * así el código de la app no depende de cuál forma confirme el backend.
 */
export function unwrapList<T>(data: ListPayload<T>): Paged<T> {
  if (Array.isArray(data)) return { items: data, total: data.length, limit: data.length, offset: 0 }
  return data
}
