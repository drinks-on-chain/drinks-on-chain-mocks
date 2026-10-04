// Entrada `@drinks-on-chain/mocks/fixtures`: los JSON ya tipados, los usuarios de demo y el TOTP de
// demo (sin msw). Los archivos crudos también se exportan en
// `@drinks-on-chain/mocks/fixtures/erp/<archivo>.json`, `…/fixtures/backoffice/<archivo>.json` y
// `…/fixtures/public/<archivo>.json`.

export {
  DEMO_NEW_PASSWORD,
  DEMO_PASSWORD,
  demoStaff,
  demoUsers,
  erpFixtures,
  type DemoUser,
  type ErpFixtures,
} from './erp/fixtures'
export { backofficeFixtures, type BackofficeFixtures } from './backoffice/fixtures'
export { publicFixtures, type BottleCodeSample, type PublicFixtures } from './public/fixtures'
export { PASSPORT_CASES, SINGANI_CASE, type PassportCase } from './erp/trace/demo'
export { mockBottleCode } from './erp/trace/bottle-code'
export type { BottleLot, StoredAttachment, VoidedBottleCode } from './erp/trace/state'
export type {
  MemberBlock,
  StaffMfa,
  StoredApplication,
  StoredInvitation,
  StoredOverride,
  StoredSetting,
  StoredSettingHistory,
  WineryProfile,
} from './backoffice/model'
export { DEMO_TOTP_SECRET, generateTotp, MOCK_TOTP_BYPASS_CODE, otpauthUrl, verifyTotp } from './shared/totp'
