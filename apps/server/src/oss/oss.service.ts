import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  OssCapability,
  OssCredentialInfo,
  OssSpaceInfo,
  RequestOssSpace,
  UpdateOssSpace,
} from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { decryptSecret } from '../common/crypto';
import {
  ossAccounts,
  ossOperations,
  ossSettings,
  ossSpaces,
  users,
} from '../db/schema';
import {
  OssStore,
  maskOssKey,
  type OssOperationRow,
  type OssSpaceRow,
} from './oss-store';
import { OssProvisioner, ossError } from './oss-provisioner';
import { spacePrefix, userPolicy } from './oss-policy';

@Injectable()
export class OssService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OssService.name);
  private timer?: ReturnType<typeof setInterval>;
  private job?: Promise<void>;
  private stopped = false;
  constructor(
    readonly store: OssStore,
    private readonly provisioner: OssProvisioner,
    private readonly audit: AuditService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref();
    this.wake();
  }
  async onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.job;
  }
  wake() {
    if (!this.stopped && !this.job)
      this.job = this.tick()
        .catch((e) => {
          if (!(e instanceof ConflictException))
            this.logger.warn('OSS 后台任务未完成，将重试');
        })
        .finally(() => {
          this.job = undefined;
        });
  }
  private admin(user: AuthUser) {
    if (user.role !== 'admin')
      throw new ForbiddenException('仅管理员可执行此操作');
  }
  private async actorActive(user: AuthUser) {
    const [u] = await this.store.db
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    if (!u || u.status !== 'active') throw new ForbiddenException('用户已停用');
  }
  async capability(): Promise<OssCapability> {
    const info = await this.store.info();
    return {
      enabled: info.status === 'enabled',
      status: info.status,
      bucket: info.configured ? info.bucket : null,
    };
  }
  private async rawSpace(id: string) {
    const [s] = await this.store.db
      .select()
      .from(ossSpaces)
      .where(eq(ossSpaces.id, id));
    if (!s) throw new NotFoundException('OSS 空间不存在');
    return s;
  }
  private canRead(user: AuthUser, s: OssSpaceRow) {
    if (s.ownerId !== user.id && user.role !== 'admin')
      throw new ForbiddenException('仅所有者或管理员可以访问空间');
  }
  private async infos(rows: OssSpaceRow[]): Promise<OssSpaceInfo[]> {
    if (!rows.length) return [];
    const r = await this.store.row();
    const people = await this.store.db
      .select({ id: users.id, name: users.name, status: users.status })
      .from(users)
      .where(
        inArray(users.id, [
          ...new Set(
            rows.flatMap((s) => [
              s.ownerId,
              ...(s.decidedBy ? [s.decidedBy] : []),
            ]),
          ),
        ]),
      );
    const accounts = await this.store.db
      .select()
      .from(ossAccounts)
      .where(
        inArray(
          ossAccounts.userId,
          rows.map((s) => s.ownerId),
        ),
      );
    const names = new Map(people.map((u) => [u.id, u.name]));
    const official = `${r.bucket}.oss-${r.region}.aliyuncs.com`;
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      purpose: s.purpose,
      ownerId: s.ownerId,
      ownerName: names.get(s.ownerId) ?? '',
      status: s.status,
      prefix: s.prefix,
      bucket: r.bucket,
      region: r.region,
      endpoint: `https://oss-${r.region}.aliyuncs.com`,
      addresses: [
        {
          domain: official,
          url: `https://${official}/${s.prefix}`,
          kind: 'official',
          cdn: false,
          source: 'oss',
        },
        ...(r.customDomainsEnabled
          ? r.domains.map((d) => ({
              domain: d.domain,
              url: `https://${d.domain}/${s.prefix}`,
              kind: 'custom' as const,
              cdn: d.cdn,
              source: 'admin' as const,
            }))
          : []),
      ],
      publicRead: s.publicRead,
      requestedPublicRead: s.requestedPublicRead,
      publicPrefixes: s.publicRead ? [s.prefix] : [],
      credentialSyncPending: accounts.some(
        (a) =>
          a.userId === s.ownerId &&
          (a.syncPending ||
            a.userEnabled !==
              (people.find((p) => p.id === s.ownerId)?.status === 'active')),
      ),
      credentialSyncError:
        accounts.find((a) => a.userId === s.ownerId)?.lastError ?? null,
      operationPending: s.operationPending,
      lastError: s.lastError,
      rejectionReason: s.rejectionReason,
      decidedByName: s.decidedBy ? (names.get(s.decidedBy) ?? null) : null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));
  }
  async list(user: AuthUser, all = false) {
    if (all) this.admin(user);
    const rows = await this.store.db
      .select()
      .from(ossSpaces)
      .where(all ? undefined : eq(ossSpaces.ownerId, user.id))
      .orderBy(desc(ossSpaces.createdAt));
    return this.infos(rows);
  }
  async get(user: AuthUser, id: string) {
    const s = await this.rawSpace(id);
    this.canRead(user, s);
    return (await this.infos([s]))[0];
  }
  async request(user: AuthUser, dto: RequestOssSpace) {
    return this.store.exclusive(async () => {
      await this.actorActive(user);
      const r = await this.store.enabled();
      const [existing] = await this.store.db
        .select()
        .from(ossSpaces)
        .where(
          and(
            eq(ossSpaces.ownerId, user.id),
            eq(ossSpaces.requestId, dto.requestId),
          ),
        );
      if (existing) {
        if (existing.name !== dto.name || existing.purpose !== dto.purpose)
          throw new ConflictException('同一 requestId 不能用于不同申请');
        return this.get(user, existing.id);
      }
      const id = randomUUID();
      await this.store.db.insert(ossSpaces).values({
        id,
        ownerId: user.id,
        requestId: dto.requestId,
        name: dto.name,
        purpose: dto.purpose,
        prefix: spacePrefix(r.instanceId, user.id, id),
      });
      await this.audit.record({
        actorId: user.id,
        action: 'oss_space.requested',
        targetType: 'oss_space',
        targetId: id,
      });
      return this.get(user, id);
    });
  }
  async update(user: AuthUser, id: string, dto: UpdateOssSpace) {
    return this.store.exclusive(async () => {
      await this.store.enabled();
      await this.actorActive(user);
      const s = await this.rawSpace(id);
      this.canRead(user, s);
      if (['revoking', 'revoked', 'rejected'].includes(s.status))
        throw new ConflictException('该状态下不能修改空间');
      await this.store.db
        .update(ossSpaces)
        .set({ ...dto, updatedAt: new Date() })
        .where(eq(ossSpaces.id, id));
      await this.audit.record({
        actorId: user.id,
        action: 'oss_space.updated',
        targetType: 'oss_space',
        targetId: id,
      });
      return this.get(user, id);
    });
  }
  async decide(
    user: AuthUser,
    id: string,
    action: 'approve' | 'reject' | 'revoke' | 'retry',
    reason?: string,
  ) {
    this.admin(user);
    const result = await this.store.exclusive(async () => {
      await this.actorActive(user);
      const s = await this.rawSpace(id);
      if (action === 'retry') {
        const [op] = await this.store.db
          .select()
          .from(ossOperations)
          .where(
            and(
              eq(ossOperations.spaceId, id),
              eq(ossOperations.state, 'failed'),
            ),
          )
          .orderBy(desc(ossOperations.createdAt))
          .limit(1);
        if (!op) throw new ConflictException('没有可重试的失败任务');
        if (op.kind !== 'revoke') await this.store.enabled();
        await this.store.updateOperation(op.id, {
          state: 'pending',
          retryAt: null,
        });
        await this.store.db
          .update(ossSpaces)
          .set({ operationPending: true, lastError: null })
          .where(eq(ossSpaces.id, id));
      } else {
        if (s.operationPending)
          throw new ConflictException('空间已有未完成操作，请先重试');
        if (action === 'approve' || action === 'reject') {
          await this.store.enabled();
          if (s.status !== 'pending')
            throw new ConflictException('只能处理待审批申请');
        }
        if (action === 'approve') {
          const [owner] = await this.store.db
            .select()
            .from(users)
            .where(eq(users.id, s.ownerId));
          if (owner.status !== 'active')
            throw new ConflictException('申请人已停用');
          const others = await this.store.db
            .select()
            .from(ossSpaces)
            .where(
              and(
                eq(ossSpaces.ownerId, s.ownerId),
                inArray(ossSpaces.status, ['active', 'provisioning', 'failed']),
              ),
            );
          userPolicy((await this.store.row()).bucket, [
            ...others.map((v) => v.prefix),
            s.prefix,
          ]);
        }
        if (action === 'revoke' && s.status !== 'active')
          throw new ConflictException('只能回收可用空间');
        await this.store.db.transaction(async (tx) => {
          await tx
            .update(ossSpaces)
            .set({
              status:
                action === 'approve'
                  ? 'provisioning'
                  : action === 'reject'
                    ? 'rejected'
                    : 'revoking',
              decidedBy: user.id,
              rejectionReason: reason ?? null,
              operationPending: action !== 'reject',
              lastError: null,
              ...(action === 'revoke' ? { requestedPublicRead: false } : {}),
              updatedAt: new Date(),
            })
            .where(eq(ossSpaces.id, id));
          if (action !== 'reject')
            await tx.insert(ossOperations).values({
              kind: action,
              actorId: user.id,
              userId: s.ownerId,
              spaceId: id,
            });
        });
      }
      await this.audit.record({
        actorId: user.id,
        action: `oss_space.${action}`,
        targetType: 'oss_space',
        targetId: id,
      });
      return this.get(user, id);
    });
    this.wake();
    return result;
  }
  async publicRead(user: AuthUser, id: string, enabled: boolean) {
    const result = await this.store.exclusive(async () => {
      await this.store.enabled();
      await this.actorActive(user);
      const s = await this.rawSpace(id);
      this.canRead(user, s);
      if (s.status !== 'active' || s.operationPending)
        throw new ConflictException('空间尚不可用或已有未完成操作');
      if (s.publicRead === enabled) return this.get(user, id);
      await this.store.db.transaction(async (tx) => {
        await tx
          .update(ossSpaces)
          .set({
            requestedPublicRead: enabled,
            operationPending: true,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(ossSpaces.id, id));
        await tx.insert(ossOperations).values({
          kind: 'public',
          actorId: user.id,
          userId: s.ownerId,
          spaceId: id,
        });
      });
      await this.audit.record({
        actorId: user.id,
        action: 'oss_space.public_read',
        targetType: 'oss_space',
        targetId: id,
        meta: { enabled },
      });
      return this.get(user, id);
    });
    this.wake();
    return result;
  }
  private async pendingReset(userId: string) {
    return (
      (
        await this.store.db
          .select({ id: ossOperations.id })
          .from(ossOperations)
          .where(
            and(
              eq(ossOperations.userId, userId),
              eq(ossOperations.kind, 'reset'),
              ne(ossOperations.state, 'complete'),
            ),
          )
          .limit(1)
      ).length > 0
    );
  }
  async accountInfo(user: AuthUser) {
    const a = await this.store.account(user.id);
    return {
      configured: !!a?.keyIdEncrypted,
      accessKeyIdMasked: a?.keyIdEncrypted
        ? maskOssKey(decryptSecret(a.keyIdEncrypted))
        : '',
      syncPending: !!a?.syncPending || (await this.pendingReset(user.id)),
      lastError: a?.lastError ?? null,
    };
  }
  async credentials(user: AuthUser): Promise<OssCredentialInfo> {
    return this.store.exclusive(async () => {
      await this.actorActive(user);
      const r = await this.store.enabled();
      const a = await this.store.account(user.id);
      if (
        (await this.pendingReset(user.id)) ||
        !a?.keyIdEncrypted ||
        !a.keySecretEncrypted ||
        a.syncPending ||
        !a.userEnabled ||
        a.keyBaseline ||
        a.retiringKeyIds.length
      )
        throw new ConflictException('凭证尚未就绪或正在同步，请稍后重试');
      const spaces = await this.store.db
        .select()
        .from(ossSpaces)
        .where(
          and(eq(ossSpaces.ownerId, user.id), eq(ossSpaces.status, 'active')),
        );
      if (!spaces.length) throw new ConflictException('尚无已批准空间');
      await this.audit.record({
        actorId: user.id,
        action: 'oss_credentials.read',
        targetType: 'oss_account',
        targetId: user.id,
      });
      return {
        accessKeyId: decryptSecret(a.keyIdEncrypted),
        accessKeySecret: decryptSecret(a.keySecretEncrypted),
        scope: 'all-approved-spaces',
        bucket: r.bucket,
        region: r.region,
        endpoint: `https://oss-${r.region}.aliyuncs.com`,
        prefixes: spaces.map((s) => s.prefix),
      };
    });
  }
  async resetCredentials(user: AuthUser) {
    const result = await this.store.exclusive(async () => {
      await this.store.enabled();
      await this.actorActive(user);
      const a = await this.store.account(user.id);
      if (!a?.keyIdEncrypted) throw new ConflictException('尚未分配凭证');
      const [existing] = await this.store.db
        .select()
        .from(ossOperations)
        .where(
          and(
            eq(ossOperations.userId, user.id),
            eq(ossOperations.kind, 'reset'),
            ne(ossOperations.state, 'complete'),
          ),
        );
      if (existing)
        return {
          id: existing.id,
          state: existing.state,
          lastError: existing.lastError,
        };
      let op!: OssOperationRow;
      await this.store.db.transaction(async (tx) => {
        await tx
          .update(ossAccounts)
          .set({ syncPending: true, lastError: null })
          .where(eq(ossAccounts.userId, user.id));
        [op] = await tx
          .insert(ossOperations)
          .values({
            kind: 'reset',
            actorId: user.id,
            userId: user.id,
            context: { generation: a.keyGeneration },
          })
          .returning();
      });
      await this.audit.record({
        actorId: user.id,
        action: 'oss_credentials.reset',
        targetType: 'oss_account',
        targetId: user.id,
      });
      return { id: op.id, state: op.state, lastError: op.lastError };
    });
    this.wake();
    return result;
  }
  async operation(user: AuthUser, id: string) {
    const [op] = await this.store.db
      .select()
      .from(ossOperations)
      .where(eq(ossOperations.id, id));
    if (!op) throw new NotFoundException('操作不存在');
    if (user.role !== 'admin' && op.userId !== user.id)
      throw new ForbiddenException();
    return { id: op.id, state: op.state, lastError: op.lastError };
  }
  async setup(user: AuthUser) {
    this.admin(user);
    await this.store.exclusive(async () => {
      const r = await this.store.row();
      if (r.status === 'enabled') throw new ConflictException('OSS 已启用');
      const [existing] = await this.store.db
        .select()
        .from(ossOperations)
        .where(
          and(
            eq(ossOperations.kind, 'setup'),
            ne(ossOperations.state, 'complete'),
          ),
        );
      await this.store.db.transaction(async (tx) => {
        await tx
          .update(ossSettings)
          .set({ status: 'checking', checks: [], lastError: null })
          .where(eq(ossSettings.id, 1));
        if (existing)
          await tx
            .update(ossOperations)
            .set({ state: 'pending', retryAt: null })
            .where(eq(ossOperations.id, existing.id));
        else
          await tx
            .insert(ossOperations)
            .values({ kind: 'setup', actorId: user.id });
      });
      await this.audit.record({
        actorId: user.id,
        action: 'oss_settings.enable',
        targetType: 'oss_setting',
        targetId: '1',
      });
    });
    this.wake();
    return this.store.info();
  }
  async disable(user: AuthUser) {
    this.admin(user);
    return this.store.exclusive(async () => {
      if ((await this.store.row()).status === 'checking')
        throw new ConflictException('请先等待启用检查和清理完成');
      await this.store.db
        .update(ossSettings)
        .set({ status: 'disabled' })
        .where(eq(ossSettings.id, 1));
      await this.audit.record({
        actorId: user.id,
        action: 'oss_settings.disable',
        targetType: 'oss_setting',
        targetId: '1',
      });
      return this.store.info();
    });
  }
  async onUserStatusChanged(userId: string): Promise<boolean> {
    const a = await this.store.account(userId);
    if (!a) return false;
    await this.store.updateAccount(userId, { syncPending: true });
    this.wake();
    return true;
  }
  async tick() {
    const [configured] = await this.store.db
      .select({ id: ossSettings.id })
      .from(ossSettings)
      .limit(1);
    if (!configured || this.stopped) return;
    await this.store.exclusive(async (guard) => {
      // Security revocation remains enabled even when the capability is disabled.
      const accounts = await this.store.db
        .select({ a: ossAccounts, status: users.status })
        .from(ossAccounts)
        .innerJoin(users, eq(users.id, ossAccounts.userId));
      for (const { a, status } of accounts)
        if (
          a.userEnabled !== (status === 'active') ||
          (a.syncPending && !a.retiringKeyIds.length && !a.keyBaseline)
        ) {
          try {
            guard();
            await this.provisioner.syncUserStatus(a.userId, guard);
          } catch (e) {
            await this.store.updateAccount(a.userId, {
              syncPending: true,
              lastError: ossError(e),
            });
          }
        }
      const capabilityEnabled = (await this.store.row()).status === 'enabled';
      const ops = await this.store.db
        .select()
        .from(ossOperations)
        .where(
          and(
            ne(ossOperations.state, 'complete'),
            or(
              isNull(ossOperations.retryAt),
              lte(ossOperations.retryAt, new Date()),
            ),
            capabilityEnabled
              ? undefined
              : inArray(ossOperations.kind, ['setup', 'revoke', 'sync']),
          ),
        )
        .orderBy(asc(ossOperations.createdAt))
        .limit(30);
      for (const op of ops) {
        if (this.stopped) break;
        if (op.retryAt && op.retryAt > new Date()) continue;
        const enabled = (await this.store.row()).status === 'enabled';
        if (!['setup', 'revoke', 'sync'].includes(op.kind) && !enabled)
          continue;
        await this.store.updateOperation(op.id, {
          state: 'running',
          attempts: op.attempts + 1,
          lastError: null,
        });
        try {
          guard();
          await this.execute(op, guard);
          await this.store.updateOperation(op.id, {
            state: 'complete',
            retryAt: null,
            lastError: null,
          });
          await this.audit.record({
            actorId: op.actorId,
            action: 'oss_operation.completed',
            targetType: 'oss_operation',
            targetId: op.id,
            meta: { kind: op.kind },
          });
        } catch (e) {
          const message = ossError(e);
          await this.store.updateOperation(op.id, {
            state: 'failed',
            lastError: message,
            retryAt: new Date(
              Date.now() + Math.min(300_000, 30_000 * (op.attempts + 1)),
            ),
          });
          if (op.spaceId)
            await this.store.db
              .update(ossSpaces)
              .set({
                lastError: message,
                ...(op.kind === 'approve' ? { status: 'failed' as const } : {}),
              })
              .where(eq(ossSpaces.id, op.spaceId));
          if (op.kind === 'reset' && op.userId)
            await this.store.updateAccount(op.userId, {
              syncPending: true,
              lastError: message,
            });
          if (op.kind === 'setup')
            await this.store.db
              .update(ossSettings)
              .set({ status: 'failed', lastError: message })
              .where(eq(ossSettings.id, 1));
        }
      }
    });
  }
  private async execute(op: OssOperationRow, guard: () => void) {
    if (op.kind === 'setup') return this.provisioner.setup(op, guard);
    if (op.kind === 'reset') {
      const [owner] = await this.store.db
        .select()
        .from(users)
        .where(eq(users.id, op.userId!));
      if (owner?.status !== 'active')
        throw new ConflictException('用户已停用，恢复后重试凭证重置');
      return this.provisioner.ensureKey(
        op.userId!,
        guard,
        op.context.generation,
      );
    }
    if (op.kind === 'sync')
      return this.provisioner.syncUserStatus(op.userId!, guard);
    const s = await this.rawSpace(op.spaceId!);
    if (op.kind === 'approve') {
      const [u] = await this.store.db
        .select()
        .from(users)
        .where(eq(users.id, s.ownerId));
      if (u.status !== 'active')
        throw new ConflictException('申请人已停用，恢复用户后重试');
      await this.store.db
        .update(ossSpaces)
        .set({ status: 'provisioning' })
        .where(eq(ossSpaces.id, s.id));
      await this.provisioner.syncUser(s.ownerId, guard);
      await this.provisioner.ensureKey(s.ownerId, guard);
      guard();
      const [latest] = await this.store.db
        .select()
        .from(users)
        .where(eq(users.id, s.ownerId));
      if (latest.status !== 'active') {
        await this.provisioner.syncUserStatus(s.ownerId, guard);
        throw new ConflictException('申请人已停用');
      }
      await this.store.db
        .update(ossSpaces)
        .set({
          status: 'active',
          operationPending: false,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(ossSpaces.id, s.id));
    } else if (op.kind === 'revoke') {
      await this.provisioner.syncUser(s.ownerId, guard, false);
      guard();
      await this.store.syncPublic([], s.id);
      await this.store.db
        .update(ossSpaces)
        .set({
          status: 'revoked',
          publicRead: false,
          requestedPublicRead: false,
          operationPending: false,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(ossSpaces.id, s.id));
    } else if (op.kind === 'public') {
      guard();
      await this.store.syncPublic();
      await this.store.db
        .update(ossSpaces)
        .set({
          publicRead: s.requestedPublicRead,
          operationPending: false,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(ossSpaces.id, s.id));
    }
  }
}
