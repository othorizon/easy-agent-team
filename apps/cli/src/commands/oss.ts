import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import { ossToolRequest, OSS_CREDENTIAL_NOTE } from '@eat/shared';
import { Api } from '../client.js';

export async function ossCall(
  name: string,
  args: Record<string, unknown> = {},
) {
  const requestId =
    typeof args.requestId === 'string' ? args.requestId : randomUUID();
  if (name === 'request_oss_space')
    console.error(`申请标识: ${requestId}（网络失败时使用 --request-id 复用）`);
  const request = ossToolRequest(name, args, requestId);
  const result = await Api.fromSaved().request(
    request.method,
    request.path,
    request.body,
  );
  console.log(JSON.stringify(result, null, 2));
}
export function registerOssCommands(program: Command) {
  const oss = program
    .command('oss')
    .description('OSS 空间：申请、查询、公开读与个人共享凭证');
  oss
    .command('status')
    .description('查询对象存储启用状态')
    .action(() => ossCall('get_oss_status'));
  oss
    .command('list')
    .description('列出我的空间及审批状态')
    .action(() => ossCall('list_oss_spaces'));
  oss
    .command('request <name>')
    .description('申请空间，等待管理员批准')
    .requiredOption('--purpose <purpose>', '用途说明')
    .option('--request-id <uuid>', '失败重试时复用的申请标识')
    .action((name, opts) => ossCall('request_oss_space', { name, ...opts }));
  oss
    .command('show <id>')
    .description('查看空间路径、域名、CDN 标记与公开读')
    .action((space) => ossCall('get_oss_space', { space }));
  oss
    .command('update <id>')
    .option('--name <name>', '空间名称')
    .option('--purpose <purpose>', '用途说明')
    .action((space, opts) => ossCall('update_oss_space', { space, ...opts }));
  oss
    .command('public-read <id> <state>')
    .description('开启或关闭整个空间的公开读：on / off')
    .action((space, state) => {
      if (!['on', 'off'].includes(state))
        throw new Error('state 必须为 on 或 off');
      return ossCall('set_oss_space_public_read', {
        space,
        enabled: state === 'on',
      });
    });
  const credentials = oss
    .command('credentials')
    .description(`领取个人共享 AK/SK。${OSS_CREDENTIAL_NOTE}`)
    .action(() => ossCall('get_oss_credentials'));
  credentials
    .command('reset')
    .description('重置共享凭证，所有空间的旧凭证将失效')
    .requiredOption('--yes', '确认影响全部空间')
    .action(() => ossCall('reset_oss_credentials'));
  oss
    .command('operation <id>')
    .description('查询重置等后台操作状态')
    .action((operationId) => ossCall('get_oss_operation', { operationId }));
}
