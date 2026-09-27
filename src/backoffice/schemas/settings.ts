import { z } from 'zod'
import { IsoDateTimeSchema } from '../../erp/schemas/common'
import { ReasonSchema } from './common'

// Configuración en dos niveles (contrato de la Ola 1 §6; catálogo en docs-back/05 §4).

export const SETTING_TYPES = ['NUMBER', 'BOOLEAN', 'STRING', 'LIST', 'OBJECT', 'NUMBER_OR_UNLIMITED', 'ENUM'] as const
export const SettingTypeSchema = z.enum(SETTING_TYPES)
export type SettingType = z.infer<typeof SettingTypeSchema>

/** G = solo estándar general · G+B = estándar y ajuste por bodega · B = solo por bodega. */
export const SETTING_LEVELS = ['GLOBAL', 'GLOBAL_AND_WINERY', 'WINERY'] as const
export const SettingLevelsSchema = z.enum(SETTING_LEVELS)
export type SettingLevels = z.infer<typeof SettingLevelsSchema>

/** Cuándo se aplica: se fija en el lote, en la colección o de inmediato. */
export const SETTING_APPLIES_AT = ['LOT', 'COLLECTION', 'IMMEDIATE'] as const
export const SettingAppliesAtSchema = z.enum(SETTING_APPLIES_AT)
export type SettingAppliesAt = z.infer<typeof SettingAppliesAtSchema>

export const SettingDefinitionSchema = z.object({
  key: z.string(),
  description: z.string(),
  type: SettingTypeSchema,
  enumValues: z.array(z.string()).optional(),
  unit: z.string().optional(),
  levels: SettingLevelsSchema,
  appliesAt: SettingAppliesAtSchema,
  default: z.unknown(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Piso legal (A-31): un valor más laxo exige `legalException` en un ajuste por bodega. */
  legalMinimum: z.union([z.number(), z.array(z.string())]).nullable().optional(),
  globalValue: z.unknown(),
  overridesCount: z.number().int().min(0),
  updatedAt: IsoDateTimeSchema,
  /** Nombre de quien lo cambió por última vez; `null` = instalación. */
  updatedBy: z.string().nullable(),
})
export type SettingDefinition = z.infer<typeof SettingDefinitionSchema>

export const SettingOverrideSchema = z.object({
  wineryId: z.string(),
  wineryName: z.string(),
  value: z.unknown(),
  legalException: z.boolean(),
  reason: z.string(),
  updatedAt: IsoDateTimeSchema,
  updatedBy: z.string(),
})
export type SettingOverride = z.infer<typeof SettingOverrideSchema>

export const SettingHistoryEntrySchema = z.object({
  at: IsoDateTimeSchema,
  by: z.string(),
  /** `GLOBAL` o el id de la bodega. */
  scope: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string(),
})
export type SettingHistoryEntry = z.infer<typeof SettingHistoryEntrySchema>

const required = z.unknown().refine((v) => v !== undefined, 'Falta el valor')

/** `PUT /v1/platform/settings/{key}` (solo ADMIN). */
export const UpdateSettingSchema = z.object({
  value: required,
  reason: ReasonSchema,
})
export type UpdateSettingDto = z.infer<typeof UpdateSettingSchema>

export const WineryIdsSchema = z.union([z.literal('ALL'), z.array(z.string().min(1)).min(1)])

/** `PUT /v1/platform/settings/{key}/overrides` (solo ADMIN). */
export const SetSettingOverridesSchema = z.object({
  wineryIds: WineryIdsSchema,
  value: required,
  reason: ReasonSchema,
  legalException: z.boolean().optional(),
})
export type SetSettingOverridesDto = z.infer<typeof SetSettingOverridesSchema>

/** `POST /v1/platform/settings/{key}/overrides/reset` ("volver al estándar"). */
export const ResetSettingOverridesSchema = z.object({
  wineryIds: WineryIdsSchema,
  reason: ReasonSchema,
})
export type ResetSettingOverridesDto = z.infer<typeof ResetSettingOverridesSchema>

export const SettingOverridesUpdatedSchema = z.object({ updated: z.number().int().min(0) })
export const SettingOverridesResetSchema = z.object({ reset: z.number().int().min(0) })

/** `GET /v1/organizations/current/settings`: valor efectivo (solo lectura). */
export const EffectiveSettingSchema = z.object({
  key: z.string(),
  description: z.string(),
  value: z.unknown(),
  source: z.enum(['GLOBAL', 'WINERY']),
  appliesAt: SettingAppliesAtSchema,
})
export type EffectiveSetting = z.infer<typeof EffectiveSettingSchema>
