import { z } from 'zod'
import { IsoDateTimeSchema } from './common'
import { WalletPurposeSchema, WalletTypeSchema } from './enums'

// GET /v1/users/me/wallet · WalletResponseDto

export const WalletResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  wineryId: z.string().nullish(),
  stellarPublicAddress: z.string(),
  walletType: WalletTypeSchema,
  walletPurpose: WalletPurposeSchema,
  isPrimary: z.boolean(),
  createdAt: IsoDateTimeSchema,
})
export type WalletResponse = z.infer<typeof WalletResponseSchema>
