import { z } from 'zod';

/** 平台统一错误码 */
export const ErrorCode = {
  /** 无权限读取，需要发起权限申请（附带 howToRequest 指引，AI 可据此自助申请） */
  PermissionRequired: 'PERMISSION_REQUIRED',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  ValidationFailed: 'VALIDATION_FAILED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** API 错误响应体（所有非 2xx 响应统一此结构） */
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const userRoleSchema = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userPublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
});
export type UserPublic = z.infer<typeof userPublicSchema>;

/** slug：作为 URL 与本地目录名，限小写字母数字与连字符 */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug 仅允许小写字母、数字和连字符，且以字母或数字开头');
