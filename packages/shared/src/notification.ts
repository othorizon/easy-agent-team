import { z } from 'zod';
import type { GithubOrgState } from './github.js';
import type { UserNotificationStatus } from './feishu-app.js';

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled';
  bio: string;
  canNotifyAll: boolean;
  notificationReady: boolean;
  /** GitHub 简要信息只向管理员返回。 */
  github?: { login: string; orgState: GithubOrgState; needsAuthorization: boolean } | null;
  /** 通知配置摘要只向管理员返回，不包含凭证。 */
  notification?: UserNotificationStatus;
}

export const sendNotificationSchema = z.object({
  to: z.array(z.string().trim().min(1).max(254)).min(1).max(100).optional(),
  all: z.boolean().default(false),
  title: z.string().trim().min(1).max(100).refine(v => !/[\r\n]/.test(v), '标题不能包含换行'),
  body: z.string().min(1).max(10000).refine(v => !!v.trim(), '正文不能为空')
    .refine(v => new TextEncoder().encode(v).length <= 20000, '正文不能超过 20 KB')
    .refine(v => !/<at\b/i.test(v), '通知正文不支持飞书 @ 标签；请使用 to 或 all 选择接收人'),
  dryRun: z.boolean().default(false),
}).refine(v => v.all !== !!v.to?.length, { message: 'to 与 all 必须且只能提供一个' });
export type SendNotificationRequest = z.infer<typeof sendNotificationSchema>;

export interface NotificationRecipientResult {
  id: string;
  name: string;
  email: string;
  status: 'ready' | 'sent' | 'failed' | 'unavailable';
  reason?: string;
}
export interface SendNotificationResult {
  dryRun: boolean;
  title: string;
  recipients: NotificationRecipientResult[];
}

/** 标题及署名为纯文本；正文独占 Markdown 组件，署名由认证账号决定。 */
export function buildNotificationCard(input: { title: string; body: string; senderName: string; all: boolean; sentAt: Date }): Record<string, unknown> {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(input.sentAt);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  const time = `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  return {
    config: { wide_screen_mode: true },
    header: { template: input.all ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: `${input.all ? '全员通知' : '通知'}｜${input.title}` } },
    elements: [
      { tag: 'markdown', content: input.body },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: `发送人：${input.senderName.replace(/\s+/g, ' ')} · ${time} · EAT` }] },
    ],
  };
}
