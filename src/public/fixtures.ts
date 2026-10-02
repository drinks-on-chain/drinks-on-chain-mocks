import bottleCodesJson from '../../fixtures/public/bottle-codes.json'
import collectionsJson from '../../fixtures/public/collections.json'
import passportsJson from '../../fixtures/public/passports.json'
import wineriesJson from '../../fixtures/public/wineries.json'
import type { PublicWineryProfile } from '../backoffice/schemas'
import type { PublicCollection, PublicLotPassport } from './schemas'
import type { BottleCodeSample } from './seed'

// Fixtures del dominio público tipados (`fixtures/public/*.json`, generados por `pnpm seed`).

export interface PublicFixtures {
  /** Pasaporte de cada lote embotellado, por código de lote, tal como se ve el día de referencia. */
  passports: Record<string, PublicLotPassport>
  /** Códigos de botella de muestra de cada lote (los primeros, el último y los anulados). */
  bottleCodes: BottleCodeSample[]
  /** Perfiles públicos de las bodegas activas (`GET /v1/public/wineries`). */
  wineries: PublicWineryProfile[]
  /** BORRADOR del catálogo (contrato de la Ola 2 §17.1; fuera del OpenAPI del backend). */
  collections: PublicCollection[]
}

export const publicFixtures: PublicFixtures = {
  passports: passportsJson as unknown as Record<string, PublicLotPassport>,
  bottleCodes: bottleCodesJson as unknown as BottleCodeSample[],
  wineries: wineriesJson as unknown as PublicWineryProfile[],
  collections: collectionsJson as unknown as PublicCollection[],
}

export type { BottleCodeSample } from './seed'
