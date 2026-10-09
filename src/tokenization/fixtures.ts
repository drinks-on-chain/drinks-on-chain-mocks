import collectionsJson from '../../fixtures/tokenization/collections.json'
import closuresJson from '../../fixtures/tokenization/lot-closures.json'
import lotStatusJson from '../../fixtures/tokenization/lot-status.json'
import nftMetadataJson from '../../fixtures/tokenization/nft-metadata.json'
import requestsJson from '../../fixtures/tokenization/requests.json'
import tokensJson from '../../fixtures/tokenization/tokens.json'
import type { Collection, LotClosure, LotTokenizationStatus, PlatformTokenizationRequest, PublicNftMetadata, Token } from './schemas'

// Fixtures del dominio `tokenization` tipados (`fixtures/tokenization/*.json`, generados por
// `pnpm seed`). Los valida `test/chain-fixtures.test.ts` con sus esquemas zod.

export interface TokenizationFixtures {
  /** Solicitudes con la vista de la plataforma (superconjunto de la que ve la bodega). */
  requests: PlatformTokenizationRequest[]
  collections: Collection[]
  /** Un NFT por botella de cada colección. */
  tokens: Token[]
  lotClosures: LotClosure[]
  /** `GET /v1/lots/{id}/tokenization` de cada lote, por id de lote. */
  lotStatus: Record<string, LotTokenizationStatus>
  /** Metadatos públicos del primer y del último NFT de cada colección, por `{slug}/{tokenId}`. */
  nftMetadata: Record<string, PublicNftMetadata>
}

export const tokenizationFixtures: TokenizationFixtures = {
  requests: requestsJson as unknown as PlatformTokenizationRequest[],
  collections: collectionsJson as unknown as Collection[],
  tokens: tokensJson as unknown as Token[],
  lotClosures: closuresJson as unknown as LotClosure[],
  lotStatus: lotStatusJson as unknown as Record<string, LotTokenizationStatus>,
  nftMetadata: nftMetadataJson as unknown as Record<string, PublicNftMetadata>,
}
