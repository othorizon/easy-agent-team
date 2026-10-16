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
  content: z.string().max(Math.ceil((SITE_MAX_BYTES * 4) / 3)),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
});
export const publishSiteSchema = z.object({
  files: z.array(siteFileSchema).min(1).max(SITE_MAX_FILES),
  message: z.string().max(1000).default(''),
});
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
