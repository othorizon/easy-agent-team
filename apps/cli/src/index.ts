import { Command } from 'commander';
import { ApiError } from './client.js';
import { login, logout, whoami } from './commands/auth.js';
import { envList, envPull, envRequest, envRequests } from './commands/env.js';
import { askCreate, askList, askReply, askResolve, askShow, askTargets } from './commands/ask.js';
import { dbInstances, dbList, dbRequest } from './commands/db.js';
import { deployList, deployRun, deployStatus, projectsList, scanOnly } from './commands/deploy.js';
import { skillList, skillPush, skillSubscribe, skillUnsubscribe } from './commands/skill.js';
import { sync } from './commands/sync.js';
import { startMcpServer } from './mcp.js';

const program = new Command();

program
  .name('eat')
  .description('easy-agent-team CLI：团队 AI 能力的拉取、同步与求助入口')
  .version('0.1.0');

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
  .description('回复 / 追问')
  .requiredOption('--message <message>', '内容')
  .action(askReply);
ask.command('resolve <id>').description('标记已解决').action(askResolve);

program
  .command('sync')
  .description('同步已订阅的 Skill 到本地（默认 ~/.claude/skills）')
  .option('--dir <dir>', '落地目录')
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

program.command('projects').description('查看部署项目与自己的成员身份').action(projectsList);
program
  .command('scan [dir]')
  .description('本地密钥扫描（通用规则 + 平台密钥指纹 + .env 误提交），不部署')
  .action(scanOnly);
program
  .command('deploy [project]')
  .description('部署项目：本地前置检查通过后触发 Dokploy 部署')
  .option('--dir <dir>', '代码目录（默认当前目录）')
  .option('--check <cmd>', '可选的本地预跑命令（如 "pnpm build"），非零退出则阻止部署')
  .action(deployRun);
program.command('deploy-status <id>').description('查询部署状态').action(deployStatus);
program.command('deploy-list <project>').description('项目的部署历史').action(deployList);

program
  .command('mcp')
  .description('启动 MCP server（stdio），把平台能力提供给本地 AI')
  .action(startMcpServer);

program.parseAsync().catch((err: unknown) => {
  if (err instanceof ApiError) {
    console.error(`错误(${err.code}): ${err.message}`);
  } else {
    console.error(`错误: ${(err as Error).message}`);
  }
  process.exit(1);
});
