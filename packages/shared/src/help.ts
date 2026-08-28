import { z } from 'zod';
import { slugSchema } from './common.js';

// ---------- 可求助者登记 ----------

export const upsertHelperProfileSchema = z.object({
  /** 能力描述：会被 AI 读取用于选择向谁求助，写清楚擅长领域 */
  description: z.string().min(1).max(2000),
  /** 新求助/新回复推送到此地址（飞书群自定义机器人 webhook，§10 决策 16） */
  webhookUrl: z.url().max(500).optional().or(z.literal('')),
  /** 飞书机器人「加签」密钥（可选）。留空 = 保持已保存的值不变；清空 webhookUrl 时一并清除 */
  webhookSecret: z.string().max(200).optional().or(z.literal('')),
  /** 勿扰时不出现在 AI 的候选名单 */
  available: z.boolean().default(true),
});
export type UpsertHelperProfileRequest = z.infer<typeof upsertHelperProfileSchema>;

export const helperInfoSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  description: z.string(),
  available: z.boolean(),
  hasWebhook: z.boolean(),
});
export type HelperInfo = z.infer<typeof helperInfoSchema>;

/** AI 选择求助对象的完整候选：登记的 helper + 允许求助的 skill 作者 */
export const helpTargetsSchema = z.object({
  helpers: z.array(helperInfoSchema),
  skillAuthors: z.array(
    z.object({
      skillSlug: z.string(),
      skillName: z.string(),
      skillDescription: z.string(),
      authorId: z.string(),
      authorName: z.string(),
    }),
  ),
});
export type HelpTargets = z.infer<typeof helpTargetsSchema>;

// ---------- 求助请求 ----------

export const createHelpRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(10000),
    /** 已经尝试过什么（必填，减少伸手党问题） */
    tried: z.string().min(1).max(5000),
    /** 二选一：向登记的 helper 求助 */
    helperUserId: z.string().optional(),
    /** 二选一：向某个允许求助的 skill 的作者求助 */
    skillSlug: slugSchema.optional(),
  })
  .refine((v) => (v.helperUserId ? !v.skillSlug : !!v.skillSlug), {
    message: 'helperUserId 与 skillSlug 必须且只能提供一个',
  });
export type CreateHelpRequest = z.infer<typeof createHelpRequestSchema>;

export const helpStatusSchema = z.enum(['open', 'answered', 'resolved', 'closed']);
export type HelpStatus = z.infer<typeof helpStatusSchema>;

export const helpMessageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  senderName: z.string(),
  content: z.string(),
  createdAt: z.string(),
});
export type HelpMessage = z.infer<typeof helpMessageSchema>;

export const helpRequestInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tried: z.string(),
  status: helpStatusSchema,
  requesterId: z.string(),
  requesterName: z.string(),
  helperId: z.string(),
  helperName: z.string(),
  skillSlug: z.string().nullable(),
  /** 沉淀出的经验 skill（若已沉淀） */
  experienceSkillSlug: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HelpRequestInfo = z.infer<typeof helpRequestInfoSchema>;

export const helpRequestDetailSchema = helpRequestInfoSchema.extend({
  messages: z.array(helpMessageSchema),
});
export type HelpRequestDetail = z.infer<typeof helpRequestDetailSchema>;

export const replyHelpRequestSchema = z.object({
  content: z.string().min(1).max(10000),
});
export type ReplyHelpRequest = z.infer<typeof replyHelpRequestSchema>;

// ---------- 经验沉淀 ----------

export const distillRequestSchema = z.object({
  /** 公开：进入团队经验库；不公开：仅求助双方可见 */
  public: z.boolean(),
  grantedToRequester: z.boolean().default(true),
  grantedToHelper: z.boolean().default(true),
  /** 经验 skill 的 slug（缺省自动生成 exp-xxx） */
  slug: slugSchema.optional(),
  name: z.string().min(1).max(100).optional(),
  /** true 时用平台 AI 整理草稿；AI 未配置或失败时回退模板 */
  useAi: z.boolean().default(true),
  /** 手工提供 SKILL.md 正文（提供时跳过 AI） */
  content: z.string().max(65536).optional(),
});
export type DistillRequest = z.infer<typeof distillRequestSchema>;

export const experienceInfoSchema = z.object({
  id: z.string(),
  helpRequestId: z.string(),
  skillSlug: z.string(),
  public: z.boolean(),
  grantedToRequester: z.boolean(),
  grantedToHelper: z.boolean(),
  createdAt: z.string(),
});
export type ExperienceInfo = z.infer<typeof experienceInfoSchema>;

export const experienceSearchResultSchema = z.object({
  skillSlug: z.string(),
  name: z.string(),
  description: z.string(),
  public: z.boolean(),
  snippet: z.string(),
});
export type ExperienceSearchResult = z.infer<typeof experienceSearchResultSchema>;
