import { z } from 'zod';

export const bioSchema = z.string().trim().max(2000, '个人简介最多 2000 字');
export const updateBioSchema = z.object({ bio: bioSchema });
export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  bio: bioSchema.optional(),
  allowHelp: z.boolean().optional(),
});
export type UpdateAccountRequest = z.infer<typeof updateAccountSchema>;
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  password: z.string().min(8, '密码至少 8 位').max(72, '密码最多 72 字符')
    .refine((value) => new TextEncoder().encode(value).length <= 72, '密码的 UTF-8 编码不能超过 72 字节'),
});
export const feishuWebhookSchema = z.string().trim().max(500).regex(
  /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/,
  '请输入有效的飞书自定义机器人 Webhook 地址',
);
export const sendWebhookCodeSchema = z.object({
  webhookUrl: feishuWebhookSchema,
  /** 空字符串明确表示不使用加签；省略则只在地址相同时保留原密钥。 */
  webhookSecret: z.string().trim().max(200).optional(),
});
export const verifyWebhookSchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/, '请输入 6 位验证码'),
});
export const notificationPreferencesSchema = z.object({
  notifyHelp: z.boolean(),
  notifyReply: z.boolean(),
  notifyMention: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export interface OnboardingStatus {
  requireBio: boolean;
  requireNotification: boolean;
  bioComplete: boolean;
  notificationComplete: boolean;
  required: boolean;
}
export interface NotificationSettings extends NotificationPreferences {
  webhookUrl: string;
  hasWebhookSecret: boolean;
  verified: boolean;
}
export interface AccountInfo {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  bio: string;
  allowHelp: boolean;
  notification: NotificationSettings;
  onboarding: OnboardingStatus;
}
