import { z } from 'zod';

const secret = z
  .string()
  .max(4096)
  .refine((s) => !/[\r\n\0]/.test(s), '凭证不能包含换行')
  .optional();
export const siteDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(200)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, '请输入域名后缀，不包含协议、端口、通配符或路径');
export const updateSiteSettingsSchema = z
  .object({
    domain: siteDomainSchema,
    platformUrl: z
      .string()
      .trim()
      .max(2048)
      .default('')
      .refine(
        (s) =>
          !s ||
          (z.url({ protocol: /^https$/ }).safeParse(s).success &&
            /^https:\/\/(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?\/?$/.test(s)),
        '请填写 EAT 控制台的 HTTPS 根地址',
      ),
    ossRegion: z
      .string()
      .trim()
      .regex(/^oss-[a-z0-9-]+$/, '示例：oss-cn-hangzhou'),
    ossBucket: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, '请输入 OSS Bucket 名称'),
    ossAccessKeyId: secret,
    ossAccessKeySecret: secret,
    tlsMode: z.enum(['alidns', 'cloudflare', 'certificate', 'resolver']).default('alidns'),
    acmeEmail: z.union([z.email(), z.literal('')]).default(''),
    dnsAccessKeyId: secret,
    dnsAccessKeySecret: secret,
    certificateId: z.string().max(200).default(''),
    resolverName: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9_-]*$/)
      .default(''),
    platformApplicationId: z.string().min(1, '请选择部署后台中的 EAT 应用').max(200),
    upstreamUrl: z
      .string()
      .trim()
      .max(2048)
      .default('')
      .refine(
        (s) =>
          !s ||
          (z.url({ protocol: /^https?$/ }).safeParse(s).success &&
            /^https?:\/\/(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?\/?$/.test(s)),
        '请填写网关可访问的 EAT http(s) 根地址',
      ),
    upstreamPort: z.number().int().min(1).max(65535).default(3000),
    gatewayTarget: z
      .string()
      .trim()
      .min(1, '请输入部署入口 IP 或主机名')
      .max(253)
      .regex(/^[a-zA-Z0-9.:\[\]-]+$/),
    autoDns: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    if (['alidns', 'cloudflare'].includes(s.tlsMode) && !s.acmeEmail)
      ctx.addIssue({ code: 'custom', path: ['acmeEmail'], message: '自动证书需要联系邮箱' });
    if (s.tlsMode === 'certificate' && !s.certificateId)
      ctx.addIssue({ code: 'custom', path: ['certificateId'], message: '请选择已有证书' });
    if (s.tlsMode === 'resolver' && !s.resolverName)
      ctx.addIssue({ code: 'custom', path: ['resolverName'], message: '请选择已有 DNS 证书解析器' });
    if (s.autoDns && !['alidns', 'cloudflare'].includes(s.tlsMode))
      ctx.addIssue({ code: 'custom', path: ['autoDns'], message: '自动创建解析需要 DNS 服务商凭证' });
  });
export type UpdateSiteSettings = z.infer<typeof updateSiteSettingsSchema>;
export type SiteCapabilityStatus =
  | 'disabled'
  | 'checking'
  | 'provisioning'
  | 'verifying'
  | 'enabled'
  | 'disabling'
  | 'failed';
export interface SiteSetupCheck {
  id: string;
  name: string;
  phase: 'preflight' | 'provision' | 'postflight';
  status: 'running' | 'passed' | 'failed';
  message: string;
  checkedAt: string;
}
export interface SiteSettingsInfo
  extends Omit<UpdateSiteSettings, 'ossAccessKeyId' | 'ossAccessKeySecret' | 'dnsAccessKeyId' | 'dnsAccessKeySecret'> {
  configured: boolean;
  enabled: boolean;
  status: SiteCapabilityStatus;
  ossAccessKeyIdMasked: string;
  hasOssSecret: boolean;
  dnsAccessKeyIdMasked: string;
  hasDnsSecret: boolean;
  checks: SiteSetupCheck[];
  lastError: string;
  updatedAt: string | null;
}
export interface SiteTlsOptions {
  certificates: { id: string; name: string; domains: string; expiresAt: string; serverId: string | null }[];
  resolvers: string[];
}
export interface SiteCapabilityInfo {
  enabled: boolean;
  status: SiteCapabilityStatus;
  domain: string;
}
