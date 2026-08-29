import { z } from 'zod';
import { slugSchema } from './common.js';

/** 环境变量 Key：沿用惯例，大写字母开头的大写蛇形 */
export const variableKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Key 仅允许字母、数字、下划线，且不能以数字开头');

// ---------- 环境 ----------

export const createEnvironmentSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
});
export type CreateEnvironmentRequest = z.infer<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = createEnvironmentSchema.partial().omit({ slug: true });
export type UpdateEnvironmentRequest = z.infer<typeof updateEnvironmentSchema>;

export const environmentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  variableCount: z.number(),
  createdAt: z.string(),
});
export type EnvironmentInfo = z.infer<typeof environmentSchema>;

// ---------- 变量 ----------

export const upsertVariableSchema = z.object({
  key: variableKeySchema,
  value: z.string().max(65536),
  description: z.string().max(2000).default(''),
  /** 无权限时是否在清单中可见（默认可见——让 AI 能"看见清单、看懂用途"） */
  visibleWithoutPermission: z.boolean().default(true),
  /** 是否敏感（默认敏感）：敏感值加密存储、读取需授权；非敏感值明文存储、全员可在平台明文查看 */
  secret: z.boolean().default(true),
});
export type UpsertVariableRequest = z.infer<typeof upsertVariableSchema>;

/** 变量清单条目：敏感变量不含值；非敏感变量附带明文值。hasAccess 告诉调用方（人或 AI）能否读值 */
export const variableMetaSchema = z.object({
  id: z.string(),
  environmentSlug: z.string(),
  key: z.string(),
  description: z.string(),
  visibleWithoutPermission: z.boolean(),
  secret: z.boolean(),
  /** 非敏感变量的明文值；敏感变量恒为 null */
  value: z.string().nullable(),
  hasAccess: z.boolean(),
  version: z.number(),
  updatedAt: z.string(),
});
export type VariableMeta = z.infer<typeof variableMetaSchema>;

/** 拉取值：可指定 keys，缺省拉取该环境下有权限的全部变量 */
export const pullValuesRequestSchema = z.object({
  keys: z.array(variableKeySchema).optional(),
});
export type PullValuesRequest = z.infer<typeof pullValuesRequestSchema>;

export const deniedVariableSchema = z.object({
  key: z.string(),
  error: z.literal('PERMISSION_REQUIRED'),
  message: z.string(),
  howToRequest: z.string(),
});
export type DeniedVariable = z.infer<typeof deniedVariableSchema>;

export const pullValuesResponseSchema = z.object({
  environment: z.string(),
  values: z.record(z.string(), z.string()),
  /** 请求了但无权限的变量：结构化返回，引导发起申请而不是无声失败 */
  denied: z.array(deniedVariableSchema),
});
export type PullValuesResponse = z.infer<typeof pullValuesResponseSchema>;

// ---------- 授权 ----------

export const createGrantSchema = z
  .object({
    userId: z.string(),
    /** 二选一：变量级授权 */
    variableId: z.string().optional(),
    /** 二选一：环境级授权（该环境全部变量，含未来新增） */
    environmentId: z.string().optional(),
    /** 授权有效期，缺省永久 */
    expiresAt: z.iso.datetime().optional(),
  })
  .refine((v) => (v.variableId ? !v.environmentId : !!v.environmentId), {
    message: 'variableId 与 environmentId 必须且只能提供一个',
  });
export type CreateGrantRequest = z.infer<typeof createGrantSchema>;

export const grantSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  variableId: z.string().nullable(),
  variableKey: z.string().nullable(),
  environmentId: z.string().nullable(),
  grantedBy: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type GrantInfo = z.infer<typeof grantSchema>;

// ---------- 权限申请 ----------

export const createAccessRequestSchema = z.object({
  environmentSlug: slugSchema,
  /** 申请哪些变量的读取权限 */
  keys: z.array(variableKeySchema).min(1),
  reason: z.string().min(1).max(2000),
});
export type CreateAccessRequest = z.infer<typeof createAccessRequestSchema>;

export const accessRequestStatusSchema = z.enum(['pending', 'approved', 'rejected']);

export const accessRequestSchema = z.object({
  id: z.string(),
  requesterId: z.string(),
  requesterName: z.string(),
  environmentSlug: z.string(),
  keys: z.array(z.string()),
  reason: z.string(),
  status: accessRequestStatusSchema,
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  grantExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AccessRequestInfo = z.infer<typeof accessRequestSchema>;

export const decideAccessRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  /** 批准时可设授权有效期，缺省永久 */
  grantExpiresAt: z.iso.datetime().optional(),
});
export type DecideAccessRequest = z.infer<typeof decideAccessRequestSchema>;
