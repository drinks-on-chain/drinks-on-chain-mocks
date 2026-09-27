import { z } from 'zod'

// Forma de las listas (contrato de la Ola 0 §2): todo GET de colección devuelve
// `data: { items, total, limit, offset }`, con `limit` 20 por defecto y 100 como máximo
// (más → 422) y `offset` ≥ 0. Incluye `wineries/pending` y `wineries/my/members`.

export type ListShape = 'paged' | 'array'
/** Forma confirmada por el contrato de la Ola 0. Se conserva por compatibilidad con 0.1. */
export const LIST_SHAPE: ListShape = 'paged'

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100
export const DEFAULT_OFFSET = 0

/** Página de una colección. */
export interface ListPage<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}
/** Alias de 0.1. */
export type Paged<T> = ListPage<T>

/** Lo que podía devolver una lista en 0.1 (página o array plano). */
export type ListPayload<T> = ListPage<T> | T[]

/** Esquema de una página `{ items, total, limit, offset }`. */
export function listPageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1).max(MAX_LIMIT),
    offset: z.number().int().min(0),
  })
}
/** Alias de 0.1. */
export const pagedSchema = listPageSchema

/** Esquema de `data` de una lista. */
export function listSchema<T extends z.ZodType>(item: T) {
  return listPageSchema(item)
}

/** Construye `data` de una lista a partir de la página ya recortada. */
export function toListPayload<T>(page: ListPage<T>, shape: ListShape = LIST_SHAPE): ListPayload<T> {
  return shape === 'paged' ? page : page.items
}

/**
 * Normaliza `data` de una lista, venga como array (backend anterior al contrato de la Ola 0)
 * o como página.
 */
export function unwrapList<T>(data: ListPayload<T>): ListPage<T> {
  if (Array.isArray(data)) return { items: data, total: data.length, limit: data.length, offset: 0 }
  return data
}
