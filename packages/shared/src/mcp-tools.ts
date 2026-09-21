import { LOG_TAIL_DEFAULT, LOG_TAIL_MAX, STATIC_CONTAINER_PORT } from './deploy.js';

/**
 * eat 自身能力的 MCP 工具清单（三端唯一事实源）。
 *
 * 两种接入形态共用这一份定义，避免两边描述漂移：
 * - `local`：CLI 的 `eat mcp`（stdio），跑在用户机器上，复用 `~/.eat/credentials.json`；
 * - `remote`：平台自己的 Streamable HTTP 端点 `POST <平台>/mcp`（决策 55），
 *   给云端 AI 服务用，鉴权走请求头里的 API Key。
 *
 * 两者差异只有两处，都是「有没有本地代码」决定的：
 * - `trigger_deploy`：本地版扫描 workdir 后才允许部署；远程版没有本地代码可扫，
 *   记录会标成「未做密钥扫描」（与控制台按钮同级）。
 * - `get_platform_guide`：只有远程版有——本地客户端的平台指南由 `eat sync` 落成 Skill，
 *   云端客户端没有这条路，只能靠工具把指南取回去。
 */
export type EatToolMode = 'local' | 'remote';

export interface EatToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP server 自报身份用（两种接入形态同名，客户端里看到的是同一个 server） */
export const EAT_MCP_SERVER_NAME = 'easy-agent-team';

/**
 * initialize 响应里的 instructions：多数客户端会把它拼进系统提示。
 * 只写「怎么开始」，完整规范留给 get_platform_guide——把一万多字的指南塞进每轮上下文不合算。
 */
export const EAT_MCP_INSTRUCTIONS = `easy-agent-team（eat）是这个团队的 AI 能力平台：环境变量与密钥、团队经验、人机求助、应用创建与部署都在这里统一授权与审计。

先调用 get_platform_guide 读一次平台使用指南（里面是完整能力清单与行为规范），再开始干活。几条最要紧的：
- 需要内部服务的配置 / 密钥 / 连接串：先 list_env_variables 认路，再 get_env_values 取值；返回 PERMISSION_REQUIRED 就用 request_access 申请，不要重试、不要猜值、不要向用户索要。
- 遇到搞不定的内部问题：先 search_experiences 搜团队经验，搜不到再 list_helpers + create_help_request 找真人。
- 取到的值可能是密钥：只用于当前任务，不要写进代码、日志或对话。`;

function envTools(): EatToolDef[] {
  return [
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
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: '要读取的变量 Key；缺省为该环境下全部有权限的变量',
          },
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
  ];
}

function helpTools(mode: EatToolMode): EatToolDef[] {
  return [
    {
      name: 'search_experiences',
      description:
        '搜索团队经验库（由过往求助沉淀的知识）。遇到不懂的团队内部问题时【先搜经验库】，搜不到再用 create_help_request 向真人求助。返回匹配的经验 skill，' +
        (mode === 'local'
          ? '详细内容可让用户 eat sync 后阅读，或直接依据 snippet 与 description 判断。'
          : '依据 snippet 与 description 判断是否对症；要看全文可让用户在平台控制台的「Skill」页打开对应 slug。'),
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
  ];
}

/**
 * 数据库账号。
 *
 * 此前这块只有 CLI 有命令、MCP 一个工具都没有，指南还写着「引导用户去控制台申请」——
 * 于是接 HTTP MCP 的云端 AI 想自己建个库放结果，唯一的出路是让人替它点一遍界面。
 * 申请本身是一次带用途说明、等管理员批准的常规动作，和 request_access 同一个形状，
 * 没有理由只对 AI 关着。
 */
function dbTools(): EatToolDef[] {
  return [
    {
      name: 'list_db_instances',
      description:
        '列出可申请的数据库实例（管理员登记的，不含实例的管理凭证）。要自己建库时先调这个挑一台，再用 request_db 申请。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'request_db',
      description:
        '申请在某实例上创建一个库和一个专属账号。**需要自己写数据（建表、落结果）时才申请库**；只读地取别人的业务库数据走 list_env_variables / get_env_values 那条路。提交后状态是 pending，要等管理员批准——告诉用户已提交、需要谁去批，不要反复申请。批准时平台会真实建库建号，状态转 active 并生成一组凭证环境变量，用 list_db_assignments 查进度。',
      inputSchema: {
        type: 'object',
        properties: {
          instance: { type: 'string', description: '实例 id 或名称（list_db_instances 查看）' },
          dbName: {
            type: 'string',
            description: '库名：小写字母开头，允许小写字母、数字、下划线，3-31 位',
          },
          purpose: { type: 'string', description: '用途说明（会展示给审批人）' },
        },
        required: ['instance', 'dbName', 'purpose'],
      },
    },
    {
      name: 'list_db_assignments',
      description:
        '列出我名下的数据库分配，兼作申请进度查询。status=pending 还在等批准；active 表示库和账号已建好，此时 environmentSlug 就是凭证所在的环境，用 get_env_values 取值连上去；failed 时 error 里是失败原因。',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function appTools(): EatToolDef[] {
  return [
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
          port: {
            type: 'number',
            description: `dockerfile：容器监听端口（默认 3000），自动分配的域名把流量转发到它；static 固定 ${STATIC_CONTAINER_PORT}`,
          },
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
  ];
}

function deployTools(mode: EatToolMode): EatToolDef[] {
  const triggerDeploy: EatToolDef =
    mode === 'local'
      ? {
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
        }
      : {
          name: 'trigger_deploy',
          description:
            '部署应用（构建源是应用绑定的 Git 仓库，与你本地无关）。**你是远程接入的，平台拿不到本地代码，这次部署不会做密钥扫描**，记录会标成「未做密钥扫描」，与控制台上的部署按钮同级：触发前请先确认仓库里没有提交密钥。有终端环境时改用 eat CLI 部署更安全（它会先扫描再触发）。应用未经管理员授权时返回 DEPLOY_NOT_APPROVED：告诉用户找管理员在控制台「应用」页授权一次，不要反复重试。成功触发后用 get_deploy_status 跟踪结果。',
          inputSchema: {
            type: 'object',
            properties: {
              app: { type: 'string', description: '应用 slug（list_apps 查看）' },
            },
            required: ['app'],
          },
        };

  return [
    triggerDeploy,
    {
      name: 'get_deploy_status',
      description:
        '查询部署状态。status 取值 queued=排队中 / running=构建中 / done=成功 / error=失败 / cancelled=已取消 / archived=构建记录已被清理。status=error 时 error 字段已带上构建日志末尾的真实报错——据此改代码后重新 trigger_deploy；要看完整日志用 get_build_logs。platform 为 null 表示这次是绕过平台直接触发的、没经过密钥扫描门禁；platform.source=console / remote 表示从控制台按钮或远程 MCP 触发、同样没做扫描。必须传 app；再传 deploymentId 看指定那次。',
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
  ];
}

/** 只有远程接入有：本地客户端的平台指南由 eat sync 落成 Skill，云端客户端没有那条路 */
const platformGuideTool: EatToolDef = {
  name: 'get_platform_guide',
  description:
    '读取 eat 平台使用指南（完整能力清单与行为规范：怎么取配置、无权限怎么申请、什么时候搜经验、什么时候求助、应用与部署怎么做）。**第一次使用本 MCP 的工具前先调用一次**，之后同一会话内不必重复调用。',
  inputSchema: { type: 'object', properties: {} },
};

export function buildEatTools(mode: EatToolMode): EatToolDef[] {
  return [
    ...(mode === 'remote' ? [platformGuideTool] : []),
    ...envTools(),
    ...helpTools(mode),
    ...dbTools(),
    ...appTools(),
    ...deployTools(mode),
  ];
}
