import { z } from 'zod';
import { slugSchema } from './common.js';

/**
 * MCP 配置分发：平台管理团队可用的 MCP Server 配置。
 * 敏感字段（token 等）写作环境变量引用 `${env:<环境slug>/<KEY>}`，
 * 取值走环境变量权限体系，sync 时按用户权限渲染。
 *
 * 权限模型（决策 50）分两层：
 * - **可见性**：`team` = 全员可见（看得到名称与说明，可自助申请订阅）；
 *   `private` = 不公开（只有 Owner / 管理员看得到，其他人只能靠管理员主动分配才拿得到）；
 * - **订阅审批**：成员自助订阅 = 提一条申请，配置 Owner 或管理员批准后才进入 `eat sync` 范围，
 *   与环境变量的读取授权申请同一套心智。Owner / 管理员订阅自己能审批的配置即时生效。
 */

export const ENV_REF_PATTERN = /\$\{env:([a-z0-9][a-z0-9-]*)\/([A-Za-z_][A-Za-z0-9_]*)\}/g;

const kvSchema = z.record(z.string().max(100), z.string().max(2000));

export const upsertMcpConfigSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(''),
    transport: z.enum(['stdio', 'http']),
    /** stdio */
    command: z.string().max(500).optional(),
    args: z.array(z.string().max(500)).max(50).default([]),
    /** http */
    url: z.string().max(1000).optional(),
    headers: kvSchema.default({}),
    /** 两种传输都可用；值可为字面量或 ${env:slug/KEY} 引用 */
    env: kvSchema.default({}),
    /** team = 全员可见可申请；private = 不公开，只能由 Owner / 管理员分配 */
    visibility: z.enum(['team', 'private']).default('team'),
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command : !!v.url), {
    message: 'stdio 需提供 command；http 需提供 url',
  });
export type UpsertMcpConfigRequest = z.infer<typeof upsertMcpConfigSchema>;

/** 当前用户与某个配置的订阅关系 */
export const mcpSubscriptionStatusSchema = z.enum(['none', 'pending', 'approved', 'rejected']);
export type McpSubscriptionStatus = z.infer<typeof mcpSubscriptionStatusSchema>;

export const mcpConfigInfoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  env: z.record(z.string(), z.string()),
  visibility: z.enum(['team', 'private']),
  ownerId: z.string(),
  ownerName: z.string(),
  /** 是否已生效（进入 eat sync 范围）：审批通过或来自角色模板 */
  subscribed: z.boolean(),
  /** 当前用户与该配置的订阅关系（none = 没订阅也没申请过） */
  subscriptionStatus: mcpSubscriptionStatusSchema,
  updatedAt: z.string(),
});
export type McpConfigInfo = z.infer<typeof mcpConfigInfoSchema>;

/** sync 渲染结果：一个可直接并入 mcpServers 的条目 + 未解析引用的说明 */
export const renderedMcpConfigSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** Claude Code 风格的 server 配置条目 */
  server: z.record(z.string(), z.unknown()),
  /** 无权限未解析的引用（保留占位符），附申请指引 */
  unresolved: z.array(
    z.object({ ref: z.string(), environment: z.string(), key: z.string(), howToRequest: z.string() }),
  ),
});
export type RenderedMcpConfig = z.infer<typeof renderedMcpConfigSchema>;

/** 自助订阅 = 提一条申请；理由可空（配置本身的说明已经写清它是干嘛的） */
// 不带 body 的订阅请求（curl / 测试）在 Fastify 侧是 undefined，preprocess 兜住
// （`.default({})` 不行：zod 的默认值不再过一遍内层 schema，reason 会缺）
export const subscribeMcpConfigSchema = z.preprocess(
  (v) => v ?? {},
  z.object({
    reason: z.string().max(500).default(''),
  }),
);
export type SubscribeMcpConfigRequest = z.infer<typeof subscribeMcpConfigSchema>;

/** 订阅结果：approved = 即时生效（Owner / 管理员 / 模板内已有），pending = 等审批 */
export const subscribeMcpConfigResultSchema = z.object({
  status: z.enum(['pending', 'approved']),
});
export type SubscribeMcpConfigResult = z.infer<typeof subscribeMcpConfigResultSchema>;

/** 一条订阅申请（审批人视角） */
export const mcpSubscriptionRequestSchema = z.object({
  /** 订阅记录 id，审批时回传 */
  id: z.string(),
  configId: z.string(),
  configSlug: z.string(),
  configName: z.string(),
  configVisibility: z.enum(['team', 'private']),
  userId: z.string(),
  userName: z.string(),
  userEmail: z.string(),
  reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  decidedBy: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type McpSubscriptionRequest = z.infer<typeof mcpSubscriptionRequestSchema>;

/** 审批清单筛选：默认只看待审批的（照求助清单的口径，决策 43） */
export const mcpSubscriptionRequestQuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
});
export type McpSubscriptionRequestQuery = z.infer<typeof mcpSubscriptionRequestQuerySchema>;

export const decideMcpSubscriptionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});
export type DecideMcpSubscriptionRequest = z.infer<typeof decideMcpSubscriptionSchema>;

/** 订阅者明细（Owner / 管理员可见）；source=admin 即管理员主动分配 */
export const mcpSubscriberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'member']),
  source: z.enum(['manual', 'template', 'admin']),
  /** 模板派生的订阅只能在模板里改，这里移不掉 */
  removable: z.boolean(),
  subscribedAt: z.string().nullable(),
});
export type McpSubscriber = z.infer<typeof mcpSubscriberSchema>;

export const addMcpSubscriberSchema = z.object({ userId: z.string().uuid() });
export type AddMcpSubscriberRequest = z.infer<typeof addMcpSubscriberSchema>;
