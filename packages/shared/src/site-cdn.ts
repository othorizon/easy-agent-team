import { z } from 'zod';

const credential = z
  .string()
  .max(4096)
  .refine((s) => !/[\r\n\0]/.test(s), '凭证不能包含换行')
  .optional();
export const updateSiteCdnSchema = z.object({
  enabled: z.boolean().default(false),
  scope: z.enum(['domestic', 'global', 'overseas']).default('overseas'),
  credentialSource: z.enum(['independent', 'alidns']).default('independent'),
  accessKeyId: credential,
  accessKeySecret: credential,
  autoDns: z.boolean().default(false),
});
export type UpdateSiteCdn = z.infer<typeof updateSiteCdnSchema>;
export type SiteCdnStatus =
  | 'disabled'
  | 'checking'
  | 'awaiting_dns'
  | 'provisioning'
  | 'verifying'
  | 'enabled'
  | 'draining'
  | 'failed'
  | 'conflict';
export const CDN_WILDCARD_CAPABILITY_WARNING =
  '普通阿里云 CDN 官方不支持泛域名自定义回源请求头和出站响应头。当前方案依赖这两项，尚未满足普通 CDN 泛域名接入条件；请保持直连 DNS，不要手动切换解析绕过检查。';
export interface SiteCdnInfo extends Omit<UpdateSiteCdn, 'accessKeyId' | 'accessKeySecret'> {
  status: SiteCdnStatus;
  connected: boolean;
  capabilityWarning: string;
  accessKeyIdMasked: string;
  hasSecret: boolean;
  phase: string;
  lastError: string;
  cname: string;
  dnsInstructions: { name: string; type: string; value: string }[];
  certificateExpiresAt: string | null;
  certificateUploaded: boolean;
  originCertificateCheckedAt: string | null;
  certificateSyncedAt: string | null;
  certificateSyncError: string;
  retryAt: string | null;
  drainUntil: string | null;
  updatedAt: string | null;
}
