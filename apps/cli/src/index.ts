import { Command } from 'commander';
import { ApiError } from './client.js';
import { login, logout, whoami } from './commands/auth.js';
import { envList, envPull, envRequest, envRequests } from './commands/env.js';
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
