import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { sendNotificationSchema, type SendNotificationResult, type UserListItem } from '@eat/shared';
import { Api } from '../client.js';

const statusLabel = { ready: '可投递', sent: '发送成功', failed: '投递失败', unavailable: '无法投递' };
const oneLine = (text: string) => text.replace(/[\r\n\t\x1b]/g, ' ');

export async function listUsers(opts: { search?: string; json?: boolean }): Promise<void> {
  const all = await Api.fromSaved().request<UserListItem[]>('GET', '/api/users');
  const search = opts.search?.trim().toLowerCase();
  const rows = all.filter(user => user.status !== 'disabled'
    && (!search || [user.id, user.name, user.email].some(v => v.toLowerCase().includes(search))));
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('没有匹配的用户'); return; }
  console.log('用户 ID\t姓名\t邮箱\t角色\t飞书通知');
  for (const user of rows) console.log([user.id, user.name, user.email, user.role === 'admin' ? '管理员' : '成员',
    user.notificationReady ? '已就绪' : '未就绪'].map(oneLine).join('\t'));
}

export async function sendNotification(opts: {
  to?: string[]; all?: boolean; title: string; body?: string; bodyFile?: string; dryRun?: boolean;
}): Promise<void> {
  if ((opts.body !== undefined) === (opts.bodyFile !== undefined)) throw new Error('--body 与 --body-file 必须且只能提供一个');
  const body = opts.body ?? readFileSync(opts.bodyFile === '-' ? 0 : opts.bodyFile!, 'utf8');
  const parsed = sendNotificationSchema.safeParse({ to: opts.to?.length ? opts.to : undefined, all: opts.all, title: opts.title, body, dryRun: opts.dryRun });
  if (!parsed.success) throw new Error(parsed.error.issues.map(i => i.message).join('；'));
  const result = await Api.fromSaved().request<SendNotificationResult>('POST', '/api/notifications/send', parsed.data);
  console.log(`${result.dryRun ? '预检查（未发送）' : '通知投递结果'}：${oneLine(result.title)}`);
  for (const recipient of result.recipients) console.log(
    `${statusLabel[recipient.status]}  ${oneLine(recipient.name)} <${recipient.email}>  ${recipient.id}${recipient.reason ? ` — ${recipient.reason}` : ''}`);
  if (!result.recipients.length) console.log('没有可通知的用户');
  console.log(`共 ${result.recipients.length} 人：` + Object.entries(statusLabel)
    .map(([key, label]) => `${label} ${result.recipients.filter(r => r.status === key).length}`).join('，'));
  if (!result.recipients.length || result.recipients.some(r => r.status === 'failed' || r.status === 'unavailable')) process.exitCode = 1;
}

export function registerNotifyCommands(program: Command) {
  program.command('users').description('查询正常账号：ID、姓名、邮箱、角色、状态和飞书通知就绪情况')
    .option('--search <keyword>', '按用户 ID、姓名或邮箱搜索')
    .option('--json', '输出 JSON').action(listUsers);
  program.command('notify').description('向指定用户或所有用户发送飞书 Markdown 通知')
    .command('send').description('发送通知，发送人固定为当前登录账号')
    .option('--to <user>', '接收人的完整 ID 或邮箱，可重复指定', (value: string, previous: string[]) => [...previous, value], [])
    .option('--all', '向所有正常用户广播（需管理员授权）')
    .requiredOption('--title <title>', '纯文本标题')
    .option('--body <markdown>', 'Markdown 正文')
    .option('--body-file <path>', '从 UTF-8 文件读取正文，- 表示标准输入')
    .option('--dry-run', '检查权限、接收范围和内容，不发送').action(sendNotification);
}
