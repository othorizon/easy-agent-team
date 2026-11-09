import { z } from 'zod';

export const ossMigrationConflictSchema = z.object({
  code: z.enum([
    'account-unverified', 'operations-pending', 'old-user-missing',
    'old-user-provenance', 'target-user-occupied', 'target-identity-exists',
    'identity-provenance', 'policy-provenance', 'policy-capacity', 'cloud-read-failed',
  ]),
  message: z.string(),
});
export const ossMigrationIdentityPreviewSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  userStatus: z.enum(['active', 'disabled']),
  identityId: z.uuid().nullable(),
  cloudUserId: z.string().nullable(),
  targetCloudUserId: z.string().nullable(),
  oldRamName: z.string(),
  targetRamName: z.string(),
  cloudRamName: z.string().nullable(),
  renameRequired: z.boolean(),
  activeSpaces: z.array(z.object({
    id: z.uuid(), name: z.string(), prefix: z.string(),
    status: z.enum(['active', 'provisioning', 'failed']),
    actions: z.array(z.string()),
  })),
  keys: z.array(z.object({ id: z.string(), status: z.string(), managed: z.boolean() })),
  securityActions: z.array(z.enum(['disable-all-keys', 'delete-login-profile'])),
  boundPolicies: z.array(z.object({ name: z.string(), type: z.enum(['Custom', 'System']) })),
  aggregation: z.object({
    policyName: z.string(),
    action: z.enum(['reapply', 'detach']),
    currentAttached: z.boolean(),
    currentPolicyDocument: z.string().nullable(),
    proposedPolicyDocument: z.string().nullable(),
  }),
  pendingOperationIds: z.array(z.uuid()),
  warnings: z.array(z.string()),
  conflicts: z.array(ossMigrationConflictSchema),
});
export const ossMigrationPreviewSchema = z.object({
  readOnly: z.literal(true),
  generatedAt: z.iso.datetime(),
  accountId: z.string().nullable(),
  instanceId: z.uuid(),
  bucket: z.string(),
  canMigrate: z.boolean(),
  conflicts: z.array(ossMigrationConflictSchema),
  identities: z.array(ossMigrationIdentityPreviewSchema),
});
export type OssMigrationConflict = z.infer<typeof ossMigrationConflictSchema>;
export type OssMigrationIdentityPreview = z.infer<typeof ossMigrationIdentityPreviewSchema>;
export type OssMigrationPreview = z.infer<typeof ossMigrationPreviewSchema>;

export const executeOssMigrationSchema = z.object({ confirm: z.literal(true) });
export type ExecuteOssMigration = z.infer<typeof executeOssMigrationSchema>;
export const ossMigrationStatusSchema = z.object({
  state: z.enum(['pending', 'running', 'partial', 'complete']),
  results: z.array(z.object({
    userId: z.uuid(), name: z.string(), email: z.string(), accountId: z.string(), identityId: z.uuid(),
    oldRamName: z.string(), targetRamName: z.string(), cloudUserId: z.string().nullable(),
    stage: z.enum(['preflight', 'verified', 'secured', 'renamed', 'identity', 'linked', 'policy', 'complete']),
    state: z.enum(['running', 'failed', 'complete']), error: z.string().nullable(), attempts: z.number().int(), updatedAt: z.iso.datetime(),
  })),
});
export type OssMigrationStatus = z.infer<typeof ossMigrationStatusSchema>;
