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
