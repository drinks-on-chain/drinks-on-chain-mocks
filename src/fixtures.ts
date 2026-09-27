// Entrada `@drinks-on-chain/mocks/fixtures`: los JSON ya tipados, los usuarios de demo y el TOTP de
// demo (sin msw). Los archivos crudos también se exportan en
// `@drinks-on-chain/mocks/fixtures/erp/<archivo>.json` y `…/fixtures/backoffice/<archivo>.json`.

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
