/**
 * eat MCP server（stdio）：把平台能力暴露给本地 AI。
 * 使用底层 Server API + 手写 JSON Schema，避免与 SDK 内置 zod 版本耦合。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Api, ApiError } from './client.js';

const TOOLS = [
  {
    name: 'list_env_variables',
    description:
      '列出平台上的环境与变量清单（含备注与权限状态，不含值）。找配置先调这个：每个变量的备注说明了它的作用；hasAccess=false 表示值需要先申请权限。',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: '可选，只看指定环境（slug）' },
      },
    },
  },
  {
    name: 'get_env_values',
    description:
      '读取环境变量的值（敏感操作，平台会审计）。无权限的变量会在 denied 中返回 PERMISSION_REQUIRED，此时用 request_access 发起申请，不要重试。',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: '环境 slug' },
        keys: { type: 'array', items: { type: 'string' }, description: '要读取的变量 Key；缺省为该环境下全部有权限的变量' },
      },
      required: ['environment'],
    },
  },
  {
    name: 'request_access',
    description:
      '对无权限的环境变量发起权限申请。reason 请写清楚用途（会展示给审批人）。返回申请 ID，之后用 get_access_request_status 查询进度；批准前不要反复申请。',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: '环境 slug' },
        keys: { type: 'array', items: { type: 'string' }, minItems: 1, description: '申请的变量 Key 列表' },
        reason: { type: 'string', description: '申请理由（用途说明）' },
      },
      required: ['environment', 'keys', 'reason'],
    },
  },
  {
    name: 'get_access_request_status',
    description: '查询权限申请的审批状态。approved 后重新调用 get_env_values 即可拿到值。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '申请 ID；缺省列出我的全部申请' },
      },
    },
  },
  {
    name: 'search_experiences',
    description:
      '搜索团队经验库（由过往求助沉淀的知识）。遇到不懂的团队内部问题时【先搜经验库】，搜不到再用 create_help_request 向真人求助。返回匹配的经验 skill，详细内容可让用户 eat sync 后阅读，或直接依据 snippet 与 description 判断。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '搜索关键词（匹配经验的标题/描述/正文）' },
      },
      required: ['q'],
    },
  },
  {
    name: 'list_helpers',
    description:
      '列出可求助的对象：登记的可求助者（description 描述其擅长领域，据此选择最合适的人）+ 开启了求助的 skill 及其作者（问题与某个 skill 相关时优先走 skill 入口）。发起求助前先调用这个。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_help_request',
    description:
      '向团队里的真人发起求助。适用场景：用户听不懂你的技术问题、或你依赖别人项目的知识而经验库里没有。先 search_experiences，搜不到再求助。tried 必填（说明已经尝试过什么）。helperUserId 与 skillSlug 二选一。求助有频率限制，同一问题不要重复发起。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '问题标题（一句话）' },
        description: { type: 'string', description: '问题详细描述与上下文（不要携带密钥等敏感值）' },
        tried: { type: 'string', description: '已经尝试过什么（必填）' },
        helperUserId: { type: 'string', description: '向登记的 helper 求助（其 userId，来自 list_helpers）' },
        skillSlug: { type: 'string', description: '向某个 skill 的作者求助（skill slug，来自 list_helpers）' },
      },
      required: ['title', 'description', 'tried'],
    },
  },
  {
    name: 'get_help_request',
    description:
      '查看求助的当前状态与完整对话。status=answered 表示对方已回复，读取 messages 中的答案继续工作；open 表示还在等待，稍后再查或先做别的事。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '求助 ID；缺省列出我发起的全部求助' },
      },
    },
  },
  {
    name: 'reply_help_request',
    description: '在求助中追问或补充信息（也用于替用户回复）。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '求助 ID' },
        content: { type: 'string', description: '追问或补充的内容' },
      },
      required: ['requestId', 'content'],
    },
  },
] as const;

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const payload =
    err instanceof ApiError
      ? { error: err.code, message: err.message, details: err.details }
      : { error: 'ERROR', message: (err as Error).message };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}

export async function startMcpServer(): Promise<void> {
  const api = Api.fromSaved();
  const server = new Server(
    { name: 'easy-agent-team', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as never }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (req.params.name) {
        case 'list_env_variables': {
          const catalog = await api.request<Array<{ environment: { slug: string } }>>('GET', '/api/catalog');
          const env = args.environment as string | undefined;
          return jsonResult(env ? catalog.filter((c) => c.environment.slug === env) : catalog);
        }
        case 'get_env_values': {
          return jsonResult(
            await api.request('POST', `/api/envs/${args.environment as string}/values`, {
              keys: args.keys,
            }),
          );
        }
        case 'request_access': {
          return jsonResult(
            await api.request('POST', '/api/access-requests', {
              environmentSlug: args.environment,
              keys: args.keys,
              reason: args.reason,
            }),
          );
        }
        case 'get_access_request_status': {
          if (args.requestId) {
            return jsonResult(await api.request('GET', `/api/access-requests/${args.requestId as string}`));
          }
          return jsonResult(await api.request('GET', '/api/access-requests/mine'));
        }
        case 'search_experiences': {
          return jsonResult(await api.request('GET', `/api/experiences?q=${encodeURIComponent(args.q as string)}`));
        }
        case 'list_helpers': {
          return jsonResult(await api.request('GET', '/api/helpers'));
        }
        case 'create_help_request': {
          return jsonResult(
            await api.request('POST', '/api/help-requests', {
              title: args.title,
              description: args.description,
              tried: args.tried,
              helperUserId: args.helperUserId,
              skillSlug: args.skillSlug,
            }),
          );
        }
        case 'get_help_request': {
          if (args.requestId) {
            return jsonResult(await api.request('GET', `/api/help-requests/${args.requestId as string}`));
          }
          return jsonResult(await api.request('GET', '/api/help-requests/mine'));
        }
        case 'reply_help_request': {
          return jsonResult(
            await api.request('POST', `/api/help-requests/${args.requestId as string}/reply`, {
              content: args.content,
            }),
          );
        }
        default:
          return errorResult(new Error(`未知工具: ${req.params.name}`));
      }
    } catch (err) {
      return errorResult(err);
    }
  });

  await server.connect(new StdioServerTransport());
  // stdio 模式下保持进程存活，由客户端断开时退出
  console.error(`eat MCP server 已启动（${api.serverUrl}）`);
}
