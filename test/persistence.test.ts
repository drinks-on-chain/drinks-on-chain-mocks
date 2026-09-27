import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { API } from './helpers'

// En el navegador el estado de la Ola 1 (y la identidad del ERP) sobrevive a una recarga, como las
// sesiones: se simula `window` + `localStorage` y se vuelven a cargar los módulos.

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

const g = globalThis as unknown as { window?: unknown; localStorage?: MemoryStorage }
beforeAll(() => {
  g.window = globalThis
  g.localStorage = new MemoryStorage()
})
afterAll(() => {
  delete g.window
  delete g.localStorage
  vi.resetModules()
})

describe('persistencia en localStorage (doc-mocks:state)', () => {
  it('una bodega creada por el back office sigue ahí tras "recargar" y resetErpDb la borra', async () => {
    vi.resetModules()
    const first = await import('../src/node')
    first.resetErpDb()
    const server = first.setupMockServer({ baseUrl: API })
    server.listen({ onUnhandledRequest: 'error' })
    const res = await fetch(`${API}/v1/platform/wineries`, {
      method: 'POST',
      headers: { Authorization: 'Bearer mock.access.operaciones', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legalName: 'Persistente S.R.L.',
        tradeName: 'Bodega Persistente',
        taxId: '7600445566',
        category: 'WINERY',
        region: 'Tarija',
        contactEmail: 'hola@persistente.test',
        ownerEmail: 'duena@persistente.test',
        ownerFullName: 'Dueña Persistente',
      }),
    })
    expect(res.status).toBe(201)
    const { data } = (await res.json()) as { data: { winery: { id: string } } }
    server.close()
    expect(g.localStorage!.getItem('doc-mocks:state')).toContain('Bodega Persistente')

    vi.resetModules()
    const second = await import('../src/node')
    const db = second.getErpDb()
    expect(db.wineries.find((w) => w.id === data.winery.id)?.commercialName).toBe('Bodega Persistente')
    expect(second.mockMailbox.latest({ to: 'duena@persistente.test' })?.template).toBe('INVITATION')
    const { verifyAuditChain } = await import('../src/backoffice/model')
    expect(verifyAuditChain(db.backoffice.audit).valid).toBe(true)

    second.resetErpDb()
    expect(g.localStorage!.getItem('doc-mocks:state')).toBeNull()
    expect(second.getErpDb().wineries.some((w) => w.id === data.winery.id)).toBe(false)
  })
})
