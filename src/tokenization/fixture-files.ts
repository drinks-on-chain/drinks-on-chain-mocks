import { DEFAULT_APP_URLS, renderEmail } from '../backoffice/mail'
import type { MockEmail } from '../backoffice/schemas/mail'
import type { ChainCtx } from '../chain/engine'
import { noticeMails, type NoticeData } from '../chain/notice-mails'
import type { ChainNotice } from '../chain/state'
import { uid } from '../shared/uuid'
import type { ChainAlert, ChainEvent, ChainTransaction, PlatformChainAccounts, PublicChainRegistry, PublicDossierVerification, ReconciliationRun, WineryChainIdentity } from '../chain/schemas'
import { platformAccounts } from '../chain/service'
import type { ChainState } from '../chain/state'
import { identityView } from '../chain/views'
import { lotBottling, type TraceState } from '../erp/trace/state'
import type { Collection, LotClosure, LotTokenizationStatus, PlatformTokenizationRequest, PublicNftMetadata, Token, WineryChainAccountView } from './schemas'
import { chainAccountView, closureView, collectionView, lotTokenizationStatus, platformRequestView, publicChainRegistry, publicDossierVerification, publicNftMetadata, tokenView } from './views'

// Archivos de `fixtures/chain/` y `fixtures/tokenization/` (los escribe `pnpm seed`): las vistas
// (DTO) del día de referencia para las apps, más `state.json`, el estado normalizado del que parten
// los handlers.

export interface ChainFixtureSet {
  /** Estado interno de los handlers (tablas normalizadas). Las apps usan los demás archivos. */
  'state.json': ChainState
  'identities.json': WineryChainIdentity[]
  'transactions.json': ChainTransaction[]
  'platform-accounts.json': PlatformChainAccounts
  'alerts.json': ChainAlert[]
  'events.json': ChainEvent[]
  'reconciliation-runs.json': ReconciliationRun[]
  'registry.json': PublicChainRegistry
  /** Cuenta de cada bodega con identidad, por id de bodega. */
  'winery-accounts.json': Record<string, WineryChainAccountView>
  /** Verificación pública del anclaje de cada lote embotellado, por código de lote. */
  'verifications.json': Record<string, PublicDossierVerification>
}

export interface TokenizationFixtureSet {
  /** Solicitudes con la vista de la plataforma (la del ERP es la misma sin `internalNotes`, `priceSuggestion` ni `review`). */
  'requests.json': PlatformTokenizationRequest[]
  'collections.json': Collection[]
  'tokens.json': Token[]
  'lot-closures.json': LotClosure[]
  /** Estado de tokenización de cada lote, por id de lote. */
  'lot-status.json': Record<string, LotTokenizationStatus>
  /** Metadatos públicos del primer y del último NFT de cada colección, por `{slug}/{tokenId}`. */
  'nft-metadata.json': Record<string, PublicNftMetadata>
}

/**
 * Buzón de los fixtures con los correos de la tokenización (contrato §11): los de la Ola 1 más los
 * que dejó la semilla de la Ola 3, por fecha. Mismos textos y destinatarios que en la sesión.
 */
export function withTokenizationMails(mailbox: readonly MockEmail[], notices: readonly ChainNotice[], data: NoticeData): MockEmail[] {
  const mails = notices.flatMap((notice) => noticeMails(notice, data).map((draft) => ({ draft, at: notice.at ?? '' })))
  const rendered = mails.map((m, i) => renderEmail(m.draft, uid(`email:tokenization:${i + 1}`), m.at, DEFAULT_APP_URLS))
  return [...mailbox, ...rendered].map((mail, i) => ({ mail, i })).sort((a, b) => a.mail.createdAt.localeCompare(b.mail.createdAt) || a.i - b.i).map(({ mail }) => mail)
}

export function buildChainFixtureFiles(state: TraceState, ctx: ChainCtx): { chain: ChainFixtureSet; tokenization: TokenizationFixtureSet } {
  const chain = state.chain
  const metadata: Record<string, PublicNftMetadata> = {}
  for (const c of chain.collections) {
    const tokens = chain.tokens.filter((t) => t.collectionId === c.id)
    for (const t of [tokens[0], tokens.at(-1)]) {
      const view = t && publicNftMetadata(state, ctx, t.wineryId, t.tokenId)
      if (t && view) metadata[`${ctx.env.winery(t.wineryId).slug}/${t.tokenId}`] = view
    }
  }
  return {
    chain: {
      'state.json': chain,
      'identities.json': chain.identities.map((i) => identityView(chain, i.wineryId)),
      'transactions.json': chain.transactions,
      'platform-accounts.json': platformAccounts(state, ctx.now),
      'alerts.json': chain.alerts,
      'events.json': chain.events,
      'reconciliation-runs.json': chain.runs,
      'registry.json': publicChainRegistry(state, ctx),
      'winery-accounts.json': Object.fromEntries(chain.identities.map((i) => [i.wineryId, chainAccountView(state, ctx, i.wineryId)])),
      'verifications.json': Object.fromEntries(
        state.lots.filter((l) => l.lotCode && lotBottling(state, l.id)).map((l) => [l.lotCode!, publicDossierVerification(state, ctx, l, `/v1/public/lots/${l.lotCode}/dossier`)]),
      ),
    },
    tokenization: {
      'requests.json': chain.requests.map((r) => platformRequestView(state, ctx, r)),
      'collections.json': chain.collections.map((c) => collectionView(state, ctx, c)),
      'tokens.json': chain.tokens.map((t) => tokenView(chain, t)),
      'lot-closures.json': chain.closures.map((c) => closureView(chain, c)),
      'lot-status.json': Object.fromEntries(state.lots.map((l) => [l.id, lotTokenizationStatus(state, ctx, l)])),
      'nft-metadata.json': metadata,
    },
  }
}
