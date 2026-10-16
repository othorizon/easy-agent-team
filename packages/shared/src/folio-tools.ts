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

const folioArg = { folio: slugSchema, accessToken: z.string().max(4096).optional() };
const threadArg = { ...folioArg, threadId: z.string().uuid() };
export const FOLIO_TOOL_SPECS = {
  list_folios: {
    description: '列出 Folio。静态发布无需审批，也不创建 Dokploy 应用。',
    schema: z.object({}),
  },
  create_folio: {
    description: '创建 Folio 并自动分配域名，默认仅 EAT 登录用户访问。先创建再 publish_folio 上传构建产物。',
    schema: z.object(createSiteSchema.shape),
  },
  update_folio: {
    description:
      '修改 Folio 名称、访问模式、访问密码或 SPA 设置。仅所有者或管理员；修改密码会使旧分享凭据失效。',
    schema: z.object({ ...folioArg, ...updateSiteSchema.shape }),
  },
  publish_folio: {
    description:
      '上传静态文件并发布不可变版本，无需审批。files 为相对路径及 utf8/base64 内容，根目录必须有 index.html，总量最多 50 MiB；较大目录建议用 eat folio push。保存发布产物，不等于保存源工程。',
    schema: z.object({ ...folioArg, ...publishSiteSchema.shape }),
  },
  list_folio_versions: {
    description: '查看 Folio 全部历史发布版本及各版本固定访问地址。',
    schema: z.object(folioArg),
  },
  activate_folio_version: {
    description: '将 Folio 入口切换到某个历史版本。版本文件与评论都保留。仅所有者或管理员。',
    schema: z.object({ ...folioArg, versionId: z.string().uuid() }),
  },
  create_folio_share_link: {
    description: '生成密码访问的 Folio 的免输密码链接，有效期 90 天。链接只允许访问 Folio，发表评论仍需登录。',
    schema: z.object(folioArg),
  },
  unlock_folio: {
    description: '验证密码访问的 Folio 的访问密码，返回仅限该 Folio 的 accessToken，后续读取版本、评论或回复时携带。',
    schema: z.object({ folio: slugSchema, password: z.string().max(128) }),
  },
  list_folio_comments: {
    description:
      '读取 Folio 讨论及回复，可按页面、发起版本和状态筛选。每条评论包含浏览版本、元素/区域锚点及原版本链接。',
    schema: z.object({ ...folioArg, ...siteThreadQuerySchema.shape }),
  },
  create_folio_comment: {
    description:
      '在指定 Folio 版本下创建整页、元素或区域讨论。versionId 必须是实际浏览版本；mentions 使用 list_folio_mention_users 返回的用户 ID。',
    schema: z.object({ ...folioArg, ...createSiteThreadSchema.shape }),
  },
  reply_folio_comment: {
    description:
      '回复 Folio 讨论，记录回复时查看的 versionId；mentions 中的用户配置过飞书 webhook 时会收到通知。',
    schema: z.object({ ...threadArg, ...siteCommentBodySchema.shape }),
  },
  delete_folio_comment: {
    description:
      '删除一条评论或回复，仅作者、Folio 所有者或管理员可操作。清除正文，保留其他人的回复；无剩余评论的讨论从列表隐藏。',
    schema: z.object({ ...folioArg, commentId: z.string().uuid() }),
  },
  set_folio_thread_status: {
    description: '标记 Folio 讨论已解决或重新打开，仅发起人、Folio 所有者或管理员可操作。',
    schema: z.object({ ...threadArg, status: z.enum(['open', 'resolved']) }),
  },
  list_folio_mention_users: {
    description: '列出可在该 Folio 评论中 @ 的活跃 EAT 用户及用户 ID。@ 不会自动授予 Folio 访问权限。',
    schema: z.object(folioArg),
  },
};
export type FolioToolName = keyof typeof FOLIO_TOOL_SPECS;
export function isFolioTool(name: string): name is FolioToolName {
  return Object.hasOwn(FOLIO_TOOL_SPECS, name);
}
export function buildFolioTools(): EatToolDef[] {
  return Object.entries(FOLIO_TOOL_SPECS).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.schema, { io: 'input' }) as EatToolDef['inputSchema'],
  }));
}
/** stdio MCP 与 CLI 共用 HTTP 映射；HTTP MCP 直接调用服务层。 */
export function folioToolRequest(name: FolioToolName, input: unknown) {
  const args = FOLIO_TOOL_SPECS[name].schema.parse(input) as Record<string, unknown>;
  const { folio, accessToken, threadId, ...body } = args;
  const base = `/api/sites/${encodeURIComponent(String(folio))}`;
  const headers: Record<string, string> = accessToken ? { 'x-eat-site-access': String(accessToken) } : {};
  let method = 'GET',
    path = base,
    payload: unknown;
  switch (name) {
    case 'list_folios':
      path = '/api/sites';
      break;
    case 'create_folio':
      method = 'POST';
      path = '/api/sites';
      payload = createSiteSchema.parse(body);
      break;
    case 'update_folio':
      method = 'PATCH';
      payload = updateSiteSchema.parse(body);
      break;
    case 'publish_folio':
      method = 'POST';
      path += '/releases';
      payload = publishSiteSchema.parse(body);
      break;
    case 'list_folio_versions':
      path += '/versions';
      break;
    case 'activate_folio_version':
      method = 'POST';
      path += '/activate';
      payload = body;
      break;
    case 'create_folio_share_link':
      method = 'POST';
      path += '/share';
      payload = {};
      break;
    case 'unlock_folio':
      method = 'POST';
      path += '/access';
      payload = body;
      break;
    case 'list_folio_comments':
      path +=
        '/threads?' +
        Object.entries(body)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
          .join('&');
      break;
    case 'create_folio_comment':
      method = 'POST';
      path += '/threads';
      payload = createSiteThreadSchema.parse(body);
      break;
    case 'reply_folio_comment':
      method = 'POST';
      path += `/threads/${threadId}/replies`;
      payload = siteCommentBodySchema.parse(body);
      break;
    case 'delete_folio_comment':
      method = 'DELETE';
      path += `/comments/${body.commentId}`;
      break;
    case 'set_folio_thread_status':
      method = 'PATCH';
      path += `/threads/${threadId}`;
      payload = body;
      break;
    case 'list_folio_mention_users':
      path += '/mention-users';
      break;
  }
  return { method, path, body: payload, headers };
}
