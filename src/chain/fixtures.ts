import alertsJson from '../../fixtures/chain/alerts.json'
import eventsJson from '../../fixtures/chain/events.json'
import identitiesJson from '../../fixtures/chain/identities.json'
import platformAccountsJson from '../../fixtures/chain/platform-accounts.json'
import runsJson from '../../fixtures/chain/reconciliation-runs.json'
import registryJson from '../../fixtures/chain/registry.json'
import stateJson from '../../fixtures/chain/state.json'
import transactionsJson from '../../fixtures/chain/transactions.json'
import verificationsJson from '../../fixtures/chain/verifications.json'
import wineryAccountsJson from '../../fixtures/chain/winery-accounts.json'
import type { WineryChainAccountView } from '../tokenization/schemas'
import type { ChainAlert, ChainEvent, ChainTransaction, PlatformChainAccounts, PublicChainRegistry, PublicDossierVerification, ReconciliationRun, WineryChainIdentity } from './schemas'
import type { ChainState } from './state'

// Fixtures del dominio `chain` tipados (`fixtures/chain/*.json`, generados por `pnpm seed`). Los
// valida `test/chain-fixtures.test.ts` con sus esquemas zod.

export interface ChainFixtures {
  /** Estado interno del que parten los handlers (tablas normalizadas). Las apps usan el resto. */
  state: ChainState
  /** Identidad en la red de cada bodega aprovisionada. */
  identities: WineryChainIdentity[]
  transactions: ChainTransaction[]
  platformAccounts: PlatformChainAccounts
  alerts: ChainAlert[]
  events: ChainEvent[]
  reconciliationRuns: ReconciliationRun[]
  registry: PublicChainRegistry
  /** `GET /v1/organizations/current/chain-account` de cada bodega con identidad, por id de bodega. */
  wineryAccounts: Record<string, WineryChainAccountView>
  /** `GET /v1/public/lots/{lotCode}/verification` de cada lote embotellado, por código de lote. */
  verifications: Record<string, PublicDossierVerification>
}

export const chainFixtures: ChainFixtures = {
  state: stateJson as unknown as ChainState,
  identities: identitiesJson as unknown as WineryChainIdentity[],
  transactions: transactionsJson as unknown as ChainTransaction[],
  platformAccounts: platformAccountsJson as unknown as PlatformChainAccounts,
  alerts: alertsJson as unknown as ChainAlert[],
  events: eventsJson as unknown as ChainEvent[],
  reconciliationRuns: runsJson as unknown as ReconciliationRun[],
  registry: registryJson as unknown as PublicChainRegistry,
  wineryAccounts: wineryAccountsJson as unknown as Record<string, WineryChainAccountView>,
  verifications: verificationsJson as unknown as Record<string, PublicDossierVerification>,
}
