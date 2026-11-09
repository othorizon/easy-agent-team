import { Injectable } from '@nestjs/common';
import { asc, eq, ne } from 'drizzle-orm';
import {
  ossMigrationPreviewSchema,
  type OssMigrationConflict,
  type OssMigrationIdentityPreview,
  type OssMigrationPreview,
} from '@eat/shared';
import { cloudIdentities, ossAccounts, ossMigrationResults, ossOperations, ossSpaces, users } from '../db/schema';
import { decryptSecret } from '../common/crypto';
import { cloudIdentityMarker } from '../cloud-identities/cloud-identities.service';
import { RamCloud, ramMissing, type RamCredentials, type RamUser } from '../ram/ram-cloud';
import { OssStore } from './oss-store';
import { ossError, ossMarker } from './oss-provisioner';
import { userPolicy } from './oss-policy';

/** Pure preflight shared by the admin report and migration executor. Never ensures or refreshes identities. */
@Injectable()
export class OssMigrationPreviewService {
  constructor(private readonly store: OssStore, private readonly ram: RamCloud) {}

  private async user(credentials: RamCredentials, name: string) {
    try { return await this.ram.getUser(credentials, name); }
    catch (e) { if (ramMissing(e)) return null; throw e; }
  }

  async preview(userId?: string): Promise<OssMigrationPreview> {
    const setting = await this.store.row();
    const credentials = this.store.connection(setting);
    // Start with ALL OSS identities, including people with no remaining spaces.
    const [accounts, spaces, identities, operations, journals] = await Promise.all([
      this.store.db.select({ account: ossAccounts, user: users }).from(ossAccounts)
        .innerJoin(users, eq(users.id, ossAccounts.userId)).where(userId ? eq(ossAccounts.userId, userId) : undefined).orderBy(asc(ossAccounts.userId)),
      this.store.db.select().from(ossSpaces).orderBy(asc(ossSpaces.prefix)),
      setting.accountId ? this.store.db.select().from(cloudIdentities).where(eq(cloudIdentities.accountId, setting.accountId)) : [],
      this.store.db.select().from(ossOperations).where(ne(ossOperations.state, 'complete')),
      this.store.db.select().from(ossMigrationResults),
    ]);
    const conflicts: OssMigrationConflict[] = [];
    if (!setting.accountId) conflicts.push({ code: 'account-unverified', message: 'OSS 云账号尚未验证，请管理员先完成原有接入检查。' });
    if (setting.status === 'checking' || operations.some(op => !op.userId))
      conflicts.push({ code: 'operations-pending', message: 'OSS 仍有启用检查或全局操作未完成，请处理后重新预演。' });
    const rows: OssMigrationIdentityPreview[] = [];
    for (const { account, user } of accounts) {
      const journal = journals.find(j => j.userId === user.id);
      const identity = identities.find(i => i.userId === user.id);
      const targetRamName = `eat-${user.id.replaceAll('-', '')}`;
      const marker = ossMarker(setting.instanceId, user.id);
      const activeSpaces = spaces.filter(s => s.ownerId === user.id && ['active', 'provisioning', 'failed'].includes(s.status));
      const pendingOperationIds = operations.filter(op => op.userId === user.id).map(op => op.id);
      const row: OssMigrationIdentityPreview = {
        userId: user.id, name: user.name, email: user.email, userStatus: user.status,
        identityId: identity?.id ?? null, cloudUserId: null, targetCloudUserId: null,
        oldRamName: account.ramName, targetRamName, cloudRamName: null, renameRequired: account.ramName !== targetRamName,
        activeSpaces: activeSpaces.map(s => ({
          id: s.id, name: s.name, prefix: s.prefix, status: s.status as 'active' | 'provisioning' | 'failed',
          actions: [...new Set(userPolicy(setting.bucket, [s.prefix]).Statement.flatMap(statement => [statement.Action].flat()))],
        })),
        keys: [], securityActions: user.status === 'disabled' ? ['disable-all-keys', 'delete-login-profile'] : [],
        boundPolicies: [], pendingOperationIds, warnings: [], conflicts: [],
        aggregation: { policyName: account.policyName, action: activeSpaces.length ? 'reapply' : 'detach', currentAttached: false, currentPolicyDocument: null, proposedPolicyDocument: null },
      };
      if (pendingOperationIds.length) row.conflicts.push({ code: 'operations-pending', message: '此人的 OSS 操作尚未完成，请恢复完成后重新预演。' });
      // Ignore userEnabled: disabled people may still own valid spaces behind the legacy Deny.
      if (activeSpaces.length) {
        try { row.aggregation.proposedPolicyDocument = JSON.stringify(userPolicy(setting.bucket, activeSpaces.map(s => s.prefix))); }
        catch (e) { row.conflicts.push({ code: 'policy-capacity', message: ossError(e) }); }
      }
      if (!setting.accountId) { rows.push(row); continue; }
      try {
        const old = await this.user(credentials, account.ramName);
        const target = account.ramName === targetRamName ? old : await this.user(credentials, targetRamName);
        row.targetCloudUserId = target?.id ?? null;
        const owned = (cloud: RamUser) => {
          const cloudIdMatches = !identity?.cloudUserId || identity.cloudUserId === cloud.id;
          return cloudIdMatches && (cloud.comments === marker || !!identity && cloud.comments.startsWith(cloudIdentityMarker(identity.id)) || !!journal && journal.cloudUserId === cloud.id && cloud.comments.startsWith(cloudIdentityMarker(journal.identityId)));
        };
        if (old && !owned(old)) row.conflicts.push({ code: 'old-user-provenance', message: '旧 RAM 用户的来源标记或已保存的云端 UserId 不符，拒绝接管，请管理员处理。' });
        if (identity && (
          identity.ramName !== account.ramName && identity.ramName !== targetRamName ||
          identity.cloudUserId && identity.cloudUserId !== (old ?? target)?.id ||
          !old && target && !target.comments.startsWith(cloudIdentityMarker(identity.id)) && target.comments !== marker
        )) row.conflicts.push({ code: 'identity-provenance', message: '统一个人身份的云端 UserId 或来源标记不符，请管理员处理。' });
        let source = old;
        if (target && target.id !== old?.id) {
          if (!owned(target)) row.conflicts.push({ code: 'target-user-occupied', message: '目标用户名已被来源不符的 RAM 用户占用；仅有 eat- 名称或 EAT: 前缀不能确认归属，需管理员处理。' });
          else if (old) row.conflicts.push({ code: 'target-identity-exists', message: '目标已属于另一个 RAM 个人身份，无法在保留旧 Key 的同时合并，请管理员处理。' });
          else source = target;
        }
        if (!source) row.conflicts.push({ code: 'old-user-missing', message: '旧 RAM 用户不存在，也未找到可验证归属的已改名身份；不会自动重建。' });
        if (source) {
          row.cloudUserId = source.id;
          row.cloudRamName = source.name;
          row.renameRequired = source.name !== targetRamName;
          const policies = await this.ram.userPolicies(credentials, source.name);
          row.boundPolicies = policies.map(p => ({ name: p.name, type: p.type }));
          row.aggregation.currentAttached = policies.some(p => p.name === account.policyName && p.type === 'Custom');
          const managedKeyId = account.keyIdEncrypted ? decryptSecret(account.keyIdEncrypted) : null;
          row.keys = (await this.ram.keys(credentials, source.name)).map(k => ({ ...k, managed: k.id === managedKeyId }));
          if (user.status === 'disabled' && row.keys.some(k => k.status !== 'Inactive'))
            row.warnings.push('停用用户仍有 Active 或未知状态的 Key；执行时必须先停用全部 Key 并删除控制台登录配置，再调整聚合策略。');
        }
        try {
          const policy = await this.ram.getPolicy(credentials, account.policyName);
          row.aggregation.currentPolicyDocument = policy.document;
          if (policy.description !== marker) row.conflicts.push({ code: 'policy-provenance', message: 'OSS 聚合策略来源标记不符，拒绝覆盖或解绑，请管理员处理。' });
        } catch (e) { if (!ramMissing(e)) throw e; }
      } catch (e) {
        row.conflicts.push({ code: 'cloud-read-failed', message: ossError(e) });
      }
      rows.push(row);
    }
    return ossMigrationPreviewSchema.parse({
      readOnly: true, generatedAt: new Date().toISOString(), instanceId: setting.instanceId,
      accountId: setting.accountId, bucket: setting.bucket, conflicts, identities: rows,
      canMigrate: !conflicts.length && rows.every(row => !row.conflicts.length),
    });
  }
}
