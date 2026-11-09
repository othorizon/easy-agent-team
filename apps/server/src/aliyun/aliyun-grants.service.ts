import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, lte, ne, sql } from 'drizzle-orm';
import type { AliyunGrantInfo, AliyunGrantsResult, AliyunGrantSource, GrantAliyunPermissionRequest } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { CloudIdentitiesService, type IdentitySession } from '../cloud-identities/cloud-identities.service';
import { DB, type Db } from '../db/db.module';
import { aliyunConnections, aliyunGrants, aliyunOperations, aliyunPermissions, cloudIdentities, users } from '../db/schema';
import { NotifierService } from '../notify/notifier.service';
import { RamCloudError } from '../ram/ram-cloud';
import { AliyunService } from './aliyun.service';
import { AliyunMaintenanceService } from './aliyun-maintenance.service';

type Permission = typeof aliyunPermissions.$inferSelect;
type Grant = typeof aliyunGrants.$inferSelect;
type Operation = typeof aliyunOperations.$inferSelect;
const PAUSED = '接入已暂停，不能新增授予；请管理员恢复接入后重试';

@Injectable()
export class AliyunGrantsService {
  private readonly logger = new Logger(AliyunGrantsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private stopped = false;
  constructor(@Inject(DB) private readonly db: Db, private readonly aliyun: AliyunService,
    private readonly identities: CloudIdentitiesService, private readonly audit: AuditService, private readonly notifier: NotifierService, private readonly maintenance: AliyunMaintenanceService) {}
  onModuleInit() { this.timer = setInterval(() => this.wake(), 30_000); this.timer.unref(); this.wake(); }
  private wake() {
    if (this.stopped || this.recovery) return;
    this.recovery = this.tick().catch(e => this.logger.warn(`阿里云授权恢复失败：${this.error(e)}`)).finally(() => { this.recovery = undefined; });
  }
  async onModuleDestroy() { this.stopped = true; clearInterval(this.timer); await this.recovery; }
  private error(e: unknown) {
    if (e instanceof RamCloudError) {
      if (e.kind === 'quota' && /AttachPolicy/.test(e.action)) return '已达到该 RAM 用户可绑定的自定义策略上限，请在阿里云配额中心调高';
      return e.message;
    }
    if (e instanceof ConflictException || e instanceof NotFoundException) return e.message;
    return '阿里云授权执行失败，请管理员检查配置后重试';
  }
  private manage(user: AuthUser, permission: Permission) {
    if (user.role !== 'admin' && !(permission.open && permission.ownerId === user.id))
      throw new ForbiddenException('仅权限点 Owner 或管理员可操作；未开放申请的权限点仅管理员可操作');
  }
  private async permission(id: string) {
    const [p] = await this.db.select().from(aliyunPermissions).where(eq(aliyunPermissions.id, id));
    if (!p) throw new NotFoundException('权限点不存在');
    return p;
  }
  private async grant(id: string) {
    const [g] = await this.db.select().from(aliyunGrants).where(eq(aliyunGrants.id, id));
    if (!g) throw new NotFoundException('授权不存在');
    return g;
  }
  /** Unified executor for direct grants, approved requests, and an Owner/admin's own request. */
  async give(actor: AuthUser, permissionId: string, dto: GrantAliyunPermissionRequest, source: AliyunGrantSource = 'direct', requestId?: string): Promise<AliyunGrantInfo> {
    const initial = await this.permission(permissionId), c = await this.aliyun.connection(initial.connectionId);
    this.manage(actor, initial);
    return this.identities.run(c.accountId, dto.userId, this.aliyun.credentials(c), async session => {
      const p = await this.permission(permissionId), connection = await this.aliyun.connection(p.connectionId);
      this.manage(actor, p);
      this.aliyun.assertWritable(connection);
      if (connection.status === 'paused') throw new ConflictException(PAUSED);
      if (!p.cloudExists) throw new ConflictException('权限点在云端已删除，不能授予');
      const [user] = await this.db.select().from(users).where(eq(users.id, dto.userId));
      if (!user) throw new NotFoundException('EAT 用户不存在');
      if (user.status !== 'active') throw new ConflictException('停用的 EAT 用户不能被授予');
      session.guard();
      const g = await this.db.transaction(async tx => {
        const [currentConnection] = await tx.select().from(aliyunConnections).where(eq(aliyunConnections.id, connection.id)).for('update');
        if (!currentConnection) throw new NotFoundException('接入不存在');
        this.aliyun.assertWritable(currentConnection);
        const [g] = await tx.insert(aliyunGrants).values({ permissionId, userId: dto.userId, grantedBy: actor.id, source })
          .onConflictDoUpdate({ target: [aliyunGrants.permissionId, aliyunGrants.userId], set: {
            state: 'pending', error: null, source, grantedBy: actor.id, revokedBy: null, revocationReason: null, relinquished: false, updatedAt: new Date(),
          } }).returning();
        if (requestId) {
          const approved = await tx.execute(sql`UPDATE approval_request SET status='approved',execution='provisioning',execution_error=NULL,decided_by=${actor.id},decided_at=now(),details=details || jsonb_build_object('grantId',${g.id}::text) WHERE id=${requestId} AND status='pending' RETURNING id`);
          if (!approved.rowCount) throw new ConflictException('申请状态已变化');
          await tx.execute(sql`INSERT INTO approval_notification(request_id,event) VALUES(${requestId},'approved') ON CONFLICT DO NOTHING`);
        }
        await this.queue(tx, g, 'grant', actor.id);
        await this.audit.record({ actorId: actor.id, actorTokenId: actor.tokenId, action: 'aliyun.grant', targetType: 'aliyun_grant', targetId: g.id, meta: { permissionId, userId: dto.userId, source } }, tx);
        return g;
      });
      await this.execute(await this.operation(g.id), session);
      return this.info(actor, g.id);
    });
  }
  async revoke(actor: AuthUser, grantId: string, reason: string, relinquished = false): Promise<AliyunGrantInfo> {
    const initial = await this.grant(grantId), p = await this.permission(initial.permissionId), c = await this.aliyun.connection(p.connectionId);
    if (relinquished) { if (initial.userId !== actor.id) throw new ForbiddenException('只能放弃自己的授权'); }
    else this.manage(actor, p);
    return this.identities.run(c.accountId, initial.userId, this.aliyun.credentials(c), async session => {
      const g = await this.grant(grantId), current = await this.permission(g.permissionId);
      if (relinquished) { if (g.userId !== actor.id) throw new ForbiddenException('只能放弃自己的授权'); }
      else this.manage(actor, current);
      await this.maintenance.checkDrift(session, c.accountId, g.userId);
      if (g.state === 'revoked') return this.info(actor, g.id);
      session.guard();
      await this.db.transaction(async tx => {
        await tx.update(aliyunGrants).set({ state: 'revoking', error: null, revokedBy: actor.id, revocationReason: reason || null, relinquished, updatedAt: new Date() }).where(eq(aliyunGrants.id, grantId));
        await this.queue(tx, g, 'revoke', actor.id);
        await this.audit.record({ actorId: actor.id, actorTokenId: actor.tokenId, action: relinquished ? 'aliyun.relinquish' : 'aliyun.revoke', targetType: 'aliyun_grant', targetId: grantId, meta: { reason, userId: g.userId, permissionId: g.permissionId } }, tx);
      });
      await this.execute(await this.operation(grantId), session);
      return this.info(actor, grantId);
    });
  }
  async retry(actor: AuthUser, id: string) {
    const initial = await this.grant(id), p = await this.permission(initial.permissionId), c = await this.aliyun.connection(p.connectionId);
    const pending = await this.operation(id);
    if (!(pending.kind === 'revoke' && initial.relinquished && initial.userId === actor.id)) this.manage(actor, p);
    return this.identities.run(c.accountId, initial.userId, this.aliyun.credentials(c), async session => {
      const g = await this.grant(id), op = await this.operation(id);
      const currentPermission = await this.permission(g.permissionId);
      if (!(op.kind === 'revoke' && g.relinquished && g.userId === actor.id)) this.manage(actor, currentPermission);
      if (op.state === 'complete') return this.info(actor, id);
      if (op.kind === 'grant') this.aliyun.assertWritable(await this.aliyun.connection(p.connectionId));
      if (op.kind === 'grant' && (await this.aliyun.connection(p.connectionId)).status === 'paused') throw new ConflictException(PAUSED);
      session.guard();
      await this.db.update(aliyunOperations).set({ state: 'pending', retryAt: new Date(), updatedAt: new Date() }).where(eq(aliyunOperations.id, op.id));
      await this.execute({ ...op, state: 'pending' }, session);
      await this.audit.record({ actorId: actor.id, actorTokenId: actor.tokenId, action: 'aliyun.retry', targetType: 'aliyun_grant', targetId: g.id });
      return this.info(actor, id);
    });
  }
  private async queue(tx: Pick<Db, 'insert'>, g: Grant, kind: Operation['kind'], actorId: string) {
    await tx.insert(aliyunOperations).values({ grantId: g.id, kind, actorId }).onConflictDoUpdate({ target: aliyunOperations.grantId,
      set: { kind, actorId, state: 'pending', attempts: 0, lastError: null, retryAt: new Date(), updatedAt: new Date() } });
  }
  private async operation(grantId: string) { return (await this.db.select().from(aliyunOperations).where(eq(aliyunOperations.grantId, grantId)))[0]; }
  private async execute(op: Operation, session: IdentitySession) {
    if (op.state === 'complete') return;
    const g = await this.grant(op.grantId), p = await this.permission(g.permissionId), c = await this.aliyun.connection(p.connectionId);
    if (op.kind === 'grant' && (c.status === 'paused' || c.cleanupState)) return;
    session.guard();
    await this.db.update(aliyunOperations).set({ state: 'running', attempts: op.attempts + 1, updatedAt: new Date() }).where(eq(aliyunOperations.id, op.id));
    try {
      if (op.kind === 'grant' && !p.cloudExists) throw new ConflictException('权限点在云端已删除，不能授予');
      const identity = await session.setPolicy(p.policyName, op.kind === 'grant');
      session.guard();
      await this.db.transaction(async tx => {
        await tx.update(aliyunGrants).set({ state: op.kind === 'grant' ? 'active' : 'revoked', identityId: identity?.id ?? g.identityId, error: null, updatedAt: new Date() }).where(eq(aliyunGrants.id, g.id));
        await tx.update(aliyunOperations).set({ state: 'complete', lastError: null, updatedAt: new Date() }).where(eq(aliyunOperations.id, op.id));
      });
      if (op.kind === 'revoke' && !g.relinquished) {
        const [actor] = await this.db.select().from(users).where(eq(users.id, g.revokedBy ?? op.actorId));
        this.notifier.notify(g.userId, 'approvalResult', 'aliyun.revoked', {
          header: { title: { tag: 'plain_text', content: '阿里云授权已撤销' }, template: 'orange' },
          elements: [{ tag: 'div', text: { tag: 'plain_text', content: `权限点：${p.policyName}\n云账号：${c.name}\n撤销人：${actor?.name ?? '管理员'}\n原因：${g.revocationReason || '未填写'}` } }],
        }, `${actor?.name ?? '管理员'}撤销了 ${p.policyName}：${g.revocationReason || '未填写原因'}`);
      }
    } catch (e) {
      session.guard(); // A lost lock must never publish a stale success/failure over a replacement worker.
      const error = this.error(e);
      await this.db.transaction(async tx => {
        await tx.update(aliyunGrants).set({ state: 'failed', error, updatedAt: new Date() }).where(eq(aliyunGrants.id, g.id));
        await tx.update(aliyunOperations).set({ state: 'failed', lastError: error, retryAt: new Date(Date.now() + Math.min(300_000, 30_000 * (op.attempts + 1))), updatedAt: new Date() }).where(eq(aliyunOperations.id, op.id));
      });
    }
    await this.syncRequestExecution(g.id);
  }
  private async syncRequestExecution(grantId?: string) {
    await this.db.execute(sql`UPDATE approval_request r SET execution=CASE g.state WHEN 'pending' THEN 'provisioning' ELSE g.state END,execution_error=g.error FROM aliyun_grant g WHERE (${grantId ?? null}::uuid IS NULL OR g.id=${grantId ?? null}::uuid) AND r.type='aliyun' AND r.status='approved' AND r.latest AND r.details->>'grantId'=g.id::text`);
  }
  /** Durable work, including interrupted running operations, resumes after restart. */
  async tick() {
    await this.syncRequestExecution();
    const pending = await this.db.select().from(aliyunOperations).where(and(ne(aliyunOperations.state, 'complete'), lte(aliyunOperations.retryAt, new Date()))).orderBy(asc(aliyunOperations.createdAt)).limit(30);
    for (const op of pending) {
      if (this.stopped) return;
      const g = await this.grant(op.grantId), p = await this.permission(g.permissionId), c = await this.aliyun.connection(p.connectionId);
      if (op.kind === 'grant' && (c.status === 'paused' || c.cleanupState)) continue;
      try {
        await this.identities.run(c.accountId, g.userId, this.aliyun.credentials(c), async session => {
          const current = await this.operation(g.id);
          if (current.state !== 'complete' && current.retryAt <= new Date()) await this.execute(current, session);
        });
      } catch (e) { this.logger.warn(`阿里云授权待恢复：${this.error(e)}`); }
    }
  }
  private async records(actor: AuthUser, manage: boolean): Promise<AliyunGrantInfo[]> {
    const rows = await this.db.select({ g: aliyunGrants, p: aliyunPermissions, c: aliyunConnections, userName: users.name }).from(aliyunGrants)
      .innerJoin(aliyunPermissions, eq(aliyunPermissions.id, aliyunGrants.permissionId))
      .innerJoin(aliyunConnections, eq(aliyunConnections.id, aliyunPermissions.connectionId))
      .innerJoin(users, eq(users.id, aliyunGrants.userId))
      .where(manage ? (actor.role === 'admin' ? undefined : and(eq(aliyunPermissions.ownerId, actor.id), eq(aliyunPermissions.open, true))) : eq(aliyunGrants.userId, actor.id));
    const grants: AliyunGrantInfo[] = rows.map(({ g, p, c, userName }) => ({ ...g, userName, connectionId: c.id, connectionName: c.name, accountId: c.accountId, policyName: p.policyName,
      cloudExists: p.cloudExists, canManage: actor.role === 'admin' || (p.open && p.ownerId === actor.id), createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString() }));
    return grants;
  }
  async list(actor: AuthUser, manage = false): Promise<AliyunGrantsResult> {
    const grants = await this.records(actor, manage);
    const accounts: AliyunGrantsResult['accounts'] = [];
    if (!manage) {
      const identities = await this.db.select({ identity: cloudIdentities, c: aliyunConnections }).from(cloudIdentities)
        .innerJoin(aliyunConnections, eq(aliyunConnections.accountId, cloudIdentities.accountId)).where(eq(cloudIdentities.userId, actor.id));
      for (const { identity, c } of identities) {
        let customPolicyCount: number | null = null, error: string | null = null;
        try { customPolicyCount = await this.identities.run(c.accountId, actor.id, this.aliyun.credentials(c), async s => (await s.inspect()).policies.filter(p => p.type === 'Custom').length); }
        catch (e) { error = this.error(e); }
        accounts.push({ accountId: c.accountId, connectionId: c.id, connectionName: c.name, connectionStatus: c.status, identityId: identity.id, ramName: identity.ramName, customPolicyCount, error });
      }
    }
    return { grants, accounts, drift: manage ? await this.maintenance.inspectAll(actor) : [] };
  }
  private async info(actor: AuthUser, id: string): Promise<AliyunGrantInfo> {
    // The holder may relinquish an authorization that is not visible in the management list.
    const own = (await this.records(actor, false)).find(g => g.id === id);
    const managed = own ?? (await this.records(actor, true)).find(g => g.id === id);
    if (!managed) throw new NotFoundException('授权不存在');
    return managed;
  }
}
