import { z } from 'zod';
import { slugSchema } from './common.js';

export const SITE_MAX_BYTES = 50 * 1024 * 1024;
export const SITE_MAX_FILES = 2000;
export const siteAccessSchema = z.enum(['authenticated', 'public', 'password']);
export const sitePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !/[\x00-\x1f?#]/.test(p) &&
      p.split('/').every((s) => s !== '' && s !== '.' && s !== '..') &&
      !p.split('/').some((s) => s === '.git' || s === 'node_modules' || /^\.env(?:\.|$)/.test(s)) &&
      !p.startsWith('__eat/'),
    '需要安全的相对文件路径，不能上传 .git、node_modules、.env 或 __eat 文件',
  );
export const createSiteSchema = z
  .object({
    slug: slugSchema
      .max(40)
      .refine((s) => !s.includes('--') && !s.endsWith('-'), 'slug 不允许连续连字符或以连字符结尾'),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(''),
    access: siteAccessSchema.default('authenticated'),
    password: z.string().min(4).max(128).optional(),
    spa: z.boolean().default(false),
  })
  .refine((s) => s.access !== 'password' || !!s.password, { path: ['password'], message: '密码访问需要设置密码' });
export const updateSiteSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  access: siteAccessSchema.optional(),
  password: z.string().min(4).max(128).optional(),
  spa: z.boolean().optional(),
});
export const siteFileSchema = z.object({
  path: sitePathSchema,
  content: z.string().max(4 * Math.ceil(SITE_MAX_BYTES / 3)),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
});
export const publishSiteSchema = z.object({
  files: z.array(siteFileSchema).min(1).max(SITE_MAX_FILES),
  message: z.string().max(1000).default(''),
});
/** A complete logical release; hashes are scoped to a single Folio. */
export const siteManifestFileSchema = z.object({
  path: sitePathSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/, '需要小写 SHA-256'),
  size: z.number().int().min(0).max(SITE_MAX_BYTES),
  type: z.string().min(1).max(200).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[ \x21-\x7e]*)?$/, '响应类型无效'),
});
export const prepareSiteUploadSchema = z.object({
  requestId: z.string().uuid(),
  files: z.array(siteManifestFileSchema).min(1).max(SITE_MAX_FILES),
  message: z.string().max(1000).default(''),
}).superRefine((value, ctx) => {
  const paths = new Set<string>();
  const sizes = new Map<string, number>();
  let total = 0;
  for (const f of value.files) {
    if (paths.has(f.path)) ctx.addIssue({ code: 'custom', message: `重复文件路径：${f.path}` });
    paths.add(f.path);
    if (sizes.has(f.hash) && sizes.get(f.hash) !== f.size)
      ctx.addIssue({ code: 'custom', message: '相同哈希的大小必须一致' });
    sizes.set(f.hash, f.size);
    total += f.size;
  }
  if (total > SITE_MAX_BYTES) ctx.addIssue({ code: 'custom', message: '整版内容不得超过 50 MiB' });
  if (!paths.has('index.html')) ctx.addIssue({ code: 'custom', message: '根目录必须包含 index.html' });
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) ctx.addIssue({ code: 'custom', message: '文件与目录路径冲突' });
    }
  }
});
export type SiteManifestFile = z.infer<typeof siteManifestFileSchema>;
export type PrepareSiteUpload = z.infer<typeof prepareSiteUploadSchema>;
export type SiteManifest = Record<string, { hash: string; size: number; type: string }>;
export interface SiteUploadStatus {
  id: string;
  state: 'uploading' | 'verifying' | 'completed' | 'expired';
  expiresAt: string;
  files: SiteManifestFile[];
  missing: { hash: string; size: number }[];
  uploads: { hash: string; size: number; url: string; headers: Record<string, string>; expiresAt: string }[];
  result: SiteVersion | null;
}
const SITE_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8',
  xml: 'application/xml', pdf: 'application/pdf', wasm: 'application/wasm', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  map: 'application/json', webmanifest: 'application/manifest+json',
};
export function siteContentType(path: string) {
  return SITE_MIME[path.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
}

export const siteAnchorSchema = z
  .object({
    type: z.enum(['page', 'element', 'region']).default('page'),
    elementId: z.string().max(300).optional(),
    selector: z.string().max(2000).optional(),
    text: z.string().max(1000).optional(),
    prefix: z.string().max(200).optional(),
    suffix: z.string().max(200).optional(),
    rect: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().min(0).max(1),
        height: z.number().min(0).max(1),
      })
      .optional(),
  })
  .refine((a) => a.type === 'page' || !!(a.elementId || a.selector || a.text), '元素或区域评论需要定位信息')
  .refine((a) => a.type !== 'region' || !!a.rect, '区域评论需要相对坐标');
export const sitePageSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((p) => p.startsWith('/') && !p.startsWith('//') && !/[\x00-\x1f]/.test(p), '页面标识必须是站内路径');
export const siteCommentBodySchema = z.object({
  content: z.string().trim().min(1).max(10000),
  versionId: z.string().uuid(),
  mentions: z.array(z.string().uuid()).max(30).default([]),
});
export const createSiteThreadSchema = siteCommentBodySchema.extend({
  page: sitePageSchema,
  anchor: siteAnchorSchema.default({ type: 'page' }),
});
export const siteThreadQuerySchema = z.object({
  page: sitePageSchema.optional(),
  versionId: z.string().uuid().optional(),
  status: z.enum(['open', 'resolved']).optional(),
});
export type CreateSite = z.infer<typeof createSiteSchema>;
export type UpdateSite = z.infer<typeof updateSiteSchema>;
export type PublishSite = z.infer<typeof publishSiteSchema>;
export type SiteFile = z.infer<typeof siteFileSchema>;
export type SiteAnchor = z.infer<typeof siteAnchorSchema>;
export type CreateSiteThread = z.infer<typeof createSiteThreadSchema>;
export type SiteCommentBody = z.infer<typeof siteCommentBodySchema>;
export type SiteThreadQuery = z.infer<typeof siteThreadQuerySchema>;
export interface SiteInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerId: string;
  access: z.infer<typeof siteAccessSchema>;
  spa: boolean;
  currentVersionId: string | null;
  url: string;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SiteVersion {
  id: string;
  number: number;
  message: string;
  fileCount: number;
  totalBytes: number;
  publisherId: string;
  createdAt: string;
  url: string;
}
export interface SiteComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  versionId: string;
  versionNumber: number;
  mentions: string[];
  canDelete: boolean;
  deletedAt: string | null;
  createdAt: string;
}
export interface SiteThread {
  id: string;
  page: string;
  versionId: string;
  versionNumber: number;
  anchor: SiteAnchor;
  status: 'open' | 'resolved';
  authorId: string;
  canResolve: boolean;
  createdAt: string;
  url: string;
  comments: SiteComment[];
}
