import { z } from 'zod';

/** 数据库账号分配：共享实例内按「库 + 专属账号」隔离，满足日常项目即可 */

/** 库名/账号名：直接进入 SQL 标识符，从严校验 */
export const dbIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,30}$/, '仅小写字母开头，允许小写字母、数字、下划线，3-31 位');

export const createDbInstanceSchema = z.object({
  name: z.string().min(1).max(100),
  engine: z.enum(['postgres', 'mysql']),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  adminUser: z.string().min(1).max(100),
  adminPassword: z.string().max(500).default(''),
  note: z.string().max(2000).default(''),
});
export type CreateDbInstanceRequest = z.infer<typeof createDbInstanceSchema>;

export const updateDbInstanceCredentialsSchema = createDbInstanceSchema.pick({ adminUser: true, adminPassword: true });
export type UpdateDbInstanceCredentialsRequest = z.infer<typeof updateDbInstanceCredentialsSchema>;

export const dbInstanceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.enum(['postgres', 'mysql']),
  host: z.string(),
  port: z.number(),
  adminUser: z.string(),
  note: z.string(),
  assignmentCount: z.number(),
  cleanupError: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type DbInstanceInfo = z.infer<typeof dbInstanceInfoSchema>;

export const createDbAssignmentSchema = z.object({
  instanceId: z.string(),
  dbName: dbIdentifierSchema,
  purpose: z.string().min(1).max(2000),
});
export type CreateDbAssignmentRequest = z.infer<typeof createDbAssignmentSchema>;

export const dbAssignmentStatusSchema = z.enum([
  'pending',
  'provisioning',
  'active',
  'failed',
  'rejected',
  'disabled',
  'deleted',
  'withdrawn',
]);
export type DbAssignmentStatus = z.infer<typeof dbAssignmentStatusSchema>;

export const dbAssignmentInfoSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  /** 实例地址（成员在实例清单里本就可见），详情页展示用 */
  instanceHost: z.string().nullable(),
  instancePort: z.number().nullable(),
  engine: z.enum(['postgres', 'mysql']),
  dbName: z.string(),
  dbUser: z.string(),
  purpose: z.string(),
  status: dbAssignmentStatusSchema,
  requesterId: z.string(),
  requesterName: z.string(),
  /** 最后一次处理（批准 / 驳回 / 禁用 / 恢复 / 删除）的管理员，未处理过为 null */
  decidedByName: z.string().nullable(),
  /**
   * 平台上是否存有这个账号的连接凭证（决策 91：凭证存在分配记录上，不再生成环境变量）。
   * active 时为 true 才能读取；旧版本里凭证环境被删过的存量分配为 false，密码只能到实例上重置
   */
  hasCredentials: z.boolean(),
  error: z.string().nullable(),
  rejectionReason:z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DbAssignmentInfo = z.infer<typeof dbAssignmentInfoSchema>;

/**
 * 按 id 或名称找实例。
 *
 * AI 与人一样，手上多半是刚从清单里读到的**名字**而不是 uuid，两边（CLI 的
 * `eat db request --instance`、MCP 的 `request_db`）都得认。判定只能有一份实现，
 * 否则两条路迟早对「这个名字算不算数」给出不同答案。
 */
export function resolveDbInstance<T extends { id: string; name: string }>(
  instances: T[],
  ref: string,
): T | undefined {
  const needle = ref.trim();
  return instances.find((i) => i.id === needle) ?? instances.find((i) => i.name === needle);
}

/**
 * 数据库连接凭证（决策 91）：`POST /api/db/assignments/:id/credentials` 的回包。
 * 只有申请人与管理员能读，每次读取落 `db_credentials.read` 审计、响应 no-store——
 * 与 OSS 的个人 AK/SK 一样只在数据库这一处取，不进环境变量。
 */
export const dbCredentialsSchema = z.object({
  assignmentId: z.string(),
  engine: z.enum(['postgres', 'mysql']),
  host: z.string(),
  port: z.number(),
  database: z.string(),
  user: z.string(),
  password: z.string(),
  /** 拼好的连接串，用户名与密码已做 URL 编码 */
  url: z.string(),
});
export type DbCredentials = z.infer<typeof dbCredentialsSchema>;

/** 连接串：`postgres://user:pass@host:port/db`；用户名、密码、库名都做 URL 编码 */
export function dbConnectionUrl(c: Omit<DbCredentials, 'url' | 'assignmentId'>): string {
  const scheme = c.engine === 'mysql' ? 'mysql' : 'postgres';
  const enc = encodeURIComponent;
  return `${scheme}://${enc(c.user)}:${enc(c.password)}@${c.host}:${c.port}/${enc(c.database)}`;
}

/**
 * 凭证 → dotenv 变量，按写出顺序。变量名沿用旧凭证环境的 `DB_*`（已有项目的 `.env` 与代码不用改），
 * 另加一条 `DATABASE_URL`（多数 ORM 直接认它）。CLI 写文件 / 打印、控制台复制共用这一份。
 */
export function dbCredentialsToEnv(c: Pick<DbCredentials, 'host' | 'port' | 'database' | 'user' | 'password' | 'url'>): Array<[string, string]> {
  return [
    ['DB_HOST', c.host],
    ['DB_PORT', String(c.port)],
    ['DB_NAME', c.database],
    ['DB_USER', c.user],
    ['DB_PASSWORD', c.password],
    ['DATABASE_URL', c.url],
  ];
}

/**
 * 按 id、库名或 `库名@实例名` 找自己名下的分配，返回全部命中——调用方按 0 条 / 1 条 / 多条分别处理。
 * 库名只在实例内唯一，同名库分在两台实例上时要用 `库名@实例名` 或 id 区分。
 * 与 resolveDbInstance 同理：CLI 命令、CLI stdio MCP、服务端 HTTP MCP 三处共用，判定只能有一份。
 */
export function matchDbAssignments<T extends { id: string; dbName: string; instanceName: string; status: string }>(
  rows: T[],
  ref: string,
): T[] {
  const byId = rows.filter(r => r.id === ref.trim());
  return byId.length ? byId : matchDbReferences(rows.filter(r => r.status !== 'deleted'), ref);
}

export interface DbCredentialTarget {
  kind: 'owner' | 'personal';
  /** owner 分配 ID 或个人授权的目录 ID。 */
  id: string;
  instanceId: string;
  instanceName: string;
  dbName: string;
}

/** 只传本人分配和本人授权。先按实例+库去重并优先 owner，再判断名字歧义。 */
export function matchDbCredentialTargets(
  assignments: Array<{ id: string; instanceId: string; instanceName: string; dbName: string; status: string }>,
  grants: Array<{ catalogId: string; instanceId: string; instanceName: string; dbName: string; state: string }>,
  ref: string,
): DbCredentialTarget[] {
  const targets = new Map<string, DbCredentialTarget>();
  for (const g of grants) {
    if (g.state === 'active') targets.set(JSON.stringify([g.instanceId, g.dbName]), { kind: 'personal', id: g.catalogId, instanceId: g.instanceId, instanceName: g.instanceName, dbName: g.dbName });
  }
  for (const a of assignments) {
    if (a.status === 'active') targets.set(JSON.stringify([a.instanceId, a.dbName]), { kind: 'owner', id: a.id, instanceId: a.instanceId, instanceName: a.instanceName, dbName: a.dbName });
  }
  return matchDbReferences([...targets.values()], ref);
}

/** 服务端既有 owner 解析与 CLI 分配+授权解析共用名字匹配边界。 */
function matchDbReferences<T extends { id: string; dbName: string; instanceName: string }>(rows: T[], ref: string): T[] {
  const needle = ref.trim();
  const byId = rows.filter(r => r.id === needle);
  if (byId.length) return byId;
  const at = needle.lastIndexOf('@');
  return at > 0
    ? rows.filter(r => r.dbName === needle.slice(0, at) && r.instanceName === needle.slice(at + 1))
    : rows.filter(r => r.dbName === needle);
}
