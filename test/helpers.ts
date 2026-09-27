import type { Envelope, LoginResponse, SessionResponse } from '../src'
import { DEMO_TOTP_SECRET, generateTotp } from '../src/fixtures'

export const API = 'https://api.test'

export interface CallOptions {
  method?: string
  token?: string | null
  body?: unknown
  form?: FormData
  headers?: Record<string, string>
}

/** Llama al backend simulado y devuelve el estado HTTP, las cabeceras y el envoltorio. */
export async function call<T = unknown>(path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(`${API}${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body })
  const text = await res.text()
  const json = (text ? JSON.parse(text) : null) as Envelope<T>
  return { status: res.status, json, headers: res.headers }
}

/** Devuelve `data` o falla la prueba con el error del envoltorio. */
export function dataOf<T>(json: Envelope<T>): T {
  if (!json.success) throw new Error(`${json.statusCode} ${json.error.code}: ${json.error.message}`)
  return json.data
}

/**
 * Inicia sesión y, si es personal de plataforma, completa el segundo factor con el TOTP de demo
 * (inscribiéndolo si hace falta). Devuelve la respuesta de sesión.
 */
export async function loginSession(email: string, password = 'demo1234'): Promise<SessionResponse> {
  const first = dataOf((await call<LoginResponse>('/v1/auth/login', { body: { email, password } })).json)
  if (!('mfa' in first)) return first
  const { mfaToken, enrolled } = first.mfa
  if (!enrolled) {
    const { secret } = dataOf((await call<{ secret: string }>('/v1/auth/mfa/enroll', { body: { mfaToken } })).json)
    return dataOf((await call<SessionResponse>('/v1/auth/mfa/enroll/confirm', { body: { mfaToken, code: generateTotp(secret) } })).json)
  }
  return dataOf((await call<SessionResponse>('/v1/auth/mfa/verify', { body: { mfaToken, code: generateTotp(DEMO_TOTP_SECRET) } })).json)
}

/** Token de acceso de una sesión nueva (con el segundo factor si hace falta). */
export async function login(email: string, password = 'demo1234'): Promise<string> {
  return (await loginSession(email, password)).tokens.accessToken
}
