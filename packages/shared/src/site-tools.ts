import { z } from 'zod';
import type { EatToolDef } from './mcp-tools.js';
import { slugSchema } from './common.js';
import {
  createSiteSchema,
  createSiteThreadSchema,
  publishSiteSchema,
  siteCommentBodySchema,
  siteThreadQuerySchema,
  updateSiteSchema,
} from './site.js';

const siteArg = { site: slugSchema, accessToken: z.string().max(4096).optional() };
const threadArg = { ...siteArg, threadId: z.string().uuid() };
export const SITE_TOOL_SPECS = {
  list_sites: {
    description: '列出页面。静态发布无需审批，也不创建 Dokploy 应用。',
    schema: z.object({}),
  },
  create_site: {
    description: '创建页面并自动分配域名，默认仅 EAT 登录用户访问。先创建再 publish_site 上传构建产物。',
    schema: z.object(createSiteSchema.shape),
  },
  update_site: {
    description:
      '修改页面名称、访问模式、访问密码或 SPA 设置。仅所有者或管理员；修改密码会使旧分享凭据失效。',
    schema: z.object({ ...siteArg, ...updateSiteSchema.shape }),
  },
  publish_site: {
    description:
      '上传静态文件并发布不可变版本，无需审批。files 为相对路径及 utf8/base64 内容，根目录必须有 index.html，总量最多 50 MiB；较大目录建议用 eat site push。保存发布产物，不等于保存源工程。',
    schema: z.object({ ...siteArg, ...publishSiteSchema.shape }),
  },
  list_site_versions: {
    description: '查看页面全部历史发布版本及各版本固定访问地址。',
    schema: z.object(siteArg),
  },
  activate_site_version: {
    description: '将页面入口切换到某个历史版本。版本文件与评论都保留。仅所有者或管理员。',
    schema: z.object({ ...siteArg, versionId: z.string().uuid() }),
  },
  create_site_share_link: {
    description: '生成密码页面的免输密码链接，有效期 90 天。链接只允许访问页面，发表评论仍需登录。',
    schema: z.object(siteArg),
  },
  unlock_site: {
    description: '验证密码页面的访问密码，返回仅限该页面的 accessToken，后续读取版本、评论或回复时携带。',
    schema: z.object({ site: slugSchema, password: z.string().max(128) }),
  },
  list_site_comments: {
    description:
      '读取页面讨论及回复，可按页面、发起版本和状态筛选。每条评论包含浏览版本、元素/区域锚点及原版本链接。',
    schema: z.object({ ...siteArg, ...siteThreadQuerySchema.shape }),
  },
  create_site_comment: {
    description:
      '在指定页面版本下创建整页、元素或区域讨论。versionId 必须是实际浏览版本；mentions 使用 list_site_mention_users 返回的用户 ID。',
    schema: z.object({ ...siteArg, ...createSiteThreadSchema.shape }),
  },
  reply_site_comment: {
    description:
      '回复页面讨论，记录回复时查看的 versionId；mentions 中的用户配置过飞书 webhook 时会收到通知。',
    schema: z.object({ ...threadArg, ...siteCommentBodySchema.shape }),
  },
  delete_site_comment: {
    description:
      '删除一条评论或回复，仅作者、页面所有者或管理员可操作。清除正文，保留其他人的回复；无剩余评论的讨论从列表隐藏。',
    schema: z.object({ ...siteArg, commentId: z.string().uuid() }),
  },
  set_site_thread_status: {
    description: '标记页面讨论已解决或重新打开，仅发起人、页面所有者或管理员可操作。',
    schema: z.object({ ...threadArg, status: z.enum(['open', 'resolved']) }),
  },
  list_site_mention_users: {
    description: '列出可在该页面评论中 @ 的活跃 EAT 用户及用户 ID。@ 不会自动授予页面访问权限。',
    schema: z.object(siteArg),
  },
};
export type SiteToolName = keyof typeof SITE_TOOL_SPECS;
export function isSiteTool(name: string): name is SiteToolName {
  return Object.hasOwn(SITE_TOOL_SPECS, name);
}
export function buildSiteTools(): EatToolDef[] {
  return Object.entries(SITE_TOOL_SPECS).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.schema, { io: 'input' }) as EatToolDef['inputSchema'],
  }));
}
/** stdio MCP 与 CLI 共用 HTTP 映射；HTTP MCP 直接调用服务层。 */
export function siteToolRequest(name: SiteToolName, input: unknown) {
  const args = SITE_TOOL_SPECS[name].schema.parse(input) as Record<string, unknown>;
  const { site, accessToken, threadId, ...body } = args;
  const base = `/api/sites/${encodeURIComponent(String(site))}`;
  const headers: Record<string, string> = accessToken ? { 'x-eat-site-access': String(accessToken) } : {};
  let method = 'GET',
    path = base,
    payload: unknown;
  switch (name) {
    case 'list_sites':
      path = '/api/sites';
      break;
    case 'create_site':
      method = 'POST';
      path = '/api/sites';
      payload = createSiteSchema.parse(body);
      break;
    case 'update_site':
      method = 'PATCH';
      payload = updateSiteSchema.parse(body);
      break;
    case 'publish_site':
      method = 'POST';
      path += '/releases';
      payload = publishSiteSchema.parse(body);
      break;
    case 'list_site_versions':
      path += '/versions';
      break;
    case 'activate_site_version':
      method = 'POST';
      path += '/activate';
      payload = body;
      break;
    case 'create_site_share_link':
      method = 'POST';
      path += '/share';
      payload = {};
      break;
    case 'unlock_site':
      method = 'POST';
      path += '/access';
      payload = body;
      break;
    case 'list_site_comments':
      path +=
        '/threads?' +
        Object.entries(body)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
          .join('&');
      break;
    case 'create_site_comment':
      method = 'POST';
      path += '/threads';
      payload = createSiteThreadSchema.parse(body);
      break;
    case 'reply_site_comment':
      method = 'POST';
      path += `/threads/${threadId}/replies`;
      payload = siteCommentBodySchema.parse(body);
      break;
    case 'delete_site_comment':
      method = 'DELETE';
      path += `/comments/${body.commentId}`;
      break;
    case 'set_site_thread_status':
      method = 'PATCH';
      path += `/threads/${threadId}`;
      payload = body;
      break;
    case 'list_site_mention_users':
      path += '/mention-users';
      break;
  }
  return { method, path, body: payload, headers };
}
