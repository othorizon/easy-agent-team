import { z } from 'zod';
import { slugSchema } from './common.js';

/**
 * MCP 配置分发：平台管理团队可用的 MCP Server 配置。
 * 敏感字段（token 等）写作环境变量引用 `${env:<环境slug>/<KEY>}`，
 * 取值走环境变量权限体系，sync 时按用户权限渲染。
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
    visibility: z.enum(['team', 'private']).default('team'),
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command : !!v.url), {
    message: 'stdio 需提供 command；http 需提供 url',
  });
export type UpsertMcpConfigRequest = z.infer<typeof upsertMcpConfigSchema>;

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
  subscribed: z.boolean(),
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
