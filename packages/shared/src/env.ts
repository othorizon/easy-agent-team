import { z } from 'zod';
import { slugSchema } from './common.js';
import { dbAssignmentStatusSchema } from './db.js';

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

/** 环境来源：手工创建，或数据库分配批准时自动生成的凭证环境（决策 39） */
export const environmentSourceSchema = z.enum(['manual', 'db_assignment']);
export type EnvironmentSource = z.infer<typeof environmentSourceSchema>;

/** 凭证环境回指生成它的数据库分配：从环境能找回是哪个库、在哪个实例、现在什么状态，页面之间可以互相跳转 */
export const environmentDbAssignmentSchema = z.object({
  id: z.string(),
  dbName: z.string(),
  instanceName: z.string(),
  status: dbAssignmentStatusSchema,
});
export type EnvironmentDbAssignment = z.infer<typeof environmentDbAssignmentSchema>;

export const environmentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  ownerEmail: z.string(),
  source: environmentSourceSchema,
  /** source=db_assignment 时指向生成它的分配记录；分配记录已不存在（实例被删等）时为 null */
  dbAssignment: environmentDbAssignmentSchema.nullable(),
  variableCount: z.number(),
  createdAt: z.string(),
});
export type EnvironmentInfo = z.infer<typeof environmentSchema>;

/** 环境清单的分页上限：控制台默认 20；选择器类场景（角色模板）一次取满 1000 */
export const ENV_LIST_MAX_PAGE_SIZE = 1000;
export const ENV_LIST_DEFAULT_PAGE_SIZE = 20;

/** 清单按来源筛选：控制台的「常规 / 数据库」页签就是它 */
export const envListSourceSchema = z.enum(['all', 'manual', 'db_assignment']);
export type EnvListSource = z.infer<typeof envListSourceSchema>;

/** GET /api/envs 的查询串（数值从 query 来，用 coerce） */
export const envListQuerySchema = z.object({
  /** 关键词：匹配 slug / 名称 / 备注 / 关联库名，大小写不敏感 */
  q: z.string().trim().max(100).optional(),
  source: envListSourceSchema.default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(ENV_LIST_MAX_PAGE_SIZE).default(ENV_LIST_DEFAULT_PAGE_SIZE),
});
export type EnvListQuery = z.infer<typeof envListQuerySchema>;

export const envListResultSchema = z.object({
  items: z.array(environmentSchema),
  /** 筛选后的总条数（不是本页条数） */
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  /** 两类来源各有几条：关键词已应用、source 不参与——回答「切到那个页签会有几条」 */
  counts: z.object({
    manual: z.number(),
    db_assignment: z.number(),
  }),
});
export type EnvListResult = z.infer<typeof envListResultSchema>;

// ---------- 变量 ----------

export const upsertVariableSchema = z.object({
  key: variableKeySchema,
  /**
   * 新增时必填；更新时可缺省 = 保持当前值不变、版本不递增——只想改备注 / 可见性 / 敏感标记时，
   * 敏感变量的值控制台本就拿不到，不能逼着重填一遍
   */
  value: z.string().max(65536).optional(),
  description: z.string().max(2000).default(''),
  /**
   * 没有读取权限的成员能否在清单里看到这个变量——看到的只有名称与备注，值永远看不到。
   * 默认可见：让 AI 能"看见清单、看懂用途"，知道该申请什么；关闭则对他们完全隐藏，连变量存在都不知道。
   */
  visibleWithoutPermission: z.boolean().default(true),
  /** 是否敏感（默认敏感）。只影响存储与展示：敏感值加密存储、控制台打码；非敏感值明文存储、有权限者在平台直接明文可见。读值授权模型两者一致 */
  secret: z.boolean().default(true),
});
export type UpsertVariableRequest = z.infer<typeof upsertVariableSchema>;

/** 变量清单条目。hasAccess 告诉调用方（人或 AI）能否读值 */
export const variableMetaSchema = z.object({
  id: z.string(),
  environmentSlug: z.string(),
  key: z.string(),
  description: z.string(),
  visibleWithoutPermission: z.boolean(),
  secret: z.boolean(),
  /** 非敏感变量且有权限时附带的明文值；其余情况恒为 null */
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
