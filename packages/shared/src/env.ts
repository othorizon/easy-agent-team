import { z } from 'zod';
import { slugSchema } from './common.js';

/** 环境变量 Key：沿用惯例，大写字母开头的大写蛇形 */
export const variableKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Key 仅允许字母、数字、下划线，且不能以数字开头');

// ---------- 环境 ----------

export const environmentVisibilitySchema = z.enum(['team', 'private']);
export type EnvironmentVisibility = z.infer<typeof environmentVisibilitySchema>;

export const createEnvironmentSchema = z.object({
  slug: slugSchema,
  visibility: environmentVisibilitySchema.default('team'),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
});
export type CreateEnvironmentRequest = z.infer<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = createEnvironmentSchema.partial().omit({ slug: true });
export type UpdateEnvironmentRequest = z.infer<typeof updateEnvironmentSchema>;

/**
 * 当前用户对这个环境的读值能力（清单行右侧的状态、「可读取」筛选都看它）：
 * manage = Owner 或管理员，全部可读也可改；all = 环境级授权；partial = 部分变量授权；none = 一个都读不了
 */
export const environmentAccessSchema = z.enum(['manage', 'all', 'partial', 'none']);
export type EnvironmentAccess = z.infer<typeof environmentAccessSchema>;

export const environmentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  visibility: environmentVisibilitySchema,
  ownerId: z.string(),
  ownerName: z.string(),
  ownerEmail: z.string(),
  variableCount: z.number(),
  access: environmentAccessSchema,
  /** 当前用户能读值的变量数；manage / all 时等于 variableCount */
  readableCount: z.number(),
  /** 当前用户在这个环境上有待审批的权限申请——清单上显示「申请中」，免得重复申请 */
  pendingRequest: z.boolean(),
  createdAt: z.string(),
});
export type EnvironmentInfo = z.infer<typeof environmentSchema>;

/** 环境清单的分页上限：控制台默认 20；选择器类场景（角色模板）一次取满 1000 */
export const ENV_LIST_MAX_PAGE_SIZE = 1000;
export const ENV_LIST_DEFAULT_PAGE_SIZE = 20;

/** 清单按与我的关系筛选：mine = 我是 Owner；readable = 我至少能读一个变量的值（access 不是 none） */
export const envListScopeSchema = z.enum(['all', 'mine', 'readable']);
export type EnvListScope = z.infer<typeof envListScopeSchema>;

/** GET /api/envs 的查询串（数值从 query 来，用 coerce） */
export const envListQuerySchema = z.object({
  /** 关键词：匹配 slug / 名称 / 备注，大小写不敏感 */
  q: z.string().trim().max(100).optional(),
  scope: envListScopeSchema.default('all'),
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
  /** 各范围各有几条：关键词已应用、scope 不参与——回答「切到那个范围会有几条」 */
  scopeCounts: z.object({
    all: z.number(),
    mine: z.number(),
    readable: z.number(),
  }),
});
export type EnvListResult = z.infer<typeof envListResultSchema>;

// ---------- 变量 ----------

/** 单个变量值的上限：upsert 与批量导入共用 */
export const VARIABLE_VALUE_MAX_LENGTH = 65536;

/**
 * 新增或更新一个变量。除 key 外都可缺省 = 保持原值（新增时取默认值）——
 * CLI `eat env set` 只改值时不带元信息，若缺省就重置，会把备注清空、非敏感改回敏感、
 * 隐藏的变量变成人人可见（暴露变量的存在）。控制台每次都传全量，不受影响。
 */
export const upsertVariableSchema = z.object({
  key: variableKeySchema,
  /**
   * 新增时必填；更新时可缺省 = 保持当前值不变、版本不递增——只想改备注 / 可见性 / 敏感标记时，
   * 敏感变量的值控制台本就拿不到，不能逼着重填一遍。传入的值与现值相同也不递增版本
   */
  value: z.string().max(VARIABLE_VALUE_MAX_LENGTH).optional(),
  /** 新增时默认空 */
  description: z.string().max(2000).optional(),
  /**
   * 没有读取权限的成员能否在清单里看到这个变量——看到的只有名称与备注，值永远看不到。
   * 新增时默认可见：让 AI 能"看见清单、看懂用途"，知道该申请什么；关闭则对他们完全隐藏，连变量存在都不知道。
   */
  visibleWithoutPermission: z.boolean().optional(),
  /** 是否敏感（新增时默认敏感）。只影响存储与展示：敏感值加密存储、控制台打码；非敏感值明文存储、有权限者在平台直接明文可见。读值授权模型两者一致 */
  secret: z.boolean().optional(),
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

/** upsert 的回执：在清单条目之外说明这次是新建还是更新、值有没有变 */
export const upsertVariableResultSchema = variableMetaSchema.extend({
  created: z.boolean(),
  valueChanged: z.boolean(),
});
export type UpsertVariableResult = z.infer<typeof upsertVariableResultSchema>;

/** 批量导入一次最多多少个 key：够放下一份正常的 .env，又不至于一次事务锁太久 */
export const ENV_IMPORT_MAX_KEYS = 500;

/**
 * 批量导入（`eat env push`）：只改值——已存在变量的备注 / 敏感标记 / 可见性一律不动，值相同的不升版本。
 * 默认只增改；prune=true 时再删掉平台上有、本次没提供的 key，让环境与文件一致。
 * 删变量会连同它的变量级授权一起删掉，所以破坏性的方向必须显式开启。
 */
export const importVariablesSchema = z.object({
  values: z
    .record(variableKeySchema, z.string().max(VARIABLE_VALUE_MAX_LENGTH))
    .refine((v) => Object.keys(v).length <= ENV_IMPORT_MAX_KEYS, {
      message: `一次最多导入 ${ENV_IMPORT_MAX_KEYS} 个变量`,
    }),
  prune: z.boolean().default(false),
  /** 只算差异、不写入 */
  dryRun: z.boolean().default(false),
  /** 本次新建的变量是否敏感（默认敏感）；已存在变量的敏感标记不动 */
  secret: z.boolean().default(true),
});
export type ImportVariablesRequest = z.infer<typeof importVariablesSchema>;

/** 导入结果只有 key，不回传任何值 */
export const importVariablesResultSchema = z.object({
  environment: z.string(),
  dryRun: z.boolean(),
  prune: z.boolean(),
  added: z.array(z.string()),
  changed: z.array(z.string()),
  unchanged: z.number(),
  /** prune 时删除（预演时为将要删除）的 key */
  removed: z.array(z.string()),
  /** 不 prune 时：平台上有、本次没提供而保留下来的 key——加 prune 前先看清会删什么 */
  kept: z.array(z.string()),
});
export type ImportVariablesResult = z.infer<typeof importVariablesResultSchema>;

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

export const accessRequestStatusSchema = z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'invalid']);

export const accessRequestSchema = z.object({
  id: z.string(),
  requesterId: z.string(),
  requesterName: z.string(),
  environmentSlug: z.string(),
  keys: z.array(z.string()),
  reason: z.string(),
  status: accessRequestStatusSchema,
  decidedBy: z.string().nullable(),
  /** 审批人姓名；未处理时为 null（历史审批清单要显示是谁批的，只给 id 没法看） */
  decidedByName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  grantExpiresAt: z.string().nullable(),
  rejectionReason: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type AccessRequestInfo = z.infer<typeof accessRequestSchema>;

export const ACCESS_REQUEST_HISTORY_MAX_PAGE_SIZE = 1000;
export const ACCESS_REQUEST_HISTORY_DEFAULT_PAGE_SIZE = 20;

/** 历史审批按结果筛选：控制台「全部 / 已批准 / 已驳回」分段就是它 */
export const accessRequestHistoryStatusSchema = z.enum(['all', 'approved', 'rejected']);
export type AccessRequestHistoryStatus = z.infer<typeof accessRequestHistoryStatusSchema>;

/** GET /api/access-requests/history 的查询串（数值从 query 来，用 coerce）——决策 45 */
export const accessRequestHistoryQuerySchema = z.object({
  status: accessRequestHistoryStatusSchema.default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(ACCESS_REQUEST_HISTORY_MAX_PAGE_SIZE)
    .default(ACCESS_REQUEST_HISTORY_DEFAULT_PAGE_SIZE),
});
export type AccessRequestHistoryQuery = z.infer<typeof accessRequestHistoryQuerySchema>;

export const accessRequestHistoryResultSchema = z.object({
  /** 按审批时间倒序 */
  items: z.array(accessRequestSchema),
  /** 筛选后的总条数（不是本页条数） */
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  /** 两种结果各有几条：status 筛选不参与——回答「切到那个分段会有几条」 */
  counts: z.object({
    approved: z.number(),
    rejected: z.number(),
  }),
});
export type AccessRequestHistoryResult = z.infer<typeof accessRequestHistoryResultSchema>;

export const decideAccessRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason:z.string().trim().max(2000).optional(),
  /** 批准时可设授权有效期，缺省永久 */
  grantExpiresAt: z.iso.datetime().optional(),
});
export type DecideAccessRequest = z.infer<typeof decideAccessRequestSchema>;
