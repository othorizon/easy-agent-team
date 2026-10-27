import { z } from 'zod';

/**
 * 飞书自建应用通知（决策 92）。
 *
 * 通知渠道是平台级的互斥单选：`webhook` = 每人一个飞书群自定义机器人（决策 16/17），
 * `app` = 管理员安装的企业自建应用，机器人私聊推送、卡片可回调可更新。
 * 两种渠道的用户数据分开保存，切换渠道不会丢掉另一边已完成的配置。
 */
export const notificationChannelSchema = z.enum(['webhook', 'app']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export const NOTIFICATION_CHANNELS: Record<NotificationChannel, string> = {
  webhook: '个人飞书群机器人（Webhook）',
  app: '飞书自建应用机器人',
};

/** 机器人通知需要的应用身份权限。顺序即展示顺序；改这里要同步内置的导入 JSON（由函数生成，无需手改）。 */
export const FEISHU_APP_SCOPES = [
  {
    scope: 'im:message:send_as_bot',
    name: '以应用的身份发消息',
    purpose: '私聊推送通知卡片、回复绑定结果、更新审批卡片',
  },
  {
    scope: 'im:message.p2p_msg:readonly',
    name: '读取用户发给机器人的单聊消息',
    purpose: '接收成员私聊发来的绑定码',
  },
] as const;

/** 需要在开发者后台「事件与回调」里订阅的项 */
export const FEISHU_APP_SUBSCRIPTIONS = [
  { kind: '事件配置', key: 'im.message.receive_v1', name: '接收消息' },
  { kind: '回调配置', key: 'card.action.trigger', name: '卡片回传交互' },
] as const;

/** 开发者后台「权限管理 → 批量导入/导出权限」可直接粘贴的 JSON */
export function feishuScopesImportJson(): string {
  return JSON.stringify({ scopes: { tenant: FEISHU_APP_SCOPES.map((s) => s.scope), user: [] } }, null, 2);
}

export const FEISHU_CONSOLE_URL = 'https://open.feishu.cn/app';

export function feishuAppConsoleUrl(appId: string): string {
  return `${FEISHU_CONSOLE_URL}/${encodeURIComponent(appId)}`;
}

/** 开发者后台的权限开通页，`q` 预选这些权限（与飞书自己报权限不足时给的链接同一格式） */
export function feishuScopeApplyUrl(appId: string, scopes: readonly string[]): string {
  const q = scopes.length ? `q=${encodeURIComponent(scopes.join(','))}&` : '';
  return `${feishuAppConsoleUrl(appId)}/auth?${q}op_from=eat&token_type=tenant`;
}

/** AppLink：在飞书客户端里直接打开与机器人的单聊 */
export function feishuBotOpenUrl(appId: string): string {
  return `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(appId)}`;
}

/**
 * 绑定码：固定前缀 + 6 位去掉易混字符（0/O/1/I）的大写字母数字，例如 `EAT-7KQ2MX`。
 * 前缀让机器人一眼认出「这条消息是绑定码」，其余私聊消息一律回复使用说明。
 */
export const FEISHU_BIND_CODE_PREFIX = 'EAT-';
export const FEISHU_BIND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const FEISHU_BIND_CODE_LENGTH = 6;
export const FEISHU_BIND_CODE_TTL_SECONDS = 600;
const BIND_CODE_PATTERN = /(?:^|[^A-Za-z0-9])EAT-([A-HJ-NP-Za-hj-np-z2-9]{6})(?![A-Za-z0-9])/i;

/** 从一条私聊文本里认出绑定码（大小写不敏感、允许前后带字），统一成大写；不是绑定码返回 null */
export function extractFeishuBindCode(text: string): string | null {
  const match = BIND_CODE_PATTERN.exec(text);
  return match ? `${FEISHU_BIND_CODE_PREFIX}${match[1].toUpperCase()}` : null;
}

export const feishuAppCredentialsSchema = z.object({
  appId: z
    .string()
    .trim()
    .regex(/^cli_[A-Za-z0-9]{6,64}$/, '请输入飞书应用的 App ID（以 cli_ 开头）'),
  /** 留空 = 保留已保存的值；首次配置必填（服务端校验） */
  appSecret: z.string().trim().max(200).optional(),
  verificationToken: z.string().trim().max(200).optional(),
  encryptKey: z.string().trim().max(200).optional(),
});
export type FeishuAppCredentials = z.infer<typeof feishuAppCredentialsSchema>;

export const updateNotificationChannelSchema = z.object({ channel: notificationChannelSchema });
export type UpdateNotificationChannelRequest = z.infer<typeof updateNotificationChannelSchema>;

/** granted = 已开通；pending = 已在开发者后台添加、等待管理员审核或版本发布；missing = 还没添加 */
export type FeishuScopeStatus = 'granted' | 'pending' | 'missing';
export interface FeishuScopeCheck {
  scope: string;
  name: string;
  purpose: string;
  status: FeishuScopeStatus;
}
export interface FeishuAppCheck {
  checkedAt: string;
  /** App ID / App Secret 能换到 tenant_access_token */
  credentialsOk: boolean;
  /** 应用已开启机器人能力且已启用 */
  botActive: boolean;
  scopes: FeishuScopeCheck[];
  /** 权限状态查询失败的原因（凭据正确时才会查） */
  scopesError: string;
  /** 凭据 / 机器人能力的错误 */
  error: string;
}
export interface FeishuSettingsInfo {
  channel: NotificationChannel;
  appId: string;
  hasAppSecret: boolean;
  hasVerificationToken: boolean;
  hasEncryptKey: boolean;
  /** 开发者后台「事件配置」与「回调配置」的请求地址（同一个） */
  callbackUrl: string;
  botName: string | null;
  botAvatarUrl: string | null;
  check: FeishuAppCheck | null;
  /** 最近一次通过校验的飞书请求（地址验证或事件），用于确认回调已配好 */
  callbackVerifiedAt: string | null;
  lastEventAt: string | null;
  /** 可以切换到自建应用渠道；否则 blockers 列出原因 */
  ready: boolean;
  blockers: string[];
  boundUsers: number;
  activeUsers: number;
  scopesImportJson: string;
}
export interface FeishuScopeApplyResult {
  /** 已调用飞书接口向企业管理员发起授权申请 */
  applied: boolean;
  message: string;
  /** 还有权限没在开发者后台添加时，给出预选好权限的开通页 */
  consoleUrl: string | null;
}

/** 成员视角：自建应用渠道下的绑定状态。应用未配置时整体为 null */
export interface FeishuAppBindingInfo {
  appId: string;
  botName: string | null;
  botAvatarUrl: string | null;
  openBotUrl: string;
  bound: boolean;
  boundAt: string | null;
  /** 绑定的是之前那个应用（管理员换过 App ID），需要重新绑定 */
  stale: boolean;
}
export interface FeishuBindCode {
  code: string;
  expiresAt: string;
  ttlSeconds: number;
}

/** 管理员在用户列表里看到的通知状态 */
export interface UserNotificationStatus {
  channel: NotificationChannel;
  /** 当前渠道下能收到通知 */
  connected: boolean;
  webhookVerified: boolean;
  feishuApp: 'bound' | 'stale' | 'none';
  feishuBoundAt: string | null;
}
