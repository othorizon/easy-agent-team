import { z } from 'zod';

export const aliyunConnectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, '接入名称只允许小写字母、数字和连字符');
const connectionFields = {
  name: aliyunConnectionNameSchema,
  defaultRegion: z.string().trim().max(100).default(''),
};
export const createAliyunConnectionSchema = z.object({
  ...connectionFields,
  accessKeyId: z.string().trim().min(1).max(256),
  accessKeySecret: z.string().trim().min(1).max(256),
});
export const updateAliyunConnectionSchema = z
  .object({
    ...connectionFields,
    accessKeyId: z.string().trim().max(256).default(''),
    accessKeySecret: z.string().trim().max(256).default(''),
  })
  .refine((v) => !!v.accessKeyId === !!v.accessKeySecret, {
    message: '更换管理凭证时需同时填写 AccessKey ID 和 Secret',
    path: ['accessKeySecret'],
  });
export const aliyunCleanupStateSchema = z.enum(['pending', 'running', 'failed']).nullable();
export const aliyunCleanupStageSchema = z.enum(['verify', 'keys', 'bindings', 'users', 'local']).nullable();
export const deleteAliyunConnectionSchema = z.object({ confirmName: aliyunConnectionNameSchema });
export const aliyunConnectionInfoSchema = z.object({
  id: z.string().uuid(),
  name: aliyunConnectionNameSchema,
  accountId: z.string(),
  defaultRegion: z.string(),
  status: z.enum(['enabled', 'paused']),
  cleanupState: aliyunCleanupStateSchema, cleanupStage: aliyunCleanupStageSchema, cleanupError: z.string().nullable(),
  accessKeyIdMasked: z.literal('********'),
  accessKeySecretMasked: z.literal('********'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const aliyunConnectionsSchema = z.array(aliyunConnectionInfoSchema);
export const aliyunAvailabilitySchema = z.object({ available: z.boolean() });
export const aliyunConnectionStatusSchema = z.object({
  status: z.enum(['enabled', 'paused']),
});
export const aliyunConnectionValidationSchema = z.object({
  accountId: z.string(),
});
export const aliyunDeleteResultSchema = z.object({ ok: z.boolean(), cleanupState: aliyunCleanupStateSchema.optional(), cleanupStage: aliyunCleanupStageSchema.optional(), cleanupError: z.string().nullable().optional() });
export type AliyunDeleteResult = z.infer<typeof aliyunDeleteResultSchema>;
export type CreateAliyunConnectionRequest = z.infer<
  typeof createAliyunConnectionSchema
>;
export type UpdateAliyunConnectionRequest = z.infer<
  typeof updateAliyunConnectionSchema
>;
export type AliyunConnectionInfo = z.infer<typeof aliyunConnectionInfoSchema>;
export type AliyunAvailability = z.infer<typeof aliyunAvailabilitySchema>;

export const aliyunPermissionInfoSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  policyName: z.string(),
  description: z.string(),
  cloudExists: z.boolean(),
  open: z.boolean(),
  purpose: z.string(),
  dataScope: z.string(),
  ownerId: z.string().uuid().nullable(),
  discoveredAt: z.string(),
  updatedAt: z.string(),
});
export const aliyunPermissionsSchema = z.array(aliyunPermissionInfoSchema);
export type AliyunPermissionInfo = z.infer<typeof aliyunPermissionInfoSchema>;

export const grantAliyunPermissionSchema = z.object({ userId: z.string().uuid() });
export const revokeAliyunGrantSchema = z.object({ reason: z.string().trim().max(2000).default('') });
export const aliyunGrantStateSchema = z.enum(['pending', 'active', 'failed', 'revoking', 'revoked']);
export const aliyunGrantSourceSchema = z.enum(['direct', 'approval', 'self']);
export const aliyunGrantInfoSchema = z.object({
  id: z.string().uuid(), permissionId: z.string().uuid(), connectionId: z.string().uuid(),
  connectionName: z.string(), accountId: z.string(), policyName: z.string(),
  userId: z.string().uuid(), userName: z.string(), identityId: z.string().uuid().nullable(),
  state: aliyunGrantStateSchema, error: z.string().nullable(), source: aliyunGrantSourceSchema,
  grantedBy: z.string().uuid(), revokedBy: z.string().uuid().nullable(), revocationReason: z.string().nullable(),
  relinquished: z.boolean(), canManage: z.boolean(), cloudExists: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export const aliyunIdentityAccountInfoSchema = z.object({
  accountId: z.string(), connectionId: z.string().uuid(), connectionName: z.string(),
  connectionStatus: z.enum(['enabled', 'paused']), identityId: z.string().uuid(), ramName: z.string(),
  customPolicyCount: z.number().int().nonnegative().nullable(), error: z.string().nullable(),
});
export const aliyunDriftSnapshotSchema = z.object({ missing: z.array(z.string()), extra: z.array(z.string()), checkedAt: z.string().datetime(), error: z.string().nullable(), repairError: z.string().nullable().optional() });
export type AliyunDriftSnapshot = z.infer<typeof aliyunDriftSnapshotSchema>;
export const aliyunIdentityDriftSchema = aliyunDriftSnapshotSchema.extend({ identityId: z.string().uuid(), userId: z.string().uuid(), userName: z.string(), connectionId: z.string().uuid(), connectionName: z.string(), ramName: z.string(), canRepair: z.boolean() });
export type AliyunIdentityDrift = z.infer<typeof aliyunIdentityDriftSchema>;
export const aliyunRepairResultSchema = z.object({ ok: z.boolean(), drift: aliyunIdentityDriftSchema });
export const aliyunGrantsResultSchema = z.object({
  grants: z.array(aliyunGrantInfoSchema), accounts: z.array(aliyunIdentityAccountInfoSchema), drift: z.array(aliyunIdentityDriftSchema).optional(),
});
export type GrantAliyunPermissionRequest = z.infer<typeof grantAliyunPermissionSchema>;
export type RevokeAliyunGrantRequest = z.infer<typeof revokeAliyunGrantSchema>;
export type AliyunGrantInfo = z.infer<typeof aliyunGrantInfoSchema>;
export type AliyunGrantSource = z.infer<typeof aliyunGrantSourceSchema>;
export type AliyunGrantsResult = z.infer<typeof aliyunGrantsResultSchema>;

export const ALIYUN_CREDENTIAL_NOTE = '个人凭证只供本人临时使用，不要配进线上服务。';
export const aliyunCredentialsSchema = z.object({
  connectionId: z.string().uuid(), connectionName: z.string(), accountId: z.string(), defaultRegion: z.string(),
  identityId: z.string().uuid(), accessKeyId: z.string(), accessKeySecret: z.string(),
  generation: z.number().int().nonnegative(), readyAt: z.string().datetime(),
});
export type AliyunCredentials = z.infer<typeof aliyunCredentialsSchema>;
/** Resolve only accounts with an effective personal authorization; callers must reject 0/multiple hits. */
export function matchAliyunAccounts(grants: AliyunGrantInfo[], ref?: string) {
  const accounts = [...new Map(grants.filter(g => g.state === 'active').map(g => [g.accountId, {
    accountId: g.accountId, connectionId: g.connectionId, connectionName: g.connectionName,
  }])).values()];
  return ref === undefined ? accounts : accounts.filter(a => a.accountId === ref.trim() || a.connectionName === ref.trim());
}

export const configureAliyunPermissionSchema = z.object({
  open: z.boolean(),
  purpose: z.string().trim().max(2000),
  dataScope: z.string().trim().max(2000),
  ownerId: z.string().uuid().nullable(),
});
export const configuredAliyunPermissionSchema = configureAliyunPermissionSchema.extend({ id: z.string().uuid() });
export type ConfiguredAliyunPermission = z.infer<typeof configuredAliyunPermissionSchema>;
export const requestAliyunPermissionSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export const aliyunCatalogPermissionSchema = aliyunPermissionInfoSchema.extend({
  connectionName: z.string(), accountId: z.string(), connectionStatus: z.enum(['enabled', 'paused']),
  ownerName: z.string().nullable(), ownerStatus: z.enum(['active', 'disabled']).nullable(),
  canManage: z.boolean(), held: z.boolean(), pendingRequestId: z.string().uuid().nullable(),
});
export const aliyunCatalogSchema = z.array(aliyunCatalogPermissionSchema);
export const aliyunPermissionDocumentSchema = z.object({ policyName: z.string(), document: z.string(), fetchedAt: z.string() });
export const aliyunPermissionRequestResultSchema = z.object({ requestId: z.string().uuid().nullable(), grant: aliyunGrantInfoSchema.nullable() });
export type ConfigureAliyunPermission = z.infer<typeof configureAliyunPermissionSchema>;
export type RequestAliyunPermission = z.infer<typeof requestAliyunPermissionSchema>;
export type AliyunCatalogPermission = z.infer<typeof aliyunCatalogPermissionSchema>;
export type AliyunPermissionDocument = z.infer<typeof aliyunPermissionDocumentSchema>;
export type AliyunPermissionRequestResult = z.infer<typeof aliyunPermissionRequestResultSchema>;

/** Resolve a policy with an optional connection name or cloud account ID, before any mutation. */
export function matchAliyunPermissions<T extends Pick<AliyunCatalogPermission, 'id' | 'policyName' | 'connectionName' | 'accountId'>>(permissions: T[], name: string, account?: string): T[] {
  const at = name.lastIndexOf('@');
  const policy = at < 0 ? name : name.slice(0, at);
  const selector = account ?? (at < 0 ? undefined : name.slice(at + 1));
  return permissions.filter(p => (p.id === policy || p.policyName === policy) && (!selector || p.connectionName === selector || p.accountId === selector));
}
