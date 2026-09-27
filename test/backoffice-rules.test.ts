import { describe, expect, it } from 'vitest'
import { APPLICATION_STATUSES, APPLICATION_TRANSITIONS, isMfaChallenge } from '../src'
import {
  auditHash,
  chainAuditEvent,
  deriveLotPrefix,
  effectiveInvitationStatus,
  isBelowLegalMinimum,
  slugify,
  uniqueSlug,
  validateSettingValue,
  verifyAuditChain,
  type AuditInput,
} from '../src/backoffice/model'
import { SETTINGS_CATALOG, settingEntry } from '../src/backoffice/settings-catalog'
import { canonicalJson, sha256Hex } from '../src/shared/crypto'
import { base32Decode, DEMO_TOTP_SECRET, generateTotp, otpauthUrl, verifyTotp } from '../src/shared/totp'
import { backofficeFixtures } from '../src/fixtures'
import { uid } from '../src/shared/uuid'

// Reglas puras de la Ola 1: transiciones de solicitud, prefijo de lote, configuración (tipos,
// límites, mínimos legales), bitácora encadenada y TOTP.

describe('solicitudes: transiciones (docs-back/07 §1.2)', () => {
  it('siguen el diagrama de estados', () => {
    expect(APPLICATION_TRANSITIONS).toEqual({
      UNVERIFIED: ['RECEIVED'],
      RECEIVED: ['IN_REVIEW'],
      IN_REVIEW: ['MEETING_SCHEDULED', 'APPROVED', 'REJECTED'],
      MEETING_SCHEDULED: ['IN_REVIEW'],
      APPROVED: [],
      REJECTED: [],
    })
    for (const s of APPLICATION_STATUSES) expect(APPLICATION_TRANSITIONS[s]).not.toContain(s)
  })
})

describe('bodegas: slug y prefijo de lote (ORG-05)', () => {
  it('slug sin tildes ni el prefijo "bodega", único', () => {
    expect(slugify('Bodega Sol de Padcaya')).toBe('sol-de-padcaya')
    expect(slugify('Viñedos del Guadalquivir')).toBe('vinedos-del-guadalquivir')
    expect(uniqueSlug('Casa Uriondo', new Set(['casa-uriondo']))).toBe('casa-uriondo-2')
  })

  it('3 letras del nombre comercial, código del catálogo si lo hay, y desambiguación hasta 5 letras', () => {
    expect(deriveLotPrefix('x', 'Bodega Sol de Padcaya', new Set())).toBe('SPA')
    expect(deriveLotPrefix('x', 'Destilería Río Pilaya', new Set())).toBe('RPI')
    expect(deriveLotPrefix('x', 'Cervecería Andina', new Set())).toBe('AND')
    expect(deriveLotPrefix(uid('winery:guadalquivir'), 'Viñedos del Guadalquivir', new Set())).toBe('VGQ')
    const taken = new Set(['SPA'])
    const second = deriveLotPrefix('y', 'Bodega Sol de Padcaya', taken)
    expect(second).toMatch(/^[A-Z]{3,5}$/)
    expect(second).not.toBe('SPA')
    expect(deriveLotPrefix('z', 'Bodega Sol de Padcaya', new Set(['SPA', second]))).not.toBe(second)
  })
})

describe('configuración: tipos, límites y mínimos legales (CFG-01, A-31)', () => {
  const entry = (key: string) => settingEntry(key)!

  it('valida el tipo, los límites y la enumeración', () => {
    expect(validateSettingValue(entry('canje.ventanaDias'), 45)).toBeNull()
    expect(validateSettingValue(entry('canje.ventanaDias'), '45')).toBe('Debe ser un número')
    expect(validateSettingValue(entry('canje.ventanaDias'), 0)).toBe('Debe ser mayor o igual que 1')
    expect(validateSettingValue(entry('canje.ventanaDias'), 400)).toBe('Debe ser menor o igual que 365')
    expect(validateSettingValue(entry('equipo.maxColaboradoresPorBodega'), null)).toBeNull()
    expect(validateSettingValue(entry('puntos.bodegaPuedeHabilitar'), 'sí')).toMatch(/boolean/)
    expect(validateSettingValue(entry('canje.ventanaVencida.accion'), 'EXTEND')).toBeNull()
    expect(validateSettingValue(entry('canje.ventanaVencida.accion'), 'quemar')).toMatch(/BURN, EXTEND, COMPENSATE/)
    expect(validateSettingValue(entry('trazabilidad.singani.variedadesExigidas'), [])).toMatch(/lista/)
    expect(validateSettingValue(entry('trazabilidad.laboratorio.limites'), [1])).toBe('Debe ser un objeto')
  })

  it('el valor por defecto de cada parámetro es válido y no rompe su mínimo legal', () => {
    for (const s of SETTINGS_CATALOG) {
      expect(validateSettingValue(s, s.default), s.key).toBeNull()
      expect(isBelowLegalMinimum(s, s.default), s.key).toBe(false)
    }
  })

  it('más laxo que el mínimo legal: altitud o reposo menores, cepas fuera de la lista', () => {
    expect(isBelowLegalMinimum(entry('trazabilidad.singani.altitudMinimaMsnm'), 1500)).toBe(true)
    expect(isBelowLegalMinimum(entry('trazabilidad.singani.altitudMinimaMsnm'), 1800)).toBe(false)
    expect(isBelowLegalMinimum(entry('trazabilidad.singani.reposoMinimoDias'), 179)).toBe(true)
    expect(isBelowLegalMinimum(entry('trazabilidad.singani.variedadesExigidas'), ['Moscatel de Alejandría', 'Torrontés'])).toBe(true)
    expect(isBelowLegalMinimum(entry('trazabilidad.singani.variedadesExigidas'), ['Moscatel de Alejandría'])).toBe(false)
    expect(isBelowLegalMinimum(entry('canje.ventanaDias'), 1)).toBe(false)
  })
})

describe('invitaciones: caducidad', () => {
  it('una pendiente cuya caducidad pasó está EXPIRED; las demás conservan su estado', () => {
    const inv = { status: 'PENDING' as const, expiresAt: '2026-09-26T11:00:00Z' }
    expect(effectiveInvitationStatus(inv, '2026-09-25T12:00:00Z')).toBe('PENDING')
    expect(effectiveInvitationStatus(inv, '2026-09-26T11:00:00Z')).toBe('EXPIRED')
    expect(effectiveInvitationStatus({ ...inv, status: 'REVOKED' }, '2027-01-01T00:00:00Z')).toBe('REVOKED')
  })
})

describe('bitácora encadenada por hash (AUD-02)', () => {
  const input = (action: string): AuditInput => ({
    occurredAt: '2026-09-25T12:00:00Z',
    actor: { userId: null, fullName: null, role: null, organizationId: null, viaPlatform: false },
    source: { app: 'WORKER', ip: null, deviceId: null },
    action,
    resource: { type: 'TEST', id: null },
    organizationId: null,
    before: null,
    after: { b: 1, a: [2, { d: 3, c: 4 }] },
    reason: null,
    correlationId: null,
  })

  it('SHA-256 del JSON canónico del evento sin hash (claves ordenadas) que incluye prevHash', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }], z: undefined })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}')
    const first = chainAuditEvent(undefined, input('A'), 'id-1')
    const second = chainAuditEvent(first, input('B'), 'id-2')
    expect(first).toMatchObject({ seq: 1, prevHash: null })
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash })
    const { hash, ...rest } = second
    expect(hash).toBe(sha256Hex(canonicalJson(rest)))
    expect(auditHash(rest)).toBe(hash)
  })

  it('verify detecta un evento alterado, uno borrado y los cuenta por intervalo', () => {
    const chain = backofficeFixtures.audit
    expect(verifyAuditChain(chain).valid).toBe(true)
    const tampered = chain.map((e) => (e.seq === 40 ? { ...e, reason: 'alterado' } : e))
    expect(verifyAuditChain(tampered)).toMatchObject({ valid: false, firstBrokenSeq: 40 })
    const withGap = chain.filter((e) => e.seq !== 60)
    expect(verifyAuditChain(withGap)).toMatchObject({ valid: false, firstBrokenSeq: 61 })
    const from = Date.parse('2026-09-01T00:00:00Z')
    const inRange = chain.filter((e) => Date.parse(e.occurredAt) >= from).length
    expect(verifyAuditChain(chain, { from })).toEqual({ valid: true, checked: inRange, firstBrokenSeq: null })
  })
})

describe('TOTP (RFC 6238)', () => {
  it('vectores de la RFC (6 dígitos, SHA-1)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // "12345678901234567890"
    expect(base32Decode(secret)).toEqual(new TextEncoder().encode('12345678901234567890'))
    expect(generateTotp(secret, 59_000)).toBe('287082')
    expect(generateTotp(secret, 1_111_111_109_000)).toBe('081804')
    expect(generateTotp(secret, 2_000_000_000_000)).toBe('279037')
  })

  it('acepta el paso actual ± 1 (30 s) y rechaza el resto', () => {
    const t = Date.parse('2026-09-25T12:00:10Z')
    const code = generateTotp(DEMO_TOTP_SECRET, t)
    expect(verifyTotp(DEMO_TOTP_SECRET, code, t)).toBe(true)
    expect(verifyTotp(DEMO_TOTP_SECRET, code, t + 30_000)).toBe(true)
    expect(verifyTotp(DEMO_TOTP_SECRET, code, t - 30_000)).toBe(true)
    expect(verifyTotp(DEMO_TOTP_SECRET, code, t + 90_000)).toBe(false)
    expect(verifyTotp(DEMO_TOTP_SECRET, 'abcdef', t)).toBe(false)
  })

  it('otpauth:// con emisor Drinks on Chain', () => {
    expect(otpauthUrl(DEMO_TOTP_SECRET, 'a@b.test')).toBe(
      'otpauth://totp/Drinks%20on%20Chain%3Aa%40b.test?secret=DRINKSONCHAINDEMOTOTPKEY&issuer=Drinks%20on%20Chain&algorithm=SHA1&digits=6&period=30',
    )
  })

  it('isMfaChallenge distingue el reto de la sesión', () => {
    expect(isMfaChallenge({ mfa: { required: true, enrolled: true, mfaToken: 't' } })).toBe(true)
  })
})
