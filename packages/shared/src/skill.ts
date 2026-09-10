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

/** 由名称推导 slug：小写化、非字母数字折成连字符（纯中文名会得到空串，需另行指定 slug） */
export function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const skillVisibilitySchema = z.enum(['team', 'private']);
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>;

/**
 * eat skill push / 网页创建共用。
 *
 * name / description **缺省 = 保持平台上的原值**（决策 44）：CLI 只在 `--name` 或 SKILL.md
 * frontmatter 里真读到时才带上这两个字段，读不到就不传——推一个没写 frontmatter 的目录上来，
 * 不该把作者在控制台起的名字换成目录名、把触发描述抹成空。新建时没有原值可留，name 回落到 slug。
 */
export const pushSkillSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100).optional(),
  /** 触发描述：供人和 AI 判断何时使用该 skill */
  description: z.string().max(2000).optional(),
  /** SKILL.md 正文 */
  content: z.string().min(1).max(SKILL_FILE_MAX_BYTES, 'SKILL.md 过大'),
  files: z.array(skillFileSchema).max(50).default([]),
  changelog: z.string().max(500).default(''),
  visibility: skillVisibilitySchema.optional(),
});
export type PushSkillRequest = z.infer<typeof pushSkillSchema>;

/**
 * 控制台在线编辑 SKILL.md（决策 42）：每次保存产生一个新版本，附属文件原样沿用。
 * baseVersion 是编辑时看到的版本号——与服务端当前版本对不上说明别人已经推了新版本，
 * 服务端拒绝覆盖，让编辑者先刷新看过再改。
 */
export const updateSkillContentSchema = z.object({
  content: z.string().min(1).max(SKILL_FILE_MAX_BYTES, 'SKILL.md 过大'),
  changelog: z.string().max(500).default(''),
  baseVersion: z.number().int().positive(),
});
export type UpdateSkillContentRequest = z.infer<typeof updateSkillContentSchema>;

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  visibility: skillVisibilitySchema.optional(),
  /** 是否允许求助（P1 求助系统的入口开关，先落库） */
  allowHelp: z.boolean().optional(),
  /** 捆绑模式：仅管理员可改，且要求 visibility 为 team（决策 37） */
  bundled: z.boolean().optional(),
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
  /**
   * 捆绑模式：对所有非管理员成员恒为已订阅、不可退订，eat sync 总会带上（决策 37）。
   * 管理员例外——他们的 subscribed 仍按自己的订阅记录算。
   */
  bundled: z.boolean(),
  subscribed: z.boolean(),
  /** 当前用户不能改这条订阅（捆绑且自己不是管理员）；控制台据此禁用按钮 */
  subscriptionLocked: z.boolean(),
  /** 有效同步人数：手动/经验订阅 ∪（模板 − 排除）∪ 捆绑覆盖的成员 */
  subscriberCount: z.number(),
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
  /** own=自己创建；bundled=管理员设为捆绑（不可退订）；subscribed=订阅他人；template=来自所选角色模板；builtin=平台内置（人人同步） */
  relation: z.enum(['own', 'bundled', 'subscribed', 'template', 'builtin']),
  version: z.number(),
  content: z.string(),
  files: z.array(skillFileSchema),
});
export type SyncSkill = z.infer<typeof syncSkillSchema>;

/**
 * Skill 清单的分页上限：控制台默认取 20，CLI 默认 100、`--limit` 最多 1000（决策 37）。
 * 上限开到 1000 是为了让 CLI 一次请求就能拿全——AI 拿到半页会当成全部去下结论。
 */
export const SKILL_LIST_MAX_PAGE_SIZE = 1000;
export const SKILL_LIST_DEFAULT_PAGE_SIZE = 20;

/** 清单筛选：范围（订阅关系与归属）——与「类型」正交，各自单选 */
export const skillScopeSchema = z.enum(['all', 'subscribed', 'unsubscribed', 'mine']);
export type SkillScope = z.infer<typeof skillScopeSchema>;

/** 清单筛选：类型（可见性 / 捆绑 / 来源 三类状态合成一个单选，控制台就是一个下拉） */
export const skillKindSchema = z.enum(['all', 'team', 'private', 'granted', 'bundled', 'experience']);
export type SkillKind = z.infer<typeof skillKindSchema>;

/** GET /api/skills 的查询串（三端共用；数值从 query 来，用 coerce） */
export const skillListQuerySchema = z.object({
  /** 关键词：匹配 slug / 名称 / 触发描述，大小写不敏感 */
  q: z.string().trim().max(100).optional(),
  scope: skillScopeSchema.default('all'),
  kind: skillKindSchema.default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(SKILL_LIST_MAX_PAGE_SIZE).default(SKILL_LIST_DEFAULT_PAGE_SIZE),
});
export type SkillListQuery = z.infer<typeof skillListQuerySchema>;

export const skillListResultSchema = z.object({
  items: z.array(skillInfoSchema),
  /** 筛选后的总条数（不是本页条数），用于翻页与「共 N 条」 */
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  /**
   * 各范围下的条数：关键词与 kind 已应用、scope 不参与——回答的是「切到那个范围会有几条」，
   * 控制台的范围分段切换把它印在选项旁（决策 38）
   */
  counts: z.object({
    all: z.number(),
    subscribed: z.number(),
    unsubscribed: z.number(),
    mine: z.number(),
  }),
});
export type SkillListResult = z.infer<typeof skillListResultSchema>;

/** 订阅者明细（仅管理员可读） */
export const skillSubscriberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'member']),
  /** bundled=由捆绑模式强制，非订阅记录 */
  source: z.enum(['manual', 'template', 'experience', 'bundled']),
  /** 捆绑强制的订阅移不掉（要先取消捆绑），模板派生的移除记为排除 */
  removable: z.boolean(),
  /** 捆绑强制的没有订阅记录，为 null */
  subscribedAt: z.string().nullable(),
});
export type SkillSubscriber = z.infer<typeof skillSubscriberSchema>;

/** 管理员替他人订阅 */
export const addSkillSubscriberSchema = z.object({ userId: z.string().uuid() });
export type AddSkillSubscriberRequest = z.infer<typeof addSkillSubscriberSchema>;
