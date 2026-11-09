import { z } from 'zod';

/** 目录的 schema 是 PostgreSQL 标识符；SQL 边界统一转义，不限制为小写。 */
export const dbAccessSchemasSchema = z.array(z.string().min(1).max(63).refine(s => !s.includes('\0'), 'schema 名不能含空字符')).min(1).max(50).transform(xs => [...new Set(xs)]);
export const openDbAccessSchema = z.object({
  open: z.boolean(),
  schemas: dbAccessSchemasSchema.optional(),
});
export type OpenDbAccessRequest = z.infer<typeof openDbAccessSchema>;
export const dbAccessLevelSchema = z.enum(['read', 'write']);
export type DbAccessLevel = z.infer<typeof dbAccessLevelSchema>;
export const grantDbAccessSchema = z.object({ userId: z.uuid(), level: dbAccessLevelSchema });
export type GrantDbAccessRequest = z.infer<typeof grantDbAccessSchema>;
export const revokeDbAccessSchema = z.object({ reason: z.string().trim().max(2000).default('') });
export type RevokeDbAccessRequest = z.infer<typeof revokeDbAccessSchema>;
export const dbAccessStateSchema = z.enum(['pending', 'active', 'failed', 'revoking', 'revoked']);
export const dbCatalogInfoSchema = z.object({
  id: z.string().nullable(), assignmentId: z.string(), instanceId: z.string(), instanceName: z.string(),
  dbName: z.string(), source: z.literal('eat'), ownerId: z.string(), ownerName: z.string(),
  open: z.boolean(), schemas: z.array(z.string()), state: z.enum(['pending', 'active', 'failed']),
  error: z.string().nullable(), canManage: z.boolean(),
});
export type DbCatalogInfo = z.infer<typeof dbCatalogInfoSchema>;
export const dbAccessGrantInfoSchema = z.object({
  id: z.string(), catalogId: z.string(), instanceId: z.string(), instanceName: z.string(), dbName: z.string(),
  userId: z.string(), userName: z.string(), level: dbAccessLevelSchema, state: dbAccessStateSchema,
  error: z.string().nullable(), canManage: z.boolean(), updatedAt: z.string(),
});
export type DbAccessGrantInfo = z.infer<typeof dbAccessGrantInfoSchema>;
export const dbAccessCredentialsSchema = z.object({
  grantId: z.string(), instanceId: z.string(), engine: z.literal('postgres'), host: z.string(), port: z.number(),
  database: z.string(), user: z.string(), password: z.string(), url: z.string(),
});
export type DbAccessCredentials = z.infer<typeof dbAccessCredentialsSchema>;
export const dbCatalogListSchema = z.array(dbCatalogInfoSchema);
export const dbAccessGrantListSchema = z.array(dbAccessGrantInfoSchema);

export const dbAccessGrantQuerySchema = z.object({ scope: z.enum(['visible', 'mine']).default('visible') });
export type DbAccessGrantQuery = z.infer<typeof dbAccessGrantQuerySchema>;
/** 重置不返回密码；本人从凭证端点按需读取，pending表示已持久化并将恢复重试。 */
export const dbPersonalPasswordResetSchema = z.object({ instanceId: z.string(), state: z.enum(['complete', 'pending']), error: z.string().nullable() });
export type DbPersonalPasswordReset = z.infer<typeof dbPersonalPasswordResetSchema>;
