import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { AliyunCredentials } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { CloudIdentitiesService } from '../cloud-identities/cloud-identities.service';
import { DB, type Db } from '../db/db.module';
import { aliyunConnections, aliyunGrants, aliyunPermissions, cloudIdentities, users } from '../db/schema';
import { AliyunService } from './aliyun.service';

/** Aliyun authorization checks stay here; the shared identity/key layer also serves OSS independently. */
@Injectable()
export class AliyunCredentialsService {
  private readonly logger = new Logger(AliyunCredentialsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private stopped = false;
  constructor(@Inject(DB) private readonly db: Db, private readonly aliyun: AliyunService,
    private readonly identities: CloudIdentitiesService, private readonly audit: AuditService) {}
  onModuleInit() { this.timer = setInterval(() => this.wake(), 30_000); this.timer.unref(); this.wake(); }
  private wake() {
    if (this.stopped || this.recovery) return;
    this.recovery = this.tick().catch(() => this.logger.warn('个人 Key 待恢复，请检查接入配置')).finally(() => { this.recovery = undefined; });
  }
  async onModuleDestroy() { this.stopped = true; clearInterval(this.timer); await this.recovery; }
  private async authorized(userId: string, connectionId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status !== 'active') throw new ForbiddenException('停用的 EAT 用户不能读取个人凭证');
    const [grant] = await this.db.select({ id: aliyunGrants.id }).from(aliyunGrants)
      .innerJoin(aliyunPermissions, eq(aliyunPermissions.id, aliyunGrants.permissionId))
      .where(and(eq(aliyunGrants.userId, userId), eq(aliyunGrants.state, 'active'), eq(aliyunPermissions.connectionId, connectionId), eq(aliyunPermissions.cloudExists, true))).limit(1);
    if (!grant) throw new ForbiddenException('没有此云账号的有效授权，请在阿里云权限目录向 Owner 申请');
  }
  async credentials(actor: AuthUser, connectionId: string, reset = false): Promise<AliyunCredentials> {
    await this.authorized(actor.id, connectionId);
    const initial = await this.aliyun.connection(connectionId);
    return this.identities.run(initial.accountId, actor.id, this.aliyun.credentials(initial), async session => {
      await this.authorized(actor.id, connectionId);
      const c = await this.aliyun.connection(connectionId);
      this.aliyun.assertWritable(c);
      if (reset && c.status === 'paused') throw new ConflictException('接入已暂停，不能重置个人 Key');
      const key = await session.key({ reset, allowCreate: c.status !== 'paused' });
      if (!key) throw new ConflictException('接入已暂停，不能领取新 Key；已有 Key 照常可读');
      session.guard();
      await this.audit.record({ actorId: actor.id, actorTokenId: actor.tokenId,
        action: reset ? 'aliyun_credentials.reset' : 'aliyun_credentials.read', targetType: 'cloud_identity', targetId: key.identityId,
        meta: { accountId: c.accountId, generation: key.generation } });
      return { ...key, connectionId: c.id, connectionName: c.name, accountId: c.accountId, defaultRegion: c.defaultRegion };
    });
  }
  /** Resume interrupted creates and retirement with the original durable generation/deadline. */
  async tick() {
    const rows = await this.db.select({ identity: cloudIdentities, c: aliyunConnections }).from(cloudIdentities)
      .innerJoin(aliyunConnections, eq(aliyunConnections.accountId, cloudIdentities.accountId))
      .where(or(isNotNull(cloudIdentities.keyBaseline), isNotNull(cloudIdentities.keyTargetGeneration), sql`jsonb_array_length(${cloudIdentities.retiringKeyIds}) > 0`));
    for (const { identity, c } of rows) {
      if (this.stopped) return;
      try {
        await this.identities.run(c.accountId, identity.userId, this.aliyun.credentials(c), async session => {
          const [user] = await this.db.select().from(users).where(eq(users.id, identity.userId));
          if (user?.status !== 'active') return; // Status recovery owns disabled identities; preserve interrupted key generations until restored.
          const [grant] = await this.db.select({ id: aliyunGrants.id }).from(aliyunGrants)
            .innerJoin(aliyunPermissions, eq(aliyunPermissions.id, aliyunGrants.permissionId))
            .where(and(eq(aliyunGrants.userId, identity.userId), eq(aliyunGrants.state, 'active'), eq(aliyunPermissions.connectionId, c.id), eq(aliyunPermissions.cloudExists, true))).limit(1);
          const current = await this.aliyun.connection(c.id);
          if (current.cleanupState || identity.cleanupPending) return;
          await session.key({ resume: true, allowCreate: current.status === 'enabled' && user?.status === 'active' && !!grant });
        });
      } catch { this.logger.warn(`个人 Key 待恢复（${identity.id}）`); }
    }
  }
}
