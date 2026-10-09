import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ChainAlertSchema,
  ChainEventSchema,
  ChainTransactionSchema,
  CollectionSchema,
  isValidStrKey,
  LotClosureSchema,
  LotTokenizationStatusSchema,
  PlatformChainAccountsSchema,
  PlatformTokenizationRequestSchema,
  PublicChainRegistrySchema,
  PublicDossierVerificationSchema,
  PublicNftMetadataSchema,
  ReconciliationRunSchema,
  TokenSchema,
  WineryChainAccountViewSchema,
  WineryChainIdentitySchema,
} from '../src'
import { CHAIN_ALERT_CODES, CHAIN_ALERT_SUBJECT_TYPES } from '../src'
import { chainFixtures as C, erpFixtures as F, mockAccountAddress, mockContractAddress, mockTxHash, PREVENTA_CASE, publicFixtures, SAME_SLUG_CASE, SINGANI_CASE, tokenizationFixtures as T } from '../src/fixtures'
import { base64ToHex, hexToBase64 } from '../src/shared/strkey'

// Fixtures de la Ola 3 (`fixtures/chain/` y `fixtures/tokenization/`): cada archivo valida con su
// esquema zod y los datos son coherentes entre sí y con los del ERP. Que estén al día con el
// generador lo comprueba `test/seed.test.ts`; que cumplan el OpenAPI, `test/contract.test.ts`.

const EXPLORER = 'https://stellar.expert/explorer/testnet'
const HASH = /^[0-9a-f]{64}$/

describe('direcciones y hashes de prueba', () => {
  it('las StrKey tienen forma válida (versión, longitud y CRC) y son deterministas', () => {
    const account = mockAccountAddress('winery:demo')
    const contract = mockContractAddress('winery:demo')
    expect(account).toMatch(/^G[A-Z2-7]{55}$/)
    expect(contract).toMatch(/^C[A-Z2-7]{55}$/)
    expect(isValidStrKey(account, 'G')).toBe(true)
    expect(isValidStrKey(contract, 'C')).toBe(true)
    expect(isValidStrKey(account, 'C')).toBe(false)
    expect(mockAccountAddress('winery:demo')).toBe(account)
    expect(mockAccountAddress('winery:otra')).not.toBe(account)
    // Un carácter cambiado rompe el CRC.
    expect(isValidStrKey(`${account.slice(0, 20)}${account[20] === 'A' ? 'B' : 'A'}${account.slice(21)}`)).toBe(false)
    // Una dirección real conocida (la cuenta raíz de testnet) también pasa la comprobación.
    expect(isValidStrKey('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H')).toBe(true)
    expect(mockTxHash('a')).toMatch(HASH)
  })

  it('el memo del anclaje se convierte entre hex y base64 sin pérdida', () => {
    const hex = mockTxHash('memo')
    expect(base64ToHex(hexToBase64(hex))).toBe(hex)
    expect(hexToBase64('00'.repeat(32))).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
  })
})

describe('fixtures de la Ola 3 ⇄ esquemas zod', () => {
  const cases: Array<[string, z.ZodType, unknown]> = [
    ['chain/identities.json', z.array(WineryChainIdentitySchema), C.identities],
    ['chain/transactions.json', z.array(ChainTransactionSchema), C.transactions],
    ['chain/platform-accounts.json', PlatformChainAccountsSchema, C.platformAccounts],
    ['chain/alerts.json', z.array(ChainAlertSchema), C.alerts],
    ['chain/events.json', z.array(ChainEventSchema), C.events],
    ['chain/reconciliation-runs.json', z.array(ReconciliationRunSchema), C.reconciliationRuns],
    ['chain/registry.json', PublicChainRegistrySchema, C.registry],
    ['chain/winery-accounts.json', z.record(z.string(), WineryChainAccountViewSchema), C.wineryAccounts],
    ['chain/verifications.json', z.record(z.string(), PublicDossierVerificationSchema), C.verifications],
    ['tokenization/requests.json', z.array(PlatformTokenizationRequestSchema), T.requests],
    ['tokenization/collections.json', z.array(CollectionSchema), T.collections],
    ['tokenization/tokens.json', z.array(TokenSchema), T.tokens],
    ['tokenization/lot-closures.json', z.array(LotClosureSchema), T.lotClosures],
    ['tokenization/lot-status.json', z.record(z.string(), LotTokenizationStatusSchema), T.lotStatus],
    ['tokenization/nft-metadata.json', z.record(z.string(), PublicNftMetadataSchema), T.nftMetadata],
  ]
  it.each(cases)('%s', (_name, schema, data) => {
    const result = schema.safeParse(data)
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues.slice(0, 5))).toBe(true)
  })
})

describe('coherencia de los fixtures de la Ola 3', () => {
  it('identidades: las bodegas activas (y la suspendida) tienen cuenta G… y contrato C… con el prefijo de lote como símbolo', () => {
    expect(C.identities.map((i) => i.contract?.symbol).sort()).toEqual(['ALT', 'CUR', 'CVJ'])
    for (const identity of C.identities) {
      expect(identity).toMatchObject({ status: 'ACTIVE', network: 'TESTNET', pendingTransactions: [], lastError: null })
      expect(isValidStrKey(identity.account!.address, 'G')).toBe(true)
      expect(isValidStrKey(identity.contract!.address, 'C')).toBe(true)
      expect(identity.account!.explorerUrl).toBe(`${EXPLORER}/account/${identity.account!.address}`)
      expect(identity.contract!.explorerUrl).toBe(`${EXPLORER}/contract/${identity.contract!.address}`)
      expect(identity.contract!.operatorAddress).toBe(C.platformAccounts.operations.address)
      expect(new TextEncoder().encode(identity.contract!.name).length).toBeLessThanOrEqual(40)
      expect(identity.contract!.baseUri).toMatch(/\/v1\/public\/nft\/[a-z0-9-]+\/$/)
      // Los campos legados de la bodega llevan la cuenta real (SE-02); el resto queda en `null`.
      const winery = F.wineries.find((w) => w.id === identity.wineryId)!
      expect(winery).toMatchObject({ stellarPublicKey: identity.account!.address, onchainProducerId: null, onchainRegisterTxHash: identity.account!.createdTx.txHash })
    }
    // Las bodegas sin identidad no llevan ninguna dirección simulada.
    for (const winery of F.wineries.filter((w) => !C.identities.some((i) => i.wineryId === w.id))) {
      expect(winery).toMatchObject({ stellarPublicKey: null, onchainProducerId: null, onchainRegisterTxHash: null })
    }
    expect(C.registry.wineries.map((w) => w.symbol).sort()).toEqual(['ALT', 'CUR', 'CVJ'])
    expect(C.registry.platform).toEqual({ operationsAccount: C.platformAccounts.operations.address, anchorAccount: C.platformAccounts.anchor.address })
  })

  it('transacciones: todas confirmadas, con hash de 64, enlace al explorador, ledger creciente y sin nada en vuelo', () => {
    expect(C.state.due).toEqual({})
    expect(C.transactions.length).toBeGreaterThan(8)
    for (const tx of C.transactions) {
      expect(tx).toMatchObject({ status: 'CONFIRMED', network: 'TESTNET', lastError: null, attempts: 1, abandoned: null })
      expect(tx.txHash).toMatch(HASH)
      expect(tx.explorerUrl).toBe(`${EXPLORER}/tx/${tx.txHash}`)
      expect(tx.history.map((h) => h.status)).toEqual(['PENDING', 'BUILDING', 'SUBMITTED', 'CONFIRMED'])
      expect(isValidStrKey(tx.sourceAccount!, 'G')).toBe(true)
      expect(BigInt(tx.feeChargedStroops!)).toBeGreaterThan(0n)
    }
    const byTime = [...C.transactions].sort((a, b) => a.confirmedAt!.localeCompare(b.confirmedAt!) || a.ledger! - b.ledger!)
    expect(byTime.map((t) => t.ledger)).toEqual([...byTime.map((t) => t.ledger)].sort((a, b) => a! - b!))
    expect(new Set(C.transactions.map((t) => t.intentKey)).size).toBe(C.transactions.length)
    // El anclaje lo paga y lo firma la cuenta de anclaje; el resto, operaciones.
    const anchor = C.transactions.find((t) => t.kind === 'ANCHOR_DOSSIER')!
    expect(anchor.sourceAccount).toBe(C.platformAccounts.anchor.address)
    expect(C.transactions.filter((t) => t.kind !== 'ANCHOR_DOSSIER').every((t) => t.sourceAccount === C.platformAccounts.operations.address)).toBe(true)
  })

  it('colecciones: emitido ≤ cuota, números de botella 1…cuota e ids de token continuos por contrato', () => {
    expect(T.collections.map((c) => [c.name, c.status, c.saleState, c.quota])).toEqual([
      ['Singani Gran Reserva 2026', 'PUBLISHED', 'ON_SALE', 60],
      ['Singani El Portillo 2025', 'READY', null, 240],
      [PREVENTA_CASE.name, 'PUBLISHED', 'PRESALE', 100],
      // rc.2: la misma preventa, con el mismo `slug`, en otra bodega (el `slug` es único por bodega).
      [SAME_SLUG_CASE.name, 'PUBLISHED', 'PRESALE', SAME_SLUG_CASE.quota],
    ])
    const sameSlug = T.collections.filter((c) => c.slug === SAME_SLUG_CASE.slug)
    expect(sameSlug.map((c) => c.winery.slug).sort()).toEqual(['altos-de-calamuchita', 'destileria-cinti-viejo'])
    expect(new Set(T.collections.map((c) => `${c.wineryId}/${c.slug}`)).size).toBe(T.collections.length)
    for (const collection of T.collections) {
      const tokens = T.tokens.filter((t) => t.collectionId === collection.id)
      expect(tokens).toHaveLength(collection.quota)
      expect(collection.counts).toMatchObject({ minted: collection.quota, available: collection.quota, sold: 0, burned: 0 })
      expect(tokens.map((t) => t.bottleNumber)).toEqual(Array.from({ length: collection.quota }, (_, i) => i + 1))
      expect(collection).toMatchObject({ mintStatus: 'CONFIRMED', pendingMintQuantity: 0 })
      expect(collection.coverImageUrl).toMatch(/^\/v1\/public\/collections\/images\//)
      expect(collection.contract.explorerUrl).toBe(`${EXPLORER}/contract/${collection.contract.address}`)
      for (const token of tokens) {
        expect(token).toMatchObject({ status: 'MINTED', contractAddress: collection.contract.address, owner: { kind: 'WINERY' } })
        expect(token.metadataUrl.endsWith(`/${token.tokenId}`)).toBe(true)
        expect(token.mintTx.explorerUrl).toMatch(/\/tx\/[0-9a-f]{64}$/)
      }
    }
    for (const wineryId of new Set(T.tokens.map((t) => t.wineryId))) {
      const ids = T.tokens.filter((t) => t.wineryId === wineryId).map((t) => t.tokenId).sort((a, b) => a - b)
      expect(ids).toEqual(ids.map((_, i) => i))
    }
    // El precio puede faltar (A-32): la preventa del recorrido H3 se aprobó sin él.
    expect(T.collections.find((c) => c.name === PREVENTA_CASE.name)!.price).toBeNull()
    expect(T.collections.find((c) => c.name === 'Singani Gran Reserva 2026')!.price).toMatchObject({ amountMinor: 28000, currency: 'BOB', source: 'MANUAL' })
  })

  it('«Singani Preventa 2026»: lote en origen con estimación 3.000, solicitud aprobada tras un cambio pedido y 100 NFT en preventa', () => {
    const lot = F.lots.find((l) => l.id === PREVENTA_CASE.lotId)!
    expect(lot).toMatchObject({ name: 'Singani Preventa 2026', wineryId: PREVENTA_CASE.wineryId, stage: 'ORIGIN', productType: 'SINGANI', estimatedBottles: 3000, tokenization: { state: 'PUBLISHED', quota: 100, minted: 100 } })
    const request = T.requests.find((r) => r.lotId === lot.id)!
    expect(request).toMatchObject({ kind: 'INITIAL', status: 'APPROVED', quantity: 100, resultingQuota: 100, requiresApproval: true, price: null, decision: { outcome: 'APPROVED', by: { system: false } } })
    expect(request.history.map((h) => h.status)).toEqual(['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'SUBMITTED', 'IN_REVIEW', 'APPROVED'])
    expect(request.changeRequests).toHaveLength(1)
    expect(request.changeRequests[0]!.resolvedAt).not.toBeNull()
    expect(request.priceSuggestion).toEqual({ available: false, reason: 'POLICY_UNDEFINED' })
    expect(T.lotStatus[lot.id]).toMatchObject({ tokenizable: true, limits: { basis: 'ESTIMATE', estimatedBottles: 3000, authorizedQuota: 100, pendingQuantity: 0, maxQuantity: 2900 }, chainIdentity: { status: 'ACTIVE' } })
    expect(F.lotEvents.filter((e) => e.lotId === lot.id).map((e) => e.type)).toEqual(['LOT_CREATED', 'TOKENIZATION_AUTHORIZED', 'NFT_MINTED', 'COLLECTION_PUBLISHED'])
    expect(T.nftMetadata['destileria-cinti-viejo/60']).toMatchObject({ name: 'Singani Preventa 2026 · Botella 1 de 100', properties: { bottleNumber: 1, collectionSize: 100, tokenId: 60, status: 'MINTED', passportUrl: null } })
  })

  it('bandeja: una solicitud en cada estado y una ampliación de cuota enviada', () => {
    expect(T.requests.map((r) => r.status).sort()).toEqual(['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'CHANGES_REQUESTED', 'IN_REVIEW', 'REJECTED', 'SUBMITTED', 'WITHDRAWN'])
    expect(T.requests.find((r) => r.status === 'SUBMITTED')).toMatchObject({ kind: 'QUOTA_INCREASE', quantity: 500, resultingQuota: 740, limitsAtSubmission: { basis: 'BOTTLES', bottles: 1040, authorizedQuota: 240 } })
    // Una sola solicitud abierta por lote.
    const open = T.requests.filter((r) => ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED'].includes(r.status))
    expect(new Set(open.map((r) => r.lotId)).size).toBe(open.length)
    for (const lot of F.lots) {
      const status = T.lotStatus[lot.id]!
      expect(status.lotId).toBe(lot.id)
      expect(status.tokenizable).toBe(status.blockers.length === 0)
    }
    expect(F.lots.filter((l) => l.tokenization.state !== 'NONE').map((l) => [l.name, l.tokenization.state]).sort()).toEqual([
      ['Singani El Molino 2026', 'REQUESTED'],
      ['Singani El Portillo 2025', 'READY'],
      ['Singani Gran Reserva 2026', 'PUBLISHED'],
      ['Singani Preventa 2026', 'PUBLISHED'],
      ['Singani Preventa 2026', 'PUBLISHED'],
      ['Tannat La Angostura 2024', 'CHANGES_REQUESTED'],
    ])
  })

  it('anclaje: el expediente cerrado en H2 queda anclado con su huella como memo, y el pasaporte y la verificación lo publican', () => {
    const lot = F.lots.find((l) => l.id === SINGANI_CASE.lotId)!
    const dossier = F.lotDossiers.find((d) => d.lotId === lot.id)!
    expect(lot.stage).toBe('ANCHORED')
    expect(dossier.anchor).toMatchObject({ status: 'ANCHORED', network: 'TESTNET', account: C.platformAccounts.anchor.address, memoHashHex: dossier.hash, transaction: { kind: 'ANCHOR_DOSSIER', status: 'CONFIRMED' } })
    expect(base64ToHex(dossier.anchor!.memoHashBase64)).toBe(dossier.hash)
    expect(dossier.anchor!.anchoredAt! > dossier.closedAt!).toBe(true)
    expect(F.bottling.find((b) => b.lotId === lot.id)).toMatchObject({ isAnchoredOnChain: true, blockchainAnchorTxHash: dossier.anchor!.txHash })
    const passport = publicFixtures.passports[lot.lotCode!]!
    expect(passport.stage).toBe('ANCHORED')
    expect(passport.dossier.anchor).toMatchObject({ status: 'ANCHORED', txHash: dossier.anchor!.txHash, explorerUrl: `${EXPLORER}/tx/${dossier.anchor!.txHash}` })
    const verification = C.verifications[lot.lotCode!]!
    expect(verification.checks.map((c) => [c.key, c.pass])).toEqual([['DOSSIER_CLOSED', true], ['ANCHOR_CONFIRMED', true], ['MEMO_MATCHES_HASH', true], ['ANCHOR_ACCOUNT_OFFICIAL', true]])
    expect(verification.officialAnchorAccount).toBe(C.registry.platform.anchorAccount)
    // Un lote embotellado sin expediente cerrado: nada que anclar todavía.
    const open = Object.values(C.verifications).find((v) => v.dossier.status === 'OPEN')!
    expect(open).toMatchObject({ anchor: null, verifiedOnChainAt: null })
    expect(open.checks.map((c) => c.pass)).toEqual([false, null, null, null])
    // La colección del lote anclado ya es canjeable y pasa de preventa a venta.
    expect(T.collections.find((c) => c.lotId === lot.id)).toMatchObject({ redeemable: true, saleState: 'ON_SALE', redeemableSince: dossier.anchor!.anchoredAt })
  })

  it('conciliación y alertas: una diferencia antigua resuelta, un aviso abierto y saldos sobre el mínimo', () => {
    expect(C.platformAccounts).toMatchObject({ network: 'TESTNET', operations: { status: 'OK' }, anchor: { status: 'OK' } })
    expect(C.platformAccounts.wasmHash).toMatch(HASH)
    // rc.2: una ejecución abre una diferencia (`TTL_EXPIRING`) y la siguiente la cierra sola.
    expect(C.reconciliationRuns.map((r) => [r.status, r.issuesOpened, r.issuesAutoResolved])).toEqual([['DIFFERENCES', 1, 0], ['DIFFERENCES', 1, 0], ['OK', 0, 1], ['OK', 0, 0], ['OK', 0, 0]])
    expect(C.alerts.map((a) => [a.code, a.level, a.resolvedAt === null, a.resolution?.auto ?? null])).toEqual([
      ['LOW_BALANCE', 'WARNING', false, false],
      ['TTL_EXPIRING', 'WARNING', false, true],
      ['TTL_EXPIRING', 'WARNING', true, null],
    ])
    const [opened, closed] = [C.reconciliationRuns[1]!, C.reconciliationRuns[2]!]
    expect(C.alerts[1]).toMatchObject({ runId: opened.id, resolvedAt: closed.finishedAt, resolution: { by: 'Sistema', auto: true }, subject: { type: 'CONTRACT' }, actual: { days: 12 } })
    // Entre las dos, la tarea de TTL alargó el contrato y el código (`EXTEND_TTL`, con su tope de comisión propio).
    const extensions = C.transactions.filter((t) => t.kind === 'EXTEND_TTL')
    expect(extensions.map((t) => [t.subject.type, t.maxFeeStroops])).toEqual([['CONTRACT', '10000000'], ['PLATFORM', '100000000']])
    expect(extensions.every((t) => t.confirmedAt! > opened.finishedAt! && t.confirmedAt! < closed.startedAt)).toBe(true)
    expect(C.platformAccounts.codeTtlDays).toBe(96)
    expect(C.alerts.every((a) => (CHAIN_ALERT_SUBJECT_TYPES as readonly string[]).includes(a.subject.type) && (CHAIN_ALERT_CODES as readonly string[]).includes(a.code))).toBe(true)
    expect(C.events.every((e) => e.originatedBySystem && e.matchedTransactionId !== null)).toBe(true)
    expect(C.events.filter((e) => e.type === 'lot_minted').map((e) => e.data.lot)).toEqual(['CVJ-L2026-005', 'ALT-L2025-004', 'ALT-L2026-007', 'CVJ-L2026-006'])
    // Eventos del indexador: cada contrato nace con `role_granted` y `base_uri_updated`; los temas llevan los argumentos indexados.
    expect(C.events.filter((e) => e.type === 'base_uri_updated')).toHaveLength(C.identities.length)
    expect(C.events.find((e) => e.type === 'lot_minted')!.topics).toEqual(['lot_minted', 'CVJ-L2026-005', C.identities.find((i) => i.contract?.symbol === 'CVJ')!.account!.address])
    expect(C.events.map((e) => e.rpcEventId)).toEqual([...C.events.map((e) => e.rpcEventId)].sort())
    expect(C.state.indexer).toEqual({ lastLedger: C.state.ledger, lagSeconds: 12 })
    expect(T.lotClosures.map((c) => [c.status, c.shortfall])).toEqual([['NO_SHORTFALL', 0], ['NO_SHORTFALL', 0]])
  })
})
