import type { Envelope } from '../src'

export const API = 'https://api.test'

export interface CallOptions {
  method?: string
  token?: string | null
  body?: unknown
  form?: FormData
}

/** Llama al backend simulado y devuelve el estado HTTP y el envoltorio. */
export async function call<T = unknown>(path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(`${API}${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body })
  const json = (await res.json()) as Envelope<T>
  return { status: res.status, json }
}

/** Devuelve `data` o falla la prueba con el error del envoltorio. */
export function dataOf<T>(json: Envelope<T>): T {
  if (!json.success) throw new Error(`${json.statusCode} ${json.error.code}: ${json.error.message}`)
  return json.data
}

export async function login(email: string, password = 'demo1234'): Promise<string> {
  const { json } = await call<{ tokens: { accessToken: string } }>('/v1/auth/login', { body: { email, password } })
  return dataOf(json).tokens.accessToken
}
