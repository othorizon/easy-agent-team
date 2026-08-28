import { z } from 'zod';
import { slugSchema } from './common.js';

/** Skill 附属文件大小限制（解码后字节数） */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;
export const SKILL_TOTAL_MAX_BYTES = 1024 * 1024;

/**
 * 附属文件路径：相对路径，禁止 ../、绝对路径与反斜杠，
 * 保证 sync 落地时只能写入 skill 自身目录。
 */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, '路径仅允许字母数字._-与斜杠分隔')
  .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.'), {
    message: '路径不允许包含 . 或 .. 片段',
  })
  .refine((p) => p !== 'SKILL.md' && p !== '.eat-meta.json', {
    message: 'SKILL.md 与 .eat-meta.json 为保留文件名',
  });

export const skillFileSchema = z.object({
  path: skillFilePathSchema,
  /** utf8 文本直存；二进制 base64 */
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  content: z.string(),
  /** 可执行位（脚本），sync 落地时恢复 */
  executable: z.boolean().default(false),
});
export type SkillFile = z.infer<typeof skillFileSchema>;

export const skillVisibilitySchema = z.enum(['team', 'private']);
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>;

/** eat skill push / 网页创建共用 */
export const pushSkillSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  /** 触发描述：供人和 AI 判断何时使用该 skill */
  description: z.string().max(2000).default(''),
  /** SKILL.md 正文 */
  content: z.string().min(1).max(SKILL_FILE_MAX_BYTES, 'SKILL.md 过大'),
  files: z.array(skillFileSchema).max(50).default([]),
  changelog: z.string().max(500).default(''),
  visibility: skillVisibilitySchema.optional(),
});
export type PushSkillRequest = z.infer<typeof pushSkillSchema>;

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  visibility: skillVisibilitySchema.optional(),
  /** 是否允许求助（P1 求助系统的入口开关，先落库） */
  allowHelp: z.boolean().optional(),
});
export type UpdateSkillRequest = z.infer<typeof updateSkillSchema>;

export const skillInfoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  visibility: z.enum(['team', 'granted', 'private']),
  allowHelp: z.boolean(),
  source: z.enum(['manual', 'experience']),
  currentVersion: z.number(),
  subscribed: z.boolean(),
  updatedAt: z.string(),
});
export type SkillInfo = z.infer<typeof skillInfoSchema>;

export const skillDetailSchema = skillInfoSchema.extend({
  content: z.string(),
  files: z.array(skillFileSchema),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const skillVersionInfoSchema = z.object({
  version: z.number(),
  changelog: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type SkillVersionInfo = z.infer<typeof skillVersionInfoSchema>;

/** eat sync 拉取的落地内容 */
export const syncSkillSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(['manual', 'experience', 'builtin']),
  /** own=自己创建；subscribed=订阅他人；template=来自所选角色模板；builtin=平台内置（人人同步） */
  relation: z.enum(['own', 'subscribed', 'template', 'builtin']),
  version: z.number(),
  content: z.string(),
  files: z.array(skillFileSchema),
});
export type SyncSkill = z.infer<typeof syncSkillSchema>;
