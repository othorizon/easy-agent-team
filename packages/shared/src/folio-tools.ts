import { z } from 'zod';
import type { EatToolDef } from './mcp-tools.js';
import { slugSchema } from './common.js';
import {
  createSiteSchema,
  createSiteThreadSchema,
  publishSiteSchema,
  prepareSiteUploadSchema,
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
  delete_folio: {
    description:
      '永久删除 Folio、全部历史版本、评论与访问会话，并清理发布文件。仅所有者或管理员；链接立即失效，无法恢复，调用前须获得用户明确的删除指令。cleanupFailed 为 true 时需管理员清理残留的私有文件。',
    schema: z.object({ folio: slugSchema }),
  },
  publish_folio: {
    description:
      '仅发布已构建的静态网站（HTML/CSS/JS/图片，可含 SPA），创建不可变版本，无需审批。不执行依赖安装、构建、后端代码或 SSR；需要服务端运行的项目请走应用部署。files 为相对路径及 utf8/base64 内容，根目录必须有 index.html，总量最多 50 MiB；较大目录建议用 eat folio push。保存发布产物，不等于保存源工程。',
    schema: z.object({ ...folioArg, ...publishSiteSchema.shape }),
  },
  prepare_folio_upload: {
    description: '提交完整目标清单（path、SHA-256、size、响应 MIME）和唯一 requestId，返回持久化上传会话及缺失内容的短期 OSS PUT 签名。相同内容只上传一次。将原始二进制传到签名 URL，仅带返回的 headers，绝不能带 EAT Authorization 或 Cookie。远程工具不能读取用户本地目录；本地目录/ZIP 请用 eat folio push。',
    schema: z.object({ ...folioArg, ...prepareSiteUploadSchema.shape }),
  },
  get_folio_upload: {
    description: '查询上传会话的完整清单、缺失内容、验证状态和已提交结果，可在中断或重启后恢复。',
    schema: z.object({ ...folioArg, uploadId: z.string().uuid() }),
  },
  renew_folio_upload: {
    description: '为未过期会话的缺失内容续签短期 OSS PUT URL。仅会话创建者且仍有管理权限时可操作。',
    schema: z.object({ ...folioArg, uploadId: z.string().uuid() }),
  },
  complete_folio_upload: {
    description: '完成上传：服务端快照、流式核验真实 SHA-256 和大小、不可变封存后原子发布。幂等重试返回同一版本，UPLOAD_BUSY 时查询进度再重试；未改变内容也会生成完整新版本。',
    schema: z.object({ ...folioArg, uploadId: z.string().uuid() }),
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
    case 'delete_folio':
      method = 'DELETE';
      break;
    case 'publish_folio':
      method = 'POST';
      path += '/releases';
      payload = publishSiteSchema.parse(body);
      break;
    case 'prepare_folio_upload':
      method = 'POST'; path += '/uploads'; payload = prepareSiteUploadSchema.parse(body); break;
    case 'get_folio_upload':
      path += `/uploads/${body.uploadId}`; break;
    case 'renew_folio_upload':
      method = 'POST'; path += `/uploads/${body.uploadId}/renew`; payload = {}; break;
    case 'complete_folio_upload':
      method = 'POST'; path += `/uploads/${body.uploadId}/complete`; payload = {}; break;
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
