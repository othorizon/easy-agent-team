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

export const dbInstanceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.enum(['postgres', 'mysql']),
  host: z.string(),
  port: z.number(),
  adminUser: z.string(),
  note: z.string(),
  assignmentCount: z.number(),
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
  'active',
  'failed',
  'rejected',
  'disabled',
  'deleted',
]);
export type DbAssignmentStatus = z.infer<typeof dbAssignmentStatusSchema>;

export const dbAssignmentInfoSchema = z.object({
  id: z.string(),
  instanceName: z.string(),
  engine: z.enum(['postgres', 'mysql']),
  dbName: z.string(),
  dbUser: z.string(),
  purpose: z.string(),
  status: dbAssignmentStatusSchema,
  requesterId: z.string(),
  requesterName: z.string(),
  /** 凭证所在环境（active 后生成），用 eat env pull 获取 */
  environmentSlug: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type DbAssignmentInfo = z.infer<typeof dbAssignmentInfoSchema>;
