import { z } from 'zod';

export const ossDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  cdn: z.boolean().default(false),
});
export const updateOssSettingsSchema = z
  .object({
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    region: z
      .string()
      .regex(/^(?:oss-)?[a-z]{2}-[a-z0-9-]+$/)
      .transform((v) => v.replace(/^oss-/, '')),
    accessKeyId: z.string().trim().max(500).default(''),
    accessKeySecret: z.string().trim().max(2000).default(''),
    customDomainsEnabled: z.boolean().default(false),
    domains: z.array(ossDomainSchema).max(100).default([]),
  })
  .refine(
    (v) => new Set(v.domains.map((d) => d.domain)).size === v.domains.length,
    '域名不能重复',
  );
export type UpdateOssSettings = z.infer<typeof updateOssSettingsSchema>;
export const requestOssSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  purpose: z.string().trim().min(1).max(2000),
  requestId: z.uuid(),
});
export const updateOssSpaceSchema = requestOssSpaceSchema
  .pick({ name: true, purpose: true })
  .partial();
export const ossPublicReadSchema = z.object({ enabled: z.boolean() });
export const ossRejectSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});
export type RequestOssSpace = z.infer<typeof requestOssSpaceSchema>;
export type UpdateOssSpace = z.infer<typeof updateOssSpaceSchema>;
export type OssSpaceStatus =
  | 'pending'
  | 'provisioning'
  | 'active'
  | 'failed'
  | 'rejected'
  | 'revoking'
  | 'revoked'
  | 'withdrawn';
export interface OssCheck {
  name: string;
  status: 'running' | 'passed' | 'failed';
  message?: string;
}
export interface OssSettingsInfo {
  configured: boolean;
  status: 'disabled' | 'checking' | 'enabled' | 'failed';
  bucket: string;
  region: string;
  accessKeyIdMasked: string;
  hasSecret: boolean;
  customDomainsEnabled: boolean;
  domains: z.infer<typeof ossDomainSchema>[];
  locationLocked: boolean;
  checks: OssCheck[];
  lastError: string | null;
}
export interface OssCapability {
  enabled: boolean;
  status: OssSettingsInfo['status'];
  bucket: string | null;
}
export interface OssAddress {
  domain: string;
  url: string;
  kind: 'official' | 'custom';
  cdn: boolean;
  source: 'oss' | 'admin';
}
export interface OssSpaceInfo {
  id: string;
  name: string;
  purpose: string;
  ownerId: string;
  ownerName: string;
  status: OssSpaceStatus;
  prefix: string;
  bucket: string;
  region: string;
  endpoint: string;
  addresses: OssAddress[];
  publicRead: boolean;
  requestedPublicRead: boolean;
  publicPrefixes: string[];
  credentialSyncPending: boolean;
  credentialSyncError: string | null;
  operationPending: boolean;
  lastError: string | null;
  rejectionReason: string | null;
  decidedByName: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OssCredentialInfo {
  accessKeyId: string;
  accessKeySecret: string;
  scope: 'all-approved-spaces';
  bucket: string;
  region: string;
  endpoint: string;
  prefixes: string[];
}
export interface OssAccountInfo {
  configured: boolean;
  accessKeyIdMasked: string;
  syncPending: boolean;
  lastError: string | null;
}
export interface OssOperationInfo {
  id: string;
  state: 'pending' | 'running' | 'failed' | 'complete';
  lastError: string | null;
}

export const OSS_PUBLIC_READ_NOTE =
  '此设置仅控制 EAT 的目录公开读授权；单独设置的对象 ACL、CDN 访问规则及缓存由使用者自行管理。';
export const OSS_CREDENTIAL_NOTE =
  '此 AK/SK 可操作你所有已批准的空间，包括以后新增的空间。重置会影响全部空间，请勿当作单个空间的凭证分享。密钥失效需等待阿里云传播。';
