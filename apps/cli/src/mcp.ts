/**
 * eat MCP server（stdio）：把平台能力暴露给本地 AI。
 * 使用底层 Server API + 手写 JSON Schema，避免与 SDK 内置 zod 版本耦合。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'node:path';
import { CLI_VERSION, LOG_TAIL_DEFAULT, LOG_TAIL_MAX, STATIC_CONTAINER_PORT } from '@eat/shared';
import type { AppInfo, SecretFingerprint } from '@eat/shared';
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
    name: 'list_apps',
    description:
      '列出应用及当前用户的关系：isMember=是否成员、deployApproved=管理员是否已授权部署、canDeploy=此刻能否部署；url 是平台自动分配的访问地址（未分配为 null）。部署前先确认应用 slug。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_app',
    description:
      '自助创建应用：填 Git 仓库地址与构建方式即可，私有仓库的拉取凭证由管理员预先配置。buildType 只有 dockerfile（按仓库里的 Dockerfile 构建）和 static（静态托管：不跑任何构建命令，把 publishDirectory 原样交给 nginx，仓库里得直接有产物）。管理员配置了域名后缀时会自动绑定域名 <slug>.<后缀>，返回的 domain/url 即访问地址（未配置则为 null）。创建后首次部署需管理员在控制台授权一次（返回的 deployApproved=false 即还没授权）。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '应用标识（小写字母/数字/连字符）' },
        name: { type: 'string', description: '显示名称（默认同 slug）' },
        repoUrl: { type: 'string', description: 'Git 仓库地址（https 或 ssh）' },
        branch: { type: 'string', description: '分支，默认 main' },
        buildType: { type: 'string', enum: ['dockerfile', 'static'], description: '构建方式' },
        dockerfile: { type: 'string', description: 'dockerfile：Dockerfile 路径（相对仓库根，默认 Dockerfile）' },
        dockerContextPath: { type: 'string', description: 'dockerfile：构建上下文（相对仓库根，默认仓库根）' },
        publishDirectory: { type: 'string', description: 'static：发布目录（相对仓库根，默认 .）' },
        staticSpa: { type: 'boolean', description: 'static：SPA 模式（所有路径回退到 index.html）' },
        port: { type: 'number', description: 'dockerfile：容器监听端口（默认 3000），自动分配的域名把流量转发到它；static 固定 80' },
        description: { type: 'string', description: '说明' },
      },
      required: ['slug', 'repoUrl', 'buildType'],
    },
  },
  {
    name: 'update_app',
    description:
      '修改应用配置（名称/说明/仓库/分支/构建方式及其选项）。改动下次部署生效；管理员挂载的既有应用只能改名称/说明。仅 Owner 或管理员可改。',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用 slug（list_apps 查看）' },
        name: { type: 'string' },
        description: { type: 'string' },
        repoUrl: { type: 'string' },
        branch: { type: 'string' },
        buildType: { type: 'string', enum: ['dockerfile', 'static'] },
        dockerfile: { type: 'string' },
        dockerContextPath: { type: 'string' },
        publishDirectory: { type: 'string' },
        staticSpa: { type: 'boolean' },
        port: { type: 'number', description: 'dockerfile：容器监听端口（有自动分配域名的应用会同步改域名转发端口）' },
      },
      required: ['app'],
    },
  },
  {
    name: 'get_app_env',
    description:
      '读取应用的 env：runtime=容器运行时环境变量，build=构建时变量（Dockerfile 里以 ARG 取用）。两块都是 dotenv 文本。值可能是密钥：只用于当前任务，不要写进代码、日志或对话。仅应用成员可读。',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', description: '应用 slug（list_apps 查看）' } },
      required: ['app'],
    },
  },
  {
    name: 'set_app_env',
    description:
      '用一段 dotenv 文本整体覆盖应用的 runtime 或 build env（另一块不动），下次部署生效。是覆盖不是合并：先 get_app_env 拿到现有内容再改，否则会把没带上的变量删掉。返回 key 级差异（added/changed/removed），不回值。仅应用成员可写。',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用 slug（list_apps 查看）' },
        target: { type: 'string', enum: ['runtime', 'build'], description: 'runtime=运行时 env，build=构建时变量' },
        content: { type: 'string', description: '完整的 dotenv 文本（KEY=value 一行一条）' },
      },
      required: ['app', 'target', 'content'],
    },
  },
  {
    name: 'trigger_deploy',
    description:
      '部署应用。会先在 workdir 本地执行密钥扫描（通用规则 + 平台密钥指纹 + .env 误提交），发现问题则返回 findings 并拒绝部署——此时修复问题后重试，绝不要试图绕过检查。应用未经管理员授权时返回 DEPLOY_NOT_APPROVED：告诉用户找管理员在控制台「应用」页授权一次，不要反复重试。成功触发后用 get_deploy_status 跟踪结果。',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用 slug（list_apps 查看）' },
        workdir: { type: 'string', description: '应用代码目录的绝对路径' },
      },
      required: ['app', 'workdir'],
    },
  },
  {
    name: 'get_deploy_status',
    description:
      '查询部署状态。status 取值 queued=排队中 / running=构建中 / done=成功 / error=失败 / cancelled=已取消 / archived=构建记录已被清理。status=error 时 error 字段已带上构建日志末尾的真实报错——据此改代码后重新 trigger_deploy；要看完整日志用 get_build_logs。platform 为 null 表示这次是绕过平台直接触发的、没经过密钥扫描门禁；platform.source=console 表示从控制台按钮触发、同样没做扫描。必须传 app；再传 deploymentId 看指定那次。',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用 slug（list_apps 查看）' },
        deploymentId: { type: 'string', description: '看指定那次：deploymentId 或平台元数据 id 都行，支持 8 位前缀' },
        history: { type: 'boolean', description: '传 true 列出该应用的部署历史' },
        all: { type: 'boolean', description: '与 history 同用：列出平台完整历史，含构建记录已被清理的那些' },
      },
      required: ['app'],
    },
  },
  {
    name: 'get_build_logs',
    description:
      '读构建日志——部署失败时排查的第一手材料（依赖装不上、编译报错、镜像拉不动都在这里）。默认最近一次构建；recent 里有最近的构建记录，可用 deploymentId 回看某次。',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用 slug（list_apps 查看）' },
        tail: { type: 'number', description: `日志行数，默认 ${LOG_TAIL_DEFAULT}，上限 ${LOG_TAIL_MAX}` },
        deploymentId: { type: 'string', description: '构建记录 id（默认最近一次）' },
      },
      required: ['app'],
    },
  },
  {
    name: 'get_run_logs',
    description:
      '读应用容器的运行日志——构建成功但服务不正常时看这个（进程启动失败、接口 500、连不上依赖）。默认第一个运行中的容器；containers 里是全部副本，可用 containerId 指定。',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用 slug（list_apps 查看）' },
        tail: { type: 'number', description: `日志行数，默认 ${LOG_TAIL_DEFAULT}，上限 ${LOG_TAIL_MAX}` },
        containerId: { type: 'string', description: '容器 id（默认第一个运行中的）' },
      },
      required: ['app'],
    },
  },
] as const;

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
