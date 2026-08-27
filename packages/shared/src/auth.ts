import { z } from 'zod';
import { userPublicSchema } from './common.js';

/** Web 控制台密码登录 */
export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  token: z.string(),
  user: userPublicSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** 设备码授权流（CLI 登录）：CLI 发起 → 用户在控制台确认 → CLI 轮询取 Token */
export const deviceStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  /** 用户打开此地址输入 userCode 完成授权 */
  verificationUri: z.string(),
  /** CLI 轮询间隔（秒） */
  interval: z.number(),
  /** 过期秒数 */
  expiresIn: z.number(),
});
export type DeviceStartResponse = z.infer<typeof deviceStartResponseSchema>;

export const deviceApproveRequestSchema = z.object({
  userCode: z.string().min(1),
  /** Token 备注名，便于在控制台辨认（默认由服务端生成） */
  tokenName: z.string().max(100).optional(),
});
export type DeviceApproveRequest = z.infer<typeof deviceApproveRequestSchema>;

export const devicePollRequestSchema = z.object({
  deviceCode: z.string().min(1),
});
export type DevicePollRequest = z.infer<typeof devicePollRequestSchema>;

export const devicePollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('approved'), token: z.string(), user: userPublicSchema }),
]);
export type DevicePollResponse = z.infer<typeof devicePollResponseSchema>;

export const createUserRequestSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8, '密码至少 8 位'),
  role: z.enum(['admin', 'member']).default('member'),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const apiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiTokenInfo = z.infer<typeof apiTokenSchema>;
