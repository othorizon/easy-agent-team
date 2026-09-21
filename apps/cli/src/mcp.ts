/**
 * eat MCP server（stdio）：把平台能力暴露给本地 AI。
 * 使用底层 Server API + 手写 JSON Schema，避免与 SDK 内置 zod 版本耦合。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import { buildEatTools, CLI_VERSION, resolveDbInstance, STATIC_CONTAINER_PORT } from '@eat/shared';
import type { AppInfo, DbInstanceInfo, SecretFingerprint } from '@eat/shared';
import { Api, ApiError, setClientTag } from './client.js';
import { scanWorkspace } from './scan.js';
import { takeUpdateNoticeForMcp } from './update.js';

/** 工具定义在 packages/shared（决策 55：CLI stdio 与平台 HTTP 端点共用一份，避免描述漂移） */
const TOOLS = buildEatTools('local');

/** create_app / update_app 透传给平台的字段：只挑这些，别把 app 之类的路径参数也塞进请求体 */
const APP_FIELDS = [
  'slug',
  'name',
  'repoUrl',
  'branch',
  'buildType',
  'dockerfile',
  'dockerContextPath',
  'publishDirectory',
  'staticSpa',
  'port',
  'description',
] as const;

/**
 * create_app 的结果附一句人话（hint 字段）：分配了域名时说清访问地址与转发端口；
 * 没显式指定端口的 dockerfile 应用还要点明「3000 只是默认值、用 update_app 的 port 改」——
 * 光给 port: 3000 一个数字，AI 未必会把它和「我的容器其实监听 8080」联系起来。
 */
/** 给 AI 的应用信息：去掉部署后台的内部 id——AI 既用不上也操作不了部署后台，露出来只会让它误以为要去那边做什么 */
function forAgent(app: AppInfo): Omit<AppInfo, 'dokployApplicationId'> {
  const { dokployApplicationId: _internal, ...rest } = app;
  return rest;
}

function withCreateHint(raw: AppInfo, portGiven: boolean): Omit<AppInfo, 'dokployApplicationId'> & { hint?: string } {
  const app = forAgent(raw);
  if (!app.url) return app;
  const port = app.buildType === 'static' ? STATIC_CONTAINER_PORT : app.port;
  let hint = `已分配域名 ${app.url}，流量转发到容器端口 ${port}（首次部署成功后可访问）。`;
  if (app.buildType === 'dockerfile' && !portGiven) {
    hint += `端口 ${app.port} 是默认值：应用实际监听别的端口时用 update_app 的 port 参数改，立即生效、不用重新部署。`;
  }
  return { ...app, hint };
}

function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/** 日志类工具的查询串：tail 与「指定某次/某个」的可选参数 */
function logQuery(args: Record<string, unknown>, pick: 'deploymentId' | 'containerId'): URLSearchParams {
  const q = new URLSearchParams();
  if (typeof args.tail === 'number') q.set('tail', String(args.tail));
  if (typeof args[pick] === 'string') q.set(pick, args[pick]);
  return q;
}

function jsonResult(data: unknown) {
  const content = [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }];
  // 更新提示单独成块，不拼进 JSON 文本——调用方常把首块直接当结构化结果解析（决策 26）。
  // stdio server 的 stderr 一般只进客户端日志，Agent 看不见，所以只能挂在工具返回里。
  const notice = takeUpdateNoticeForMcp();
  if (notice) content.push({ type: 'text' as const, text: notice });
  return { content };
}

function errorResult(err: unknown) {
  const payload =
    err instanceof ApiError
      ? { error: err.code, message: err.message, details: err.details }
      : { error: 'ERROR', message: (err as Error).message };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}

export async function startMcpServer(): Promise<void> {
  setClientTag(`eat-mcp/${CLI_VERSION}`);
  const api = Api.fromSaved();
  const server = new Server(
    { name: 'easy-agent-team', version: CLI_VERSION },
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
        case 'delete_help_request': {
          return jsonResult(await api.request('DELETE', `/api/help-requests/${args.requestId as string}`));
        }
        case 'list_db_instances': {
          return jsonResult(await api.request('GET', '/api/db/instances'));
        }
        case 'request_db': {
          const instances = await api.request<DbInstanceInfo[]>('GET', '/api/db/instances');
          const inst = resolveDbInstance(instances, args.instance as string);
          if (!inst) {
            return jsonResult({
              error: 'DB_INSTANCE_NOT_FOUND',
              message: `找不到实例 ${String(args.instance)}，用 list_db_instances 查看可用实例`,
              instances: instances.map((i) => ({ id: i.id, name: i.name })),
            });
          }
          return jsonResult(
            await api.request('POST', '/api/db/assignments', {
              instanceId: inst.id,
              dbName: args.dbName,
              purpose: args.purpose,
            }),
          );
        }
        case 'list_db_assignments': {
          return jsonResult(await api.request('GET', '/api/db/assignments/mine'));
        }
        case 'list_apps': {
          return jsonResult((await api.request<AppInfo[]>('GET', '/api/apps')).map(forAgent));
        }
        case 'create_app': {
          // 工具描述承诺 name 默认同 slug，服务端契约里 name 是必填，得在这里补上
          const body = pick(args, APP_FIELDS);
          if (body.name === undefined) body.name = body.slug;
          const app = await api.request<AppInfo>('POST', '/api/apps', body);
          return jsonResult(withCreateHint(app, args.port !== undefined));
        }
        case 'update_app': {
          return jsonResult(forAgent(await api.request<AppInfo>('PATCH', `/api/apps/${args.app as string}`, pick(args, APP_FIELDS))));
        }
        case 'get_app_env': {
          return jsonResult(await api.request('GET', `/api/apps/${args.app as string}/env`));
        }
        case 'set_app_env': {
          return jsonResult(
            await api.request('PUT', `/api/apps/${args.app as string}/env`, { target: args.target, content: args.content }),
          );
        }
        case 'trigger_deploy': {
          const workdir = path.resolve(args.workdir as string);
          const fingerprints = await api.request<SecretFingerprint[]>('GET', '/api/secret-fingerprints');
          const { scannedFiles, findings } = scanWorkspace(workdir, fingerprints);
          const report = {
            passed: findings.length === 0,
            scannedFiles,
            findings,
            cliVersion: CLI_VERSION,
            ranAt: new Date().toISOString(),
          };
          if (!report.passed) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    { error: 'PRECHECK_FAILED', message: '本地密钥扫描未通过，已阻止部署。修复 findings 后重试', report },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
          return jsonResult(await api.request('POST', `/api/apps/${args.app as string}/deploy`, { report }));
        }
        case 'get_deploy_status': {
          if (!args.app) return errorResult(new Error('需要 app 参数（部署记录按应用查询）'));
          const slug = args.app as string;
          const base = `/api/apps/${slug}/deployments`;
          const path = args.deploymentId
            ? `${base}/${encodeURIComponent(args.deploymentId as string)}`
            : args.history
              ? `${base}${args.all ? '?all=1' : ''}`
              : `${base}/latest`;
          return jsonResult(await api.request('GET', path));
        }
        case 'get_build_logs': {
          return jsonResult(
            await api.request('GET', `/api/apps/${args.app as string}/build-logs?${logQuery(args, 'deploymentId')}`),
          );
        }
        case 'get_run_logs': {
          return jsonResult(
            await api.request('GET', `/api/apps/${args.app as string}/run-logs?${logQuery(args, 'containerId')}`),
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
