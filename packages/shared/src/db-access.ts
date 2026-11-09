import { z } from 'zod';

/** 目录的 schema 是 PostgreSQL 标识符；SQL 边界统一转义，不限制为小写。 */
export const dbAccessSchemasSchema = z.array(z.string().min(1).max(63).refine(s => !s.includes('\0'), 'schema 名不能含空字符')).min(1).max(50).transform(xs => [...new Set(xs)]);
export const pgAccessIdentifierSchema = z.string().min(1).max(63).refine(s => !s.includes('\0'), '名称不能含空字符');
export const registerExternalDbSchema = z.object({
  dbName: pgAccessIdentifierSchema, ownerId: z.uuid(), schemas: dbAccessSchemasSchema.default(['public']),
  creatorRole: pgAccessIdentifierSchema.nullable().optional(),
});
export type RegisterExternalDbRequest = z.infer<typeof registerExternalDbSchema>;
export const openDbAccessSchema = z.object({
  open: z.boolean(),
  schemas: dbAccessSchemasSchema.optional(),
  creatorRole: pgAccessIdentifierSchema.nullable().optional(),
});
export type OpenDbAccessRequest = z.infer<typeof openDbAccessSchema>;
export const dbAccessLevelSchema = z.enum(['read', 'write']);
export type DbAccessLevel = z.infer<typeof dbAccessLevelSchema>;
export const grantDbAccessSchema = z.object({ userId: z.uuid(), level: dbAccessLevelSchema });
export type GrantDbAccessRequest = z.infer<typeof grantDbAccessSchema>;
export const revokeDbAccessSchema = z.object({ reason: z.string().trim().max(2000).default('') });
export type RevokeDbAccessRequest = z.infer<typeof revokeDbAccessSchema>;
export const dbAccessStateSchema = z.enum(['pending', 'active', 'failed', 'revoking', 'revoked']);
const dbTablePrivilegeSchema = z.object({ schema: z.string(), table: z.string(), privileges: z.array(z.string()) });
export const dbPublicCheckSchema = z.object({
  checkedAt: z.string(), connect: z.boolean(), publicSchemaCreate: z.boolean(), tables: z.array(dbTablePrivilegeSchema),
  roles: z.array(z.object({ role: z.string(), inheritedFrom: z.array(z.string()), connect: z.boolean(), schemaCreate: z.array(z.string()), tables: z.array(dbTablePrivilegeSchema) })),
  tighteningSql: z.array(z.string()),
});
export type DbPublicCheck = z.infer<typeof dbPublicCheckSchema>;
export const dbAccessDriftSchema = z.object({
  checkedAt: z.string(), consistent: z.boolean(), error: z.string().nullable(),
  members: z.array(z.object({ role: z.string(), expected: z.array(z.string()), actual: z.array(z.string()), missing: z.array(z.string()), extra: z.array(z.string()) })),
});
export type DbAccessDrift = z.infer<typeof dbAccessDriftSchema>;
export const dbAccessDeletedSchema = z.object({ ok: z.literal(true) });
export const dbCatalogInfoSchema = z.object({
  id: z.string().nullable(), assignmentId: z.string().nullable(), instanceId: z.string(), instanceName: z.string(),
  dbName: z.string(), source: z.enum(['eat', 'external']), ownerId: z.string(), ownerName: z.string(),
  creatorRole: z.string().nullable(), publicCheck: dbPublicCheckSchema.nullable(),
  open: z.boolean(), schemas: z.array(z.string()), state: z.enum(['pending', 'active', 'failed']),
  error: z.string().nullable(), canManage: z.boolean(), drift: dbAccessDriftSchema.optional(),
});
export type DbCatalogInfo = z.infer<typeof dbCatalogInfoSchema>;
export const dbAccessGrantInfoSchema = z.object({
  id: z.string(), catalogId: z.string(), instanceId: z.string(), instanceName: z.string(), dbName: z.string(),
  userId: z.string(), userName: z.string(), level: dbAccessLevelSchema, state: dbAccessStateSchema,
  error: z.string().nullable(), canManage: z.boolean(), drift: dbAccessDriftSchema.optional(), updatedAt: z.string(),
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

export const requestDbAccessSchema = z.object({ level: dbAccessLevelSchema, reason: z.string().trim().min(1).max(2000) });
export type RequestDbAccess = z.infer<typeof requestDbAccessSchema>;
export const dbAccessRequestResultSchema = z.object({ requestId: z.uuid().nullable(), grant: dbAccessGrantInfoSchema.nullable() });
export type DbAccessRequestResult = z.infer<typeof dbAccessRequestResultSchema>;
