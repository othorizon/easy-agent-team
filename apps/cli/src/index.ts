import { Command } from 'commander';
import { CLI_VERSION, LOG_TAIL_DEFAULT } from '@eat/shared';
import { ApiError, formatErrorDetails } from './client.js';
import { login, logout, whoami } from './commands/auth.js';
import { envList, envPull, envRequest, envRequests } from './commands/env.js';
import { askCreate, askDelete, askList, askReply, askResolve, askShow, askTargets } from './commands/ask.js';
import { dbInstances, dbList, dbRequest } from './commands/db.js';
import {
  appCreate,
  appDelete,
  appDeployments,
  appEnvPull,
  appEnvPush,
  appList,
  appShow,
  appStatus,
  appUpdate,
  buildLogs,
  deployRun,
  runLogs,
  scanOnly,
} from './commands/app.js';
import { skillList, skillPush, skillSubscribe, skillUnsubscribe } from './commands/skill.js';
import { selfUpdate } from './commands/self-update.js';
import { sync } from './commands/sync.js';
import { startMcpServer } from './mcp.js';
import { flushUpdateNotice } from './update.js';

const program = new Command();

program
  .name('eat')
  .description('easy-agent-team CLI：团队 AI 能力的拉取、同步与求助入口')
  .version(CLI_VERSION);

program
  .command('login')
  .description('通过设备码授权登录平台')
  .option('--server <url>', '平台地址（默认 http://localhost:3000，或 EAT_SERVER 环境变量）')
  .action(login);

program.command('logout').description('退出登录（删除本地凭证）').action(logout);
program.command('whoami').description('查看当前登录身份').action(whoami);

const env = program.command('env').description('环境变量：查清单、拉取值、申请权限');
env.command('list [environment]').description('列出可见的环境与变量（key + 备注 + 权限状态）').action(envList);
env
  .command('pull <environment>')
  .description('拉取有权限的变量值，默认写入 ./.env')
  .option('--keys <keys>', '仅拉取指定 Key（逗号分隔）')
  .option('--out <file>', '输出文件（默认 .env）')
  .option('--print', '打印到标准输出而不写文件')
  .action(envPull);
env
  .command('request <environment> <keys...>')
  .description('对无权限的变量发起权限申请')
  .requiredOption('--reason <reason>', '申请理由（会展示给审批人）')
  .action(envRequest);
env.command('requests').description('查看我发起的权限申请与状态').action(envRequests);

const skill = program.command('skill').description('Skill：上传纳管、浏览、订阅');
skill
  .command('push <dir>')
  .description('把本地 skill 目录上传到平台（首次创建，再次推送出新版本）')
  .option('--slug <slug>', '平台标识（默认从 SKILL.md frontmatter 或目录名推导）')
  .option('--name <name>', '显示名称')
  .option('--description <description>', '触发描述（供人和 AI 判断何时使用）')
  .option('--changelog <changelog>', '本次版本说明')
  .option('--private', '设为私有（默认团队可见）')
  .action(skillPush);
skill.command('list').description('列出平台上可见的 skill 与订阅状态').action(skillList);
skill.command('subscribe <slug>').description('订阅 skill（eat sync 时落地本地）').action(skillSubscribe);
skill.command('unsubscribe <slug>').description('退订 skill').action(skillUnsubscribe);

const ask = program.command('ask').description('向团队真人求助、读取回复');
ask.command('targets').description('查看可求助的人与 skill').action(askTargets);
ask
  .command('create')
  .description('发起求助（--to 与 --skill 二选一）')
  .requiredOption('--title <title>', '问题标题')
  .requiredOption('--description <description>', '问题详细描述')
  .requiredOption('--tried <tried>', '已经尝试过什么')
  .option('--to <userId>', '向登记的 helper 求助（用户 ID，eat ask targets 查看）')
  .option('--skill <slug>', '向某个 skill 的作者求助')
  .action(askCreate);
ask.command('list').description('我发起的与找我的求助').action(askList);
ask.command('show <id>').description('查看求助详情与对话（支持 ID 前缀）').action(askShow);
ask
  .command('reply <id>')
  .description('回复 / 追问（支持 ID 前缀）')
  .requiredOption('--message <message>', '内容')
  .action(askReply);
ask.command('resolve <id>').description('标记已解决（支持 ID 前缀）').action(askResolve);
ask.command('delete <id>').description('删除求助（支持 ID 前缀；仅求助者/管理员，已沉淀为经验的不可删）').action(askDelete);

program
  .command('sync')
  .description('同步 Skill 到本地（默认全局：落地 ~/.agents/skills 并同步到 ~/.claude/skills；类 Unix 用软链，Windows 用复制）')
  .option('-g, --global', '安装到全局目录 ~/.agents/skills + 同步 ~/.claude/skills（默认）')
  .option('-p, --project', '安装到当前项目 ./.agents/skills + 同步 ./.claude/skills')
  .option('--dir <dir>', '自定义落地目录（指定后不同步到 .claude/skills）')
  .option('--force', '覆盖非 eat 管理的同名目录 / 强制重写')
  .action(sync);

const db = program.command('db').description('数据库账号：查看实例、申请库、查看我的分配');
db.command('instances').description('查看可用的数据库实例').action(dbInstances);
db
  .command('request <dbName>')
  .description('申请在某实例上创建库与专属账号')
  .requiredOption('--instance <instance>', '实例 ID 或名称（eat db instances 查看）')
  .requiredOption('--purpose <purpose>', '用途说明（给管理员看）')
  .action(dbRequest);
db.command('list').description('我的数据库分配与凭证环境').action(dbList);

program
  .command('scan [dir]')
  .description('本地密钥扫描（通用规则 + 平台密钥指纹 + .env 误提交），不部署')
  .action(scanOnly);
// deploy 留在顶层：最高频，且做成 `app deploy` 会与 `app <slug>` 形式的参数打架
program
  .command('deploy [app]')
  .description('部署应用：本地前置检查通过后触发 Dokploy 部署（应用需先经管理员授权一次）')
  .option('--dir <dir>', '代码目录（默认当前目录）')
  .option('--check <cmd>', '可选的本地预跑命令（如 "pnpm build"），非零退出则阻止部署')
  .action(deployRun);

const app = program.command('app').description('应用（对应 Dokploy 的 application）：创建、配置、env、部署状态、日志');
app.command('list').description('查看应用清单、自己的成员身份与授权状态').action(appList);
app.command('show <app>').description('查看应用配置（Git、构建方式、成员、部署授权）').action(appShow);
app
  .command('create <slug>')
  .description('自助创建应用：平台在 Dokploy 上建应用并绑好 Git 源 / SSH key / 构建方式（管理员配了域名后缀时自动分配 <slug>.<后缀>）')
  .option('--name <name>', '显示名称（默认同 slug）')
  .requiredOption('--repo <url>', 'Git 仓库地址（https 或 ssh；私有仓库靠管理员配置的 SSH key）')
  .option('--branch <branch>', '分支（默认 main）')
  .requiredOption('--build <type>', '构建方式：dockerfile 或 static（静态托管：不跑构建，仓库里直接放产物）')
  .option('--dockerfile <path>', 'dockerfile：Dockerfile 路径（相对仓库根，默认 Dockerfile）')
  .option('--context <path>', 'dockerfile：构建上下文（相对仓库根，默认仓库根）')
  .option('--publish-dir <path>', 'static：发布目录（相对仓库根，默认 .）')
  .option('--spa', 'static：SPA 模式（所有路径回退到 index.html）')
  .option('--port <n>', 'dockerfile：容器监听端口（默认 3000）；平台自动分配的域名把流量转发到它，static 固定 80')
  .option('--description <text>', '说明')
  .action(appCreate);
app
  .command('update <app>')
  .description('修改应用配置（平台托管的应用会同步写回 Dokploy，下次部署生效）')
  .option('--name <name>', '显示名称')
  .option('--repo <url>', 'Git 仓库地址')
  .option('--branch <branch>', '分支')
  .option('--build <type>', '构建方式：dockerfile 或 static')
  .option('--dockerfile <path>', 'Dockerfile 路径（相对仓库根）')
  .option('--context <path>', '构建上下文（相对仓库根，传空串表示仓库根）')
  .option('--publish-dir <path>', 'static：发布目录')
  .option('--spa', 'static：开启 SPA 模式')
  .option('--no-spa', 'static：关闭 SPA 模式')
  .option('--port <n>', 'dockerfile：容器监听端口（有自动分配域名的应用会同步改域名转发端口）')
  .option('--description <text>', '说明')
  .action(appUpdate);
app
  .command('delete <app>')
  .description('删除应用（平台托管的连 Dokploy 上的一起删；挂载的只解绑）')
  .option('--yes', '确认删除')
  .action(appDelete);
app
  .command('status <app>')
  .description('应用最近一次部署的状态与失败原因')
  .option('--deployment <id>', '查看指定的某次部署（支持 ID 前缀）')
  .action(appStatus);
app
  .command('deployments <app>')
  .description('应用的部署历史（默认 Dokploy 上还留着的最近 10 次，含在 Dokploy 侧直接触发的）')
  .option('--all', '改列平台侧的完整历史，含 Dokploy 已清理掉构建记录的那些')
  .action(appDeployments);
app
  .command('build-logs <app>')
  .description('读 Dokploy 上的构建日志（部署失败先看它，能看到真实报错）')
  .option('--tail <n>', `日志行数（默认 ${LOG_TAIL_DEFAULT}）`)
  .option('--deployment <id>', '指定某次构建（默认最近一次）')
  .option('--list', '只列出最近的构建记录')
  .action(buildLogs);
app
  .command('run-logs <app>')
  .description('读应用容器的运行日志（构建成功但服务不正常时看它）')
  .option('--tail <n>', `日志行数（默认 ${LOG_TAIL_DEFAULT}）`)
  .option('--container <id>', '指定容器（多副本时用，默认第一个运行中的）')
  .option('--list', '只列出当前容器')
  .action(runLogs);

const appEnv = app.command('env').description('应用的 env：运行时（默认）与构建时（--build）两块，直接读写 Dokploy 上的配置');
appEnv
  .command('pull <app>')
  .description('拉取应用 env，默认写入 ./.env（--build 时 ./.env.build）')
  .option('--build', '构建时 env（Dokploy 的 Build Args）而非运行时 env')
  .option('--out <file>', '输出文件')
  .option('--print', '打印到标准输出而不写文件')
  .action(appEnvPull);
appEnv
  .command('push <app>')
  .description('用本地 dotenv 文件整体覆盖应用 env，默认读 ./.env（--build 时 ./.env.build），只回 key 级变化')
  .option('--build', '推送到构建时 env（Dokploy 的 Build Args）')
  .option('--file <file>', '要推送的 dotenv 文件')
  .action(appEnvPush);

program
  .command('self-update')
  .description('把 eat CLI 更新到平台当前分发的版本（跨平台单命令，无需重跑安装脚本）')
  .option('--server <url>', '平台地址（默认取已保存的登录地址或 EAT_SERVER）')
  .option('--force', '即使版本未变也重新下载覆盖')
  .action(selfUpdate);

program
  .command('mcp')
  .description('启动 MCP server（stdio），把平台能力提供给本地 AI')
  .action(startMcpServer);

if (process.argv[2] !== 'mcp') {
  process.on('exit', flushUpdateNotice);
}

program.parseAsync().catch((err: unknown) => {
  if (err instanceof ApiError) {
    console.error(`错误(${err.code}): ${err.message}`);
    const details = formatErrorDetails(err.details);
    if (details) console.error(details);
  } else {
    console.error(`错误: ${(err as Error).message}`);
  }
  process.exit(1);
});
