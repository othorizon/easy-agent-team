import { z } from 'zod';

/** Quotas are integers in New API's units, not currency amounts. */
export const llmQuotaSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const llmSettingsSchema = z.object({
  apiUrl: z
    .url()
    .max(500)
    .refine((v) => {
      const u = new URL(v);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
    }, '请输入不含凭证、查询参数或片段的 HTTP(S) 站点地址'),
  accessToken: z.string().trim().max(4000).default(''),
  defaultQuota: llmQuotaSchema.default(0),
});
export type LlmSettingsRequest = z.infer<typeof llmSettingsSchema>;
export interface LlmCurrency {
  quotaPerUnit: number;
  currency: string;
  exchangeRate: number;
}
export interface LlmSettingsInfo {
  configured: boolean;
  apiUrl: string;
  accessTokenMasked: string;
  accountId: number | null;
  accountName: string;
  defaultQuota: number;
  currency: LlmCurrency | null;
  updatedAt: string | null;
}
export interface LlmAccountInfo {
  remainingQuota: number;
  usedQuota: number;
  currency: LlmCurrency;
  checkedAt: string;
}
export const llmOperationSchema = z.object({ requestId: z.uuid() });
export const llmStatusRequestSchema = llmOperationSchema.extend({ enabled: z.boolean() });
export const llmUserPolicySchema = llmOperationSchema
  .extend({
    initialQuota: llmQuotaSchema.nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => v.initialQuota !== undefined || v.disabled !== undefined, '请提供要修改的设置');
export const llmAdjustQuotaSchema = llmOperationSchema.extend({
  mode: z.enum(['add', 'subtract', 'set']),
  quota: llmQuotaSchema,
});
export type LlmUserPolicyRequest = z.infer<typeof llmUserPolicySchema>;
export type LlmAdjustQuotaRequest = z.infer<typeof llmAdjustQuotaSchema>;
export interface LlmKeyInfo {
  id: string;
  maskedKey: string;
  status: 'creating' | 'active' | 'disabled' | 'exhausted' | 'expired' | 'missing' | 'deleting';
  createdAt: string;
}
export interface LlmGatewayInfo {
  configured: boolean;
  userId: string;
  userName?: string;
  userStatus?: string;
  disabled: boolean;
  initialQuota: number | null;
  initialQuotaEffective: number;
  giftClaimed: boolean;
  key: LlmKeyInfo | null;
  totalQuota: number;
  usedQuota: number;
  remainingQuota: number;
  currency: LlmCurrency | null;
  apiBaseUrl: string;
  updatedAt: string | null;
  pending: boolean;
  error: string | null;
}
export interface LlmModelInfo {
  id: string;
}
export interface LlmUsageRecord {
  id: string;
  createdAt: number;
  model: string;
  quota: number;
  promptTokens: number;
  completionTokens: number;
  type: number;
}
export interface LlmUsagePage {
  items: LlmUsageRecord[];
  page: number;
  pageSize: number;
  total: number;
}

export function llmDisplayQuota(quota: number, currency: LlmCurrency | null): string {
  if (!currency || currency.currency === 'QUOTA') return `${quota.toLocaleString()} quota`;
  const value = (quota / currency.quotaPerUnit) * currency.exchangeRate;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency.currency}`;
}

export function llmAmountToQuota(amount: string, currency: LlmCurrency): number {
  if (!/^\d+(\.\d{1,8})?$/.test(amount.trim())) throw new Error('请输入非负金额（最多 8 位小数）');
  const quota = Math.round((Number(amount) / currency.exchangeRate) * currency.quotaPerUnit);
  if (!Number.isSafeInteger(quota) || quota < 0 || (Number(amount) > 0 && quota === 0))
    throw new Error('金额超出有效精度或范围');
  return quota;
}
