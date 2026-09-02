import { Command } from 'commander';
import { CLI_VERSION, LOG_TAIL_DEFAULT } from '@eat/shared';
import { ApiError, formatErrorDetails } from './client.js';
import { login, logout, whoami } from './commands/auth.js';
import { envList, envPull, envRequest, envRequests } from './commands/env.js';
import { askCreate, askDelete, askList, askReply, askResolve, askShow, askTargets } from './commands/ask.js';
import { dbInstances, dbList, dbRequest } from './commands/db.js';
import {
  buildLogs,
  deployRun,
  projectDeployments,
  projectList,
  projectStatus,
  runLogs,
  scanOnly,
} from './commands/deploy.js';
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
// deploy 留在顶层：最高频，且做成 `project deploy` 会与 `project <slug>` 形式的参数打架
program
  .command('deploy [project]')
  .description('部署项目：本地前置检查通过后触发 Dokploy 部署')
  .option('--dir <dir>', '代码目录（默认当前目录）')
  .option('--check <cmd>', '可选的本地预跑命令（如 "pnpm build"），非零退出则阻止部署')
  .action(deployRun);

const project = program.command('project').description('部署项目：清单、部署状态、构建日志、运行日志');
project.command('list').description('查看部署项目与自己的成员身份').action(projectList);
project
  .command('status <project>')
  .description('项目最近一次部署的状态与失败原因')
  .option('--deployment <id>', '查看指定的某次部署（支持 ID 前缀）')
  .action(projectStatus);
project
  .command('deployments <project>')
  .description('项目的部署历史（默认 Dokploy 上还留着的最近 10 次，含在 Dokploy 侧直接触发的）')
  .option('--all', '改列平台侧的完整历史，含 Dokploy 已清理掉构建记录的那些')
  .action(projectDeployments);
project
  .command('build-logs <project>')
  .description('读 Dokploy 上的构建日志（部署失败先看它，能看到真实报错）')
  .option('--tail <n>', `日志行数（默认 ${LOG_TAIL_DEFAULT}）`)
  .option('--deployment <id>', '指定某次构建（默认最近一次）')
  .option('--list', '只列出最近的构建记录')
  .action(buildLogs);
project
  .command('run-logs <project>')
  .description('读应用容器的运行日志（构建成功但服务不正常时看它）')
  .option('--tail <n>', `日志行数（默认 ${LOG_TAIL_DEFAULT}）`)
  .option('--container <id>', '指定容器（多副本时用，默认第一个运行中的）')
  .option('--list', '只列出当前容器')
  .action(runLogs);

/**
 * 旧命令保留一轮（决策 28）：平台指南、AGENT.md、Agent 记忆里都还留着旧写法，
 * 直接删会让已装好的环境突然报错。隐藏不进 --help，执行时在 stderr 提示新写法。
 */
const renamed = (oldForm: string, newForm: string): void => {
  console.error(`提示: \`${oldForm}\` 已改名为 \`${newForm}\`，旧写法这一版仍可用。`);
};
program
  .command('projects', { hidden: true })
  .action(async () => {
    renamed('eat projects', 'eat project list');
    await projectList();
  });
/**
 * 这个旧命令没法再兼容了（决策 30）：部署记录改以 Dokploy 为准之后，查一次部署必须带项目，
 * 光有一个 ID 定位不到（Dokploy 的构建记录 id 不能反查出属于哪个项目）。给出新写法即可。
 */
program
  .command('deploy-status <id>', { hidden: true })
  .action((id: string) => {
    console.error(`\`eat deploy-status <id>\` 已停用：现在查部署要带项目。`);
    console.error(`新写法: eat project status <project> --deployment ${id}`);
    process.exitCode = 1;
  });
program
  .command('deploy-list <project>', { hidden: true })
  .action(async (slug: string) => {
    renamed('eat deploy-list <project>', 'eat project deployments <project>');
    await projectDeployments(slug, {});
  });

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
