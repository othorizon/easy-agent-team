import { z } from 'zod';
import { slugSchema } from './common.js';
import { replyCallbackUrlSchema } from './reply-callback.js';

// ---------- 旧客户端个人资料兼容接口 ----------

export const upsertHelperProfileSchema = z.object({
  /** 个人简介的旧字段别名；会被 AI 读取用于选择求助对象。可为空 */
  description: z.string().max(2000).default(''),
  /** 已废弃：旧接口提交此字段会被拒绝，必须到用户中心验证 Webhook */
  webhookUrl: z.url().max(500).optional().or(z.literal('')),
  /** 已废弃：必须在用户中心配置并验证。 */
  webhookSecret: z.string().max(200).optional().or(z.literal('')),
  /** 已废弃：通知偏好迁至用户中心。 */
  notifyHelp: z.boolean().optional(),
  /** 已废弃：通知偏好迁至用户中心。 */
  notifyReply: z.boolean().optional(),
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

/** AI 选择求助对象的完整候选：允许求助的用户 + 允许求助的 skill 作者 */
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
    /** 二选一：向可求助用户求助 */
    helperUserId: z.string().optional(),
    /** 二选一：向某个允许求助的 skill 的作者求助 */
    skillSlug: slugSchema.optional(),
    /** 回复通知返回原任务的 URL 模板；{message} 会替换为 URL 编码的「发送给 Agent」文本。 */
    replyCallbackUrl: replyCallbackUrlSchema.optional(),
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

/** 控制台分页接口；既有 mine / inbox 数组接口继续供 CLI / MCP 使用。 */
export const helpListQuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type HelpListQuery = z.infer<typeof helpListQuerySchema>;

export const helpListResultSchema = z.object({
  items: z.array(helpRequestInfoSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  counts: z.object({
    all: z.number(),
    pending: z.number(),
    /** 找我的：等待我回复；我发起的：已有回复待我确认。计数不受分页影响。 */
    attention: z.number(),
  }),
});
export type HelpListResult = z.infer<typeof helpListResultSchema>;

export const helpRequestDetailSchema = helpRequestInfoSchema.extend({
  messages: z.array(helpMessageSchema),
});
export type HelpRequestDetail = z.infer<typeof helpRequestDetailSchema>;

export const replyHelpRequestSchema = z.object({
  content: z.string().min(1).max(10000),
  /**
   * 只对已解决的求助起作用（决策 66）：默认 true = 这条回复需要对方再处理，把求助重新打开；
   * false = 道谢 / 纯补充，留言并照常通知对方，但求助保持已解决。
   * 未解决的求助照常按谁回复改状态（被求助者 → answered，其他人 → open），这个参数不起作用。
   */
  reopen: z.boolean().default(true),
});
export type ReplyHelpRequest = z.infer<typeof replyHelpRequestSchema>;

// ---------- 经验沉淀 ----------

export const distillRequestSchema = z.object({
  /** 公开：进入团队经验库；不公开：仅求助双方可见 */
  public: z.boolean(),
  grantedToRequester: z.boolean().default(true),
  /** 默认不沉淀给自己：helper 已掌握该知识，通常无需再进本地 sync */
  grantedToHelper: z.boolean().default(false),
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
