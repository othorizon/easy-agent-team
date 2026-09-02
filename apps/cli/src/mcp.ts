/**
 * eat MCP server（stdio）：把平台能力暴露给本地 AI。
 * 使用底层 Server API + 手写 JSON Schema，避免与 SDK 内置 zod 版本耦合。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import { CLI_VERSION, LOG_TAIL_DEFAULT, LOG_TAIL_MAX } from '@eat/shared';
import type { SecretFingerprint } from '@eat/shared';
import { Api, ApiError, setClientTag } from './client.js';
import { scanWorkspace } from './scan.js';
import { takeUpdateNoticeForMcp } from './update.js';

const TOOLS = [
  {
    name: 'list_env_variables',
    description:
      '列出平台上的环境与变量清单（含备注与权限状态，不含敏感值；有权限的非敏感变量直接附带明文值 value）。找配置先调这个：每个变量的备注说明了它的作用；hasAccess=false 表示值需要先申请权限。',
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
  {
    name: 'delete_help_request',
    description:
      '删除求助及其对话记录（不可恢复）。仅求助者本人（或管理员）可删；已沉淀为经验的求助不可删除。用于清理误发起或重复的求助——正常结束的求助用 resolve 标记解决即可，不要删。',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: '求助 ID' },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'list_projects',
    description: '列出部署项目与当前用户是否可部署（canDeploy）。部署前先确认项目 slug。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'trigger_deploy',
    description:
      '部署项目到 Dokploy。会先在 workdir 本地执行密钥扫描（通用规则 + 平台密钥指纹 + .env 误提交），发现问题则返回 findings 并拒绝部署——此时修复问题后重试，绝不要试图绕过检查。成功触发后用 get_deploy_status 跟踪结果。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 slug（list_projects 查看）' },
        workdir: { type: 'string', description: '项目代码目录的绝对路径' },
      },
      required: ['project', 'workdir'],
    },
  },
  {
    name: 'get_deploy_status',
    description:
      '查询部署状态。status=failed 时 error 字段已经带上 Dokploy 构建日志末尾的真实报错——据此改代码后重新 trigger_deploy；要看完整日志用 get_build_logs。传 project 看该项目最近一次部署，传 deploymentId 看指定那次，两个都不传则报错。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 slug（看最近一次部署）' },
        deploymentId: { type: 'string', description: '部署 ID（看指定那次）' },
        history: { type: 'boolean', description: '传 true 并带 project，列出该项目的部署历史' },
      },
    },
  },
  {
    name: 'get_build_logs',
    description:
      '读 Dokploy 上的构建日志——部署失败时排查的第一手材料（依赖装不上、编译报错、镜像拉不动都在这里）。默认最近一次构建；recent 里有最近的构建记录，可用 deploymentId 回看某次。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 slug（list_projects 查看）' },
        tail: { type: 'number', description: `日志行数，默认 ${LOG_TAIL_DEFAULT}，上限 ${LOG_TAIL_MAX}` },
        deploymentId: { type: 'string', description: 'Dokploy 构建记录 id（默认最近一次）' },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_run_logs',
    description:
      '读应用容器的运行日志——构建成功但服务不正常时看这个（进程启动失败、接口 500、连不上依赖）。默认第一个运行中的容器；containers 里是全部副本，可用 containerId 指定。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 slug（list_projects 查看）' },
        tail: { type: 'number', description: `日志行数，默认 ${LOG_TAIL_DEFAULT}，上限 ${LOG_TAIL_MAX}` },
        containerId: { type: 'string', description: '容器 id（默认第一个运行中的）' },
      },
      required: ['project'],
    },
  },
] as const;

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
        case 'list_projects': {
          return jsonResult(await api.request('GET', '/api/projects'));
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
          return jsonResult(await api.request('POST', `/api/projects/${args.project as string}/deploy`, { report }));
        }
        case 'get_deploy_status': {
          if (args.deploymentId) {
            return jsonResult(await api.request('GET', `/api/deployments/${args.deploymentId as string}`));
          }
          if (!args.project) return errorResult(new Error('需要 project 或 deploymentId 参数'));
          const slug = args.project as string;
          const path = args.history ? `/api/projects/${slug}/deployments` : `/api/projects/${slug}/deployments/latest`;
          return jsonResult(await api.request('GET', path));
        }
        case 'get_build_logs': {
          return jsonResult(
            await api.request('GET', `/api/projects/${args.project as string}/build-logs?${logQuery(args, 'deploymentId')}`),
          );
        }
        case 'get_run_logs': {
          return jsonResult(
            await api.request('GET', `/api/projects/${args.project as string}/run-logs?${logQuery(args, 'containerId')}`),
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
