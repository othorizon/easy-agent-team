import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { dbConnectionUrl, type UpdateDbInstanceCredentialsRequest, type DbAccessDrift, type DbAccessCredentials, type DbAccessGrantInfo, type DbCatalogInfo, type DbPersonalPasswordReset, type DbPublicCheck, type GrantDbAccessRequest, type OpenDbAccessRequest, type RegisterExternalDbRequest } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { isFullId } from '../common/short-id';
import { DB, PG_POOL, type Db } from '../db/db.module';
import { dbAccessGrants, dbAssignments, dbCatalog, dbInstances, dbPersonalRoles, users } from '../db/schema';
import { NotifierService } from '../notify/notifier.service';
import { grantPostgresAccess, openPostgresAccess, revokePostgresAccess } from './access-provisioner';
import { resetPostgresPersonalPassword, syncPostgresPersonalLogin } from './personal-role-provisioner';
import type { AdminConn } from './provisioner';
import { inspectPostgresAccess, repairPostgresAccess, type ExpectedDbMember } from './access-drift-provisioner';
import { cleanupPostgresAccessRoles, type ManagedDbRole } from './access-cleanup-provisioner';
import { checkExternalPostgresAccess, openExternalPostgresAccess } from './external-provisioner';

type Catalog = typeof dbCatalog.$inferSelect;
type Grant = typeof dbAccessGrants.$inferSelect;
type PersonalRole = typeof dbPersonalRoles.$inferSelect;
@Injectable()
export class DbAccessService {
  private readonly logger = new Logger(DbAccessService.name);
  private readonly lockPool: Pool;
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private stopped = false;
  constructor(@Inject(DB) private readonly db: Db, @Inject(PG_POOL) pool: Pool, private readonly audit: AuditService, private readonly notifier: NotifierService) {
    // 等待同一实例的请求只占锁池，持锁任务始终能从业务池取得连接。
    this.lockPool = new Pool({ ...pool.options, max: 4 });
    this.lockPool.on('error', () => undefined);
  }
  onModuleInit() {
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref();
    this.wake();
  }
  private wake() {
    if (this.stopped || this.recovery) return;
    this.recovery = this.recover().catch(e => this.logger.warn(`数据库授权恢复失败：${this.error(e)}`)).finally(() => { this.recovery = undefined; });
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.recovery;
    await this.lockPool.end();
  }
  private async recover() {
    const statusPending = await this.db.select({ p: dbPersonalRoles }).from(dbPersonalRoles).innerJoin(users, eq(users.id, dbPersonalRoles.userId))
      .where(and(or(eq(dbPersonalRoles.syncPending, true), sql`${dbPersonalRoles.loginEnabled} <> (${users.status}='active')`), or(sql`${dbPersonalRoles.syncRetryAt} is null`, sql`${dbPersonalRoles.syncRetryAt} <= now()`)));
    for (const { p } of statusPending) {
      if (this.stopped) return;
      await this.syncPersonalStatus(p);
    }
    const rotating = await this.db.select().from(dbPersonalRoles).where(isNotNull(dbPersonalRoles.pendingPasswordEncrypted));
    for (const initial of rotating) {
      if (this.stopped) return;
      await this.locked(initial.instanceId, async guard => {
        const [identity] = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.id, initial.id));
        if (identity?.pendingPasswordEncrypted) await this.applyPassword(identity, guard);
      });
    }
    // 这些行就是持久化的未完成操作；执行失败保留原因，由管理者显式重试。
    const opening = await this.db.select().from(dbCatalog).where(eq(dbCatalog.state, 'pending')).orderBy(dbCatalog.updatedAt).limit(20);
    for (const initial of opening) {
      if (this.stopped) return;
      await this.locked(initial.instanceId, async guard => {
        const row = await this.catalog(initial.id);
        if (row.state === 'pending') {
          await this.executeOpen(row, guard);
          await this.audit.record({ actorId: row.openedBy, action: 'db_access.opened', targetType: 'db_catalog', targetId: row.id, meta: { recovered: true } });
        }
      });
    }

    const pending = await this.db.select().from(dbAccessGrants).where(inArray(dbAccessGrants.state, ['pending', 'revoking'])).orderBy(dbAccessGrants.updatedAt).limit(20);
    for (const initial of pending) {
      if (this.stopped) return;
      const c = await this.catalog(initial.catalogId);
      await this.locked(c.instanceId, async guard => {
        const g = await this.grant(initial.id);
        const c = await this.catalog(g.catalogId);
        if (g.state === 'pending') await this.executeGrant(c, g, guard);
        else if (g.state === 'revoking') await this.executeRevoke(c, g, guard);
      });
    }
    // 外部执行已完成但快照写入前进程退出时，下次恢复仍会修正申请中心。
    await this.syncRequestExecution();
  }

  async onUserStatusChanged(userId: string): Promise<boolean> {
    const identities = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.userId, userId));
    for (const p of identities) await this.syncPersonalStatus(p, true);
    const [result] = await this.db.select({ pending: sql<boolean>`exists(select 1 from db_personal_role p where p.user_id=${userId} and (p.sync_pending or p.login_enabled <> ("user".status='active')))` }).from(users).where(eq(users.id, userId));
    return result?.pending ?? false;
  }
  private async syncPersonalStatus(initial: PersonalRole, force = false): Promise<void> {
    try {
      await this.locked(initial.instanceId, async guard => {
        const [p] = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.id, initial.id));
        if (!p) return; // 实例删除与安全同步使用同一把实例锁。
        if (!force && p.syncRetryAt && p.syncRetryAt > new Date()) return;
        await this.applyPersonalStatus(p, guard);
      });
    } catch (e) { this.logger.warn(`个人数据库身份状态同步待完成：${this.error(e)}`); }
  }
  private async applyPersonalStatus(identity: PersonalRole, guard: () => void): Promise<boolean> {
    const [target] = await this.db.select({ status: users.status }).from(users).where(eq(users.id, identity.userId));
    const enabled = target?.status === 'active';
    guard();
    await this.db.update(dbPersonalRoles).set({ syncPending: true }).where(eq(dbPersonalRoles.id, identity.id));
    try {
      await syncPostgresPersonalLogin(await this.connection(identity.instanceId, true), identity, enabled, guard);
      guard();
      await this.db.update(dbPersonalRoles).set({ loginEnabled: enabled, syncPending: sql`exists(select 1 from "user" u where u.id=${identity.userId} and (u.status='active') <> ${enabled})`, syncError: null, syncAttempts: 0, syncRetryAt: null }).where(eq(dbPersonalRoles.id, identity.id));
      return true;
    } catch (e) {
      guard();
      const attempts = identity.syncAttempts + 1;
      await this.db.update(dbPersonalRoles).set({ syncPending: true, syncError: this.error(e), syncAttempts: attempts, syncRetryAt: new Date(Date.now() + Math.min(30_000 * 2 ** Math.min(attempts - 1, 7), 3_600_000)) }).where(eq(dbPersonalRoles.id, identity.id));
      return false;
    }
  }

  /** 跨进程按实例串行执行；外部 PG 操作不放在平台数据库事务中。 */
  private async locked<T>(instanceId: string, fn: (guard: () => void) => Promise<T>): Promise<T> {
    const c = await this.lockPool.connect();
    let held = false, lost = false;
    const onError = () => { lost = true; };
    const guard = () => { if (lost) throw new ConflictException('数据库操作锁已中断，未完成操作将重新恢复'); };
    c.on('error', onError);
    try {
      await c.query('select pg_advisory_lock(hashtextextended($1,0))', [`db-access:${instanceId}`]);
      held = true;
      guard();
      return await fn(guard);
    } finally {
      if (held && !lost) await c.query('select pg_advisory_unlock(hashtextextended($1,0))', [`db-access:${instanceId}`]).catch(() => { lost = true; });
      c.off('error', onError);
      c.release(lost);
    }
  }
  private manage(user: AuthUser, ownerId: string) {
    if (user.role !== 'admin' && user.id !== ownerId) throw new ForbiddenException('仅 Owner 或管理员可管理数据库权限');
  }
  private async catalog(id: string): Promise<Catalog> {
    const [row] = isFullId(id) ? await this.db.select().from(dbCatalog).where(eq(dbCatalog.id, id)) : [];
    if (!row) throw new NotFoundException('数据库目录记录不存在');
    return row;
  }
  private async grant(id: string): Promise<Grant> {
    const [row] = isFullId(id) ? await this.db.select().from(dbAccessGrants).where(eq(dbAccessGrants.id, id)) : [];
    if (!row) throw new NotFoundException('数据库授权不存在');
    return row;
  }
  private async connection(instanceId: string, deleting = false): Promise<AdminConn> {
    if (!deleting) await this.assertInstanceAvailable(instanceId);
    const [i] = await this.db.select().from(dbInstances).where(eq(dbInstances.id, instanceId));
    if (!i) throw new NotFoundException('实例不存在');
    return { host: i.host, port: i.port, adminUser: i.adminUser, adminPassword: decryptSecret(i.adminPasswordEncrypted) };
  }
  private assertCatalogAvailable(c: Catalog) {
    if (c.error?.startsWith('删除未完成：')) throw new ConflictException(c.error);
  }
  private async assertInstanceAvailable(instanceId: string) {
    const [instance] = await this.db.select({ cleanupError: dbInstances.cleanupError }).from(dbInstances).where(eq(dbInstances.id,instanceId));
    if (instance?.cleanupError) throw new ConflictException(instance.cleanupError);
  }
  private roles(catalogs: Catalog[], identities: PersonalRole[] = []): ManagedDbRole[] {
    return [...catalogs.flatMap(c => [{ name: c.readRole, marker: `eat:db-catalog:${c.id}:read` }, { name: c.writeRole, marker: `eat:db-catalog:${c.id}:write` }]), ...identities.map(i => ({ name: i.roleName, marker: `eat:db-personal-role:${i.id}` }))];
  }
  private async assertRevoked(catalogs: Catalog[]) {
    if (!catalogs.length) return;
    const outstanding = await this.db.select().from(dbAccessGrants).where(and(inArray(dbAccessGrants.catalogId, catalogs.map(c => c.id)), ne(dbAccessGrants.state, 'revoked')));
    if (outstanding.length) throw new ConflictException(`仍有 ${outstanding.length} 条未撤销授权（含待执行、失败或撤销中），请先完成全部撤销再删除`);
  }
  async removeExternal(user: AuthUser, id: string) {
    if (user.role !== 'admin') throw new ForbiddenException('仅管理员可删除外部库登记');
    const initial = await this.catalog(id);
    return this.locked(initial.instanceId, async guard => {
      const row = await this.catalog(id);
      if (row.source !== 'external') throw new BadRequestException('只能删除外部库登记');
      await this.assertRevoked([row]);
      const conn = await this.connection(row.instanceId, true);
      let started = !!row.error?.startsWith('删除未完成：');
      try {
        await cleanupPostgresAccessRoles(conn,this.roles([row]),guard,async () => {
          guard(); await this.db.update(dbCatalog).set({ open: false, state: 'failed', error: '删除未完成：外部库登记，等待清理角色；请重试删除', updatedAt: new Date() }).where(eq(dbCatalog.id,id));
          started = true;
        });
        guard();
        await this.db.transaction(async tx => {
          await tx.delete(dbAccessGrants).where(eq(dbAccessGrants.catalogId,id));
          await tx.delete(dbCatalog).where(eq(dbCatalog.id,id));
        });
      } catch (e) {
        const message = `${started ? '删除未完成：外部库登记，平台记录保留，请重试删除。' : '删除已停止，尚未清理角色。'}${this.error(e)}`;
        guard(); if (started) await this.db.update(dbCatalog).set({ state: 'failed', error: message, updatedAt: new Date() }).where(eq(dbCatalog.id,id));
        await this.audit.record({ actorId: user.id, action: 'db_access.external_delete_failed', targetType: 'db_catalog', targetId: id, meta: { error: this.error(e), retryable: true } });
        throw new ConflictException(message);
      }
      await this.audit.record({ actorId: user.id, action: 'db_access.external_deleted', targetType: 'db_catalog', targetId: id, meta: { dbName: row.dbName, databasePreserved: true } });
      return { ok: true };
    });
  }
  async updateInstanceCredentials(user: AuthUser,id:string,dto:UpdateDbInstanceCredentialsRequest) {
    if (user.role!=='admin') throw new ForbiddenException('仅管理员可修改实例管理凭证');
    return this.locked(id,async guard=> {
      const [instance]=isFullId(id)?await this.db.select().from(dbInstances).where(eq(dbInstances.id,id)):[];
      if (!instance) throw new NotFoundException('实例不存在');
      guard(); await this.db.update(dbInstances).set({ adminUser:dto.adminUser,adminPasswordEncrypted:encryptSecret(dto.adminPassword) }).where(eq(dbInstances.id,id));
      await this.audit.record({ actorId:user.id,action:'db_instance.credentials_updated',targetType:'db_instance',targetId:id });
      return { ok:true };
    });
  }
  async removeInstance(user: AuthUser, id: string) {
    if (user.role !== 'admin') throw new ForbiddenException('仅管理员可删除实例登记');
    return this.locked(id, async guard => {
      const [instance] = isFullId(id) ? await this.db.select().from(dbInstances).where(eq(dbInstances.id,id)) : [];
      if (!instance) throw new NotFoundException('实例不存在');
      const assertAssignments = async (db: Pick<Db, 'select'>) => {
        const outstanding = await db.select().from(dbAssignments).where(and(eq(dbAssignments.instanceId,id),inArray(dbAssignments.status,['active','provisioning'])));
        if (outstanding.length) throw new ConflictException('实例上仍有使用中或开通中的分配，请等待开通完成并删除分配记录后再删除实例');
      };
      await assertAssignments(this.db);
      const catalogs = await this.db.select().from(dbCatalog).where(eq(dbCatalog.instanceId,id));
      await this.assertRevoked(catalogs);
      const identities = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.instanceId,id));
      const conn = await this.connection(id,true);
      let started = !!instance.cleanupError;
      const start = async () => {
        guard();
        await this.db.transaction(async tx => {
          await tx.update(dbInstances).set({ cleanupError: '删除未完成：实例，正在清理角色；请等待或重试删除' }).where(eq(dbInstances.id,id));
          await tx.update(dbCatalog).set({ open: false, state: 'failed', error: '删除未完成：实例，等待清理角色；请重试删除', updatedAt: new Date() }).where(eq(dbCatalog.instanceId,id));
        });
        started = true;
      };
      try {
        if (instance.engine === 'postgres') await cleanupPostgresAccessRoles(conn,this.roles(catalogs,identities),guard,start);
        else await start();
        guard();
        await this.db.transaction(async tx => {
          await tx.select({ id: dbInstances.id }).from(dbInstances).where(eq(dbInstances.id,id)).for('update');
          await assertAssignments(tx);
          if (catalogs.length) await tx.delete(dbAccessGrants).where(inArray(dbAccessGrants.catalogId,catalogs.map(c => c.id)));
          await tx.delete(dbCatalog).where(eq(dbCatalog.instanceId,id));
          await tx.delete(dbPersonalRoles).where(eq(dbPersonalRoles.instanceId,id));
          await tx.delete(dbInstances).where(eq(dbInstances.id,id));
        });
      } catch (e) {
        const message = `${started ? '删除未完成：实例，平台记录保留，请重试删除。' : '删除已停止，尚未清理角色。'}${this.error(e)}`;
        guard(); if (started) await this.db.transaction(async tx => {
          await tx.update(dbInstances).set({ cleanupError: message }).where(eq(dbInstances.id,id));
          await tx.update(dbCatalog).set({ state: 'failed', error: message, updatedAt: new Date() }).where(eq(dbCatalog.instanceId,id));
        });
        await this.audit.record({ actorId: user.id, action: 'db_instance.delete_failed', targetType: 'db_instance', targetId: id, meta: { error: this.error(e), retryable: true } });
        throw new ConflictException(message);
      }
      await this.audit.record({ actorId: user.id, action: 'db_instance.deleted', targetType: 'db_instance', targetId: id, meta: { databasesAndOwnersPreserved: true } });
      return { ok: true };
    });
  }
  async listCatalog(user: AuthUser, checkDrift = false): Promise<DbCatalogInfo[]> {
    const rows = await this.db.select({ a: dbAssignments, c: dbCatalog, i: dbInstances, ownerName: users.name, ownerStatus: users.status })
      .from(dbAssignments).innerJoin(dbInstances, eq(dbInstances.id, dbAssignments.instanceId))
      .innerJoin(users, eq(users.id, dbAssignments.requesterId)).leftJoin(dbCatalog, eq(dbCatalog.assignmentId, dbAssignments.id))
      .where(and(eq(dbInstances.engine, 'postgres'), inArray(dbAssignments.status, ['active', 'disabled']), user.role === 'admin' ? undefined : or(eq(dbAssignments.requesterId, user.id), and(eq(dbCatalog.open, true), eq(dbCatalog.state, 'active')))));
    const external = await this.db.select({ c: dbCatalog, i: dbInstances, ownerName: users.name, ownerStatus: users.status })
      .from(dbCatalog).innerJoin(dbInstances, eq(dbInstances.id, dbCatalog.instanceId)).innerJoin(users, eq(users.id, dbCatalog.ownerId))
      .where(and(eq(dbCatalog.source, 'external'), user.role === 'admin' ? undefined : or(eq(dbCatalog.ownerId, user.id), and(eq(dbCatalog.open, true), eq(dbCatalog.state, 'active')))));
    const result: DbCatalogInfo[] = [...rows.map(({ a, c, i, ownerName, ownerStatus }) => ({ id: c?.id ?? null, assignmentId: a.id, instanceId: i.id, instanceName: i.name, dbName: a.dbName, source: 'eat' as const, creatorRole: c?.creatorRole ?? a.dbUser, publicCheck: c?.publicCheck ?? null, ownerId: a.requesterId, ownerName, ownerDisabled: ownerStatus !== 'active', open: c?.open ?? false, schemas: c?.schemas ?? ['public'], state: c?.state ?? 'pending', error: c?.error ?? null, canManage: user.role === 'admin' || a.requesterId === user.id })), ...external.map(({ c, i, ownerName, ownerStatus }) => ({ ...c, instanceName: i.name, ownerName, ownerDisabled: ownerStatus !== 'active', canManage: user.role === 'admin' || c.ownerId === user.id }))];
    if (checkDrift && user.role === 'admin') for (const item of result) if (item.id) {
      try { item.drift = await this.inspectDrift(await this.catalog(item.id)); }
      catch (e) { item.drift = { checkedAt: new Date().toISOString(), consistent: false, error: this.error(e), members: [] }; }
    }
    return result;
  }
  async registerExternal(user: AuthUser, instanceId: string, dto: RegisterExternalDbRequest): Promise<DbCatalogInfo> {
    if (user.role !== 'admin') throw new ForbiddenException('仅管理员可登记外部库');
    const [instance] = isFullId(instanceId) ? await this.db.select().from(dbInstances).where(eq(dbInstances.id, instanceId)) : [];
    if (!instance) throw new NotFoundException('实例不存在');
    if (instance.engine !== 'postgres') throw new BadRequestException('MySQL 实例上不能登记外部库');
    const [owner] = await this.db.select().from(users).where(eq(users.id, dto.ownerId));
    if (!owner || owner.status !== 'active') throw new BadRequestException('请选择启用中的 EAT 用户作为 Owner');
    return this.locked(instanceId, async guard => {
      await this.connection(instanceId);
      const [existing] = await this.db.select().from(dbCatalog).where(and(eq(dbCatalog.instanceId, instanceId), eq(dbCatalog.dbName, dto.dbName)));
      const [assignment] = await this.db.select().from(dbAssignments).where(and(eq(dbAssignments.instanceId, instanceId), eq(dbAssignments.dbName, dto.dbName), inArray(dbAssignments.status, ['active', 'disabled', 'provisioning'])));
      if (existing || assignment) throw new ConflictException('此库已有目录记录或 EAT 分配，请从原记录管理');
      const id = randomUUID();
      const values = { id, source: 'external' as const, assignmentId: null, instanceId, dbName: dto.dbName, ownerId: dto.ownerId, openedBy: user.id, open: false, schemas: dto.schemas, creatorRole: dto.creatorRole ?? null, readRole: `eat-db-${id}-read`, writeRole: `eat-db-${id}-write` };
      let publicCheck: DbPublicCheck;
      try { publicCheck = await checkExternalPostgresAccess(await this.connection(instanceId), values); }
      catch (e) { throw new BadRequestException(this.error(e)); }
      guard();
      const [row] = await this.db.insert(dbCatalog).values({ ...values, publicCheck }).returning();
      await this.executeOpen(row, guard);
      const result = (await this.listCatalog(user)).find(c => c.id === id)!;
      await this.audit.record({ actorId: user.id, action: 'db_access.external_registered', targetType: 'db_catalog', targetId: id });
      if (result.error) throw new BadRequestException({ error: 'DB_EXTERNAL_REGISTRATION_FAILED', message: result.error, details: { catalogId: id } });
      return result;
    });
  }
  async configureExternal(user: AuthUser, id: string, dto: OpenDbAccessRequest): Promise<DbCatalogInfo> {
    const initial = await this.catalog(id);
    this.manage(user, initial.ownerId);
    if (initial.source !== 'external') throw new BadRequestException('EAT 建的库请从分配记录配置');
    return this.locked(initial.instanceId, async guard => {
      const row = await this.catalog(id);
      this.assertCatalogAvailable(row);
      this.manage(user, row.ownerId);
      const schemas = dto.schemas ?? row.schemas;
      const creatorRole = dto.creatorRole === undefined ? row.creatorRole : dto.creatorRole;
      const changed = JSON.stringify(schemas) !== JSON.stringify(row.schemas) || creatorRole !== row.creatorRole;
      guard();
      if (row.state !== 'active' || changed) {
        await this.db.update(dbCatalog).set({ open: dto.open, schemas, creatorRole, state: 'pending', error: null, openedBy: user.id, updatedAt: new Date() }).where(eq(dbCatalog.id, id));
        await this.executeOpen({ ...row, open: dto.open, schemas, creatorRole }, guard);
      } else await this.db.update(dbCatalog).set({ open: dto.open, updatedAt: new Date() }).where(eq(dbCatalog.id, id));
      await this.audit.record({ actorId: user.id, action: dto.open ? 'db_access.opened' : 'db_access.closed', targetType: 'db_catalog', targetId: id });
      return (await this.listCatalog(user)).find(c => c.id === id)!;
    });
  }
  async open(user: AuthUser, assignmentId: string, dto: OpenDbAccessRequest): Promise<DbCatalogInfo> {
    const [a] = isFullId(assignmentId) ? await this.db.select().from(dbAssignments).where(eq(dbAssignments.id, assignmentId)) : [];
    if (!a) throw new NotFoundException('分配不存在');
    this.manage(user, a.requesterId);
    const [i] = await this.db.select().from(dbInstances).where(eq(dbInstances.id, a.instanceId));
    if (i.engine !== 'postgres') throw new BadRequestException('MySQL 实例上的库不能开放申请');
    if (!['active', 'disabled'].includes(a.status)) throw new ConflictException('仅已生效的分配可开放申请');
    return this.locked(a.instanceId, async guard => {
      await this.connection(a.instanceId);
      guard();
      let [row] = await this.db.select().from(dbCatalog).where(eq(dbCatalog.assignmentId, a.id));
      if (row) this.assertCatalogAvailable(row);
      const schemas = dto.schemas ?? row?.schemas ?? ['public'];
      if (!row) {
        if (!dto.open) throw new ConflictException('该库尚未开放过申请');
        const id = randomUUID();
        [row] = await this.db.insert(dbCatalog).values({ id, assignmentId: a.id, instanceId: a.instanceId, dbName: a.dbName, ownerId: a.requesterId, openedBy: user.id, open: dto.open, schemas, creatorRole: a.dbUser, readRole: `eat-db-${id}-read`, writeRole: `eat-db-${id}-write` }).returning();
      }
      const schemasChanged = JSON.stringify(row.schemas) !== JSON.stringify(schemas);
      if ((dto.open && row.state !== 'active') || schemasChanged) {
        await this.db.update(dbCatalog).set({ state: 'pending', open: dto.open, error: null, schemas, openedBy: user.id, updatedAt: new Date() }).where(eq(dbCatalog.id, row.id));
        await this.executeOpen({ ...row, open: dto.open, schemas }, guard);
      } else {
        guard();
        await this.db.update(dbCatalog).set({ open: dto.open, ...(row.state !== 'active' ? { state: 'failed' as const, error: '开放申请已取消' } : {}), updatedAt: new Date() }).where(eq(dbCatalog.id, row.id));
      }
      await this.audit.record({ actorId: user.id, action: dto.open ? 'db_access.opened' : 'db_access.closed', targetType: 'db_catalog', targetId: row.id });
      return (await this.listCatalog(user)).find(c => c.id === row.id)!;
    });
  }
  async reapply(user: AuthUser, id: string): Promise<DbCatalogInfo> {
    const initial = await this.catalog(id);
    this.manage(user, initial.ownerId);
    return this.locked(initial.instanceId, async guard => {
      const row = await this.catalog(id);
      this.assertCatalogAvailable(row);
      this.manage(user, row.ownerId);
      guard();
      await this.db.update(dbCatalog).set({ state: 'pending', error: null, openedBy: user.id, updatedAt: new Date() }).where(eq(dbCatalog.id, id));
      await this.executeOpen(row, guard);
      await this.audit.record({ actorId: user.id, action: 'db_access.reapplied', targetType: 'db_catalog', targetId: id });
      return (await this.listCatalog(user)).find(c => c.id === id)!;
    });
  }
  private async desiredMembers(c: Catalog): Promise<ExpectedDbMember[]> {
    const grants = await this.db.select().from(dbAccessGrants).where(eq(dbAccessGrants.catalogId,c.id));
    const identities = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.instanceId,c.instanceId));
    return identities.map(i => {
      const g = grants.find(g=>g.userId===i.userId && g.state!=='revoked' && g.state!=='revoking');
      return { role: i.roleName, marker: `eat:db-personal-role:${i.id}`, groups: g ? [g.level==='write'?c.writeRole:c.readRole] : [] };
    });
  }
  private async inspectDrift(c: Catalog): Promise<DbAccessDrift> {
    return inspectPostgresAccess(await this.connection(c.instanceId,true),c,await this.desiredMembers(c));
  }
  async repair(user: AuthUser,id:string): Promise<DbAccessDrift> {
    if (user.role!=='admin') throw new ForbiddenException('仅管理员可按 EAT 记录修复');
    const initial=await this.catalog(id);
    return this.locked(initial.instanceId,async guard=> {
      const c=await this.catalog(id); this.assertCatalogAvailable(c); await this.assertInstanceAvailable(c.instanceId);
      const unfinished=await this.db.select().from(dbAccessGrants).where(and(eq(dbAccessGrants.catalogId,id),inArray(dbAccessGrants.state,['pending','failed','revoking'])));
      if (unfinished.length) throw new ConflictException('请先重试完成待执行、失败或撤销中的授权，再修复成员关系');
      try {
        const result=await repairPostgresAccess(await this.connection(c.instanceId),c,await this.desiredMembers(c),guard);
        guard(); await this.audit.record({ actorId:user.id, action:'db_access.repaired',targetType:'db_catalog',targetId:id,meta:{ result } });
        return result;
      } catch(e) {
        await this.audit.record({ actorId:user.id,action:'db_access.repair_failed',targetType:'db_catalog',targetId:id,meta:{ error:this.error(e) } });
        throw new ConflictException(`修复未完成，请核对后重试：${this.error(e)}`);
      }
    });
  }
  private async executeOpen(row: Catalog, guard: () => void): Promise<void> {
    try {
      const connection = await this.connection(row.instanceId);
      let publicCheck: DbPublicCheck | null = null;
      if (row.source === 'external') publicCheck = await openExternalPostgresAccess(connection, row, guard);
      else await openPostgresAccess(connection, row, guard);
      guard();
      await this.db.update(dbCatalog).set({ state: 'active', open: row.open, publicCheck, error: null, updatedAt: new Date() }).where(eq(dbCatalog.id, row.id));
    } catch (e) {
      guard();
      await this.db.update(dbCatalog).set({ state: 'failed', error: this.error(e), updatedAt: new Date() }).where(eq(dbCatalog.id, row.id));
    }
  }
  async listGrants(user: AuthUser, scope: 'visible' | 'mine' = 'visible'): Promise<DbAccessGrantInfo[]> {
    const rows = await this.db.select({ g: dbAccessGrants, c: dbCatalog, i: dbInstances, userName: users.name })
      .from(dbAccessGrants).innerJoin(dbCatalog, eq(dbCatalog.id, dbAccessGrants.catalogId))
      .innerJoin(dbInstances, eq(dbInstances.id, dbCatalog.instanceId)).innerJoin(users, eq(users.id, dbAccessGrants.userId))
      .where(scope === 'mine' ? eq(dbAccessGrants.userId, user.id) : user.role === 'admin' ? undefined : or(eq(dbAccessGrants.userId, user.id), eq(dbCatalog.ownerId, user.id)));
    return rows.map(({ g, c, i, userName }) => ({ id: g.id, catalogId: c.id, instanceId: i.id, instanceName: i.name, dbName: c.dbName, userId: g.userId, userName, level: g.level, state: g.state, error: g.error, canManage: user.role === 'admin' || c.ownerId === user.id, updatedAt: g.updatedAt.toISOString() }));
  }
  private async info(user: AuthUser, id: string): Promise<DbAccessGrantInfo> {
    return (await this.listGrants(user)).find(g => g.id === id)!;
  }
  async give(user: AuthUser, catalogId: string, dto: GrantDbAccessRequest, requestId?: string): Promise<DbAccessGrantInfo> {
    const initial = await this.catalog(catalogId);
    this.manage(user, initial.ownerId);
    return this.locked(initial.instanceId, async guard => {
      guard();
      const c = await this.catalog(catalogId);
      this.assertCatalogAvailable(c);
      await this.assertInstanceAvailable(c.instanceId);
      this.manage(user, c.ownerId);
      if (c.state !== 'active') throw new ConflictException('请先完成库的开放配置');
      if (c.assignmentId) {
        const [assignment] = await this.db.select().from(dbAssignments).where(eq(dbAssignments.id, c.assignmentId));
        if (!assignment || !['active', 'disabled'].includes(assignment.status)) throw new ConflictException('数据库已删除或不可用');
      }
      const [target] = await this.db.select().from(users).where(eq(users.id, dto.userId));
      if (!target || target.status !== 'active') throw new BadRequestException('请选择启用中的 EAT 用户');
      let [g] = await this.db.select().from(dbAccessGrants).where(and(eq(dbAccessGrants.catalogId, c.id), eq(dbAccessGrants.userId, target.id)));
      if (requestId && g?.state === 'active' && g.level === 'write' && dto.level === 'read') throw new ConflictException('申请人已持有读写权限，不能通过申请降级为只读');
      if (g?.state === 'revoking') throw new ConflictException('授权正在撤销，请先重试完成撤销');
      const alreadyActive = g?.state === 'active' && g.level === dto.level;
      g = await this.db.transaction(async tx => {
        if (!g) [g] = await tx.insert(dbAccessGrants).values({ catalogId: c.id, userId: target.id, level: dto.level, grantedBy: user.id }).returning();
        if (!alreadyActive) [g] = await tx.update(dbAccessGrants).set({ state: 'pending', level: dto.level, error: null, grantedBy: user.id, updatedAt: new Date() }).where(eq(dbAccessGrants.id, g.id)).returning();
        if (requestId) {
          const approved = await tx.execute(sql`UPDATE approval_request SET status='approved',execution=${alreadyActive ? 'active' : 'provisioning'},execution_error=NULL,decided_by=${user.id},decided_at=now(),details=details || jsonb_build_object('grantId',${g.id}::text) WHERE id=${requestId} AND status='pending' RETURNING id`);
          if (!approved.rowCount) throw new ConflictException('申请状态已变化');
          await tx.execute(sql`INSERT INTO approval_notification(request_id,event) VALUES(${requestId},'approved') ON CONFLICT DO NOTHING`);
        }
        return g;
      });
      await this.syncRequestExecution(g.id);
      if (alreadyActive) return this.info(user, g.id);
      await this.executeGrant(c, { ...g, level: dto.level, grantedBy: user.id }, guard);
      return this.info(user, g.id);
    });
  }
  private async executeGrant(c: Catalog, g: Grant, guard: () => void): Promise<void> {
    try {
      const [target] = await this.db.select().from(users).where(eq(users.id, g.userId));
      if (!target || target.status !== 'active') throw new Error('目标 EAT 用户已停用，不能授予个人权限');
      let [identity] = await this.db.select().from(dbPersonalRoles).where(and(eq(dbPersonalRoles.instanceId, c.instanceId), eq(dbPersonalRoles.userId, g.userId)));
      guard();
      if (!identity) [identity] = await this.db.insert(dbPersonalRoles).values({ instanceId: c.instanceId, userId: g.userId, roleName: `eat-${g.userId}`, passwordEncrypted: encryptSecret(randomBytes(24).toString('hex')) }).returning();
      await this.assertPersonalUserActive(identity.userId);
      if (identity.syncPending || !identity.loginEnabled) {
        if (!await this.applyPersonalStatus(identity, guard)) throw new ConflictException('个人数据库身份同步待完成，请稍后重试');
        [identity] = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.id, identity.id));
      }
      if (identity.pendingPasswordEncrypted) {
        if (!await this.applyPassword(identity, guard)) throw new ConflictException('个人密码重置待完成，请稍后重试');
        [identity] = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.id, identity.id));
      }
      await grantPostgresAccess(await this.connection(c.instanceId), c, g.level, { ...identity, password: decryptSecret(identity.passwordEncrypted) }, guard);
      guard();
      await this.db.update(dbPersonalRoles).set({ provisioned: true }).where(eq(dbPersonalRoles.id, identity.id));
      await this.db.update(dbAccessGrants).set({ state: 'active', error: null, updatedAt: new Date() }).where(eq(dbAccessGrants.id, g.id));
    } catch (e) {
      guard();
      await this.db.update(dbAccessGrants).set({ state: 'failed', error: this.error(e), updatedAt: new Date() }).where(eq(dbAccessGrants.id, g.id));
    }
    await this.syncRequestExecution(g.id);
    await this.audit.record({ actorId: g.grantedBy, action: 'db_access.granted', targetType: 'db_access_grant', targetId: g.id, meta: { userId: g.userId, level: g.level } });
  }
  private async syncRequestExecution(grantId?: string) {
    await this.db.execute(sql`UPDATE approval_request r SET execution=CASE g.state WHEN 'pending' THEN 'provisioning' ELSE g.state END,execution_error=g.error
      FROM db_access_grant g WHERE (${grantId ?? null}::uuid IS NULL OR g.id=${grantId ?? null}::uuid) AND r.type='db-access' AND r.status='approved' AND r.latest AND r.details->>'grantId'=g.id::text`);
  }
  private async ownActiveGrant(user: AuthUser, c: Catalog): Promise<Grant> {
    const [row] = await this.db.select({ g: dbAccessGrants }).from(dbAccessGrants).innerJoin(users, eq(users.id, dbAccessGrants.userId)).where(and(eq(dbAccessGrants.catalogId, c.id), eq(dbAccessGrants.userId, user.id), eq(dbAccessGrants.state, 'active'), eq(users.status, 'active')));
    const g = row?.g;
    if (!g) throw new ForbiddenException('只有授权持有人本人可读取或重置个人凭证，且授权必须已生效');
    return g;
  }
  private async assertPersonalUserActive(userId: string): Promise<void> {
    const [target] = await this.db.select({ status: users.status }).from(users).where(eq(users.id, userId));
    if (target?.status !== 'active') throw new ConflictException('目标 EAT 用户已停用，不能创建或启用个人身份');
  }
  private async personalIdentity(c: Catalog, g: Grant, guard: () => void): Promise<PersonalRole> {
    let [identity] = await this.db.select().from(dbPersonalRoles).where(and(eq(dbPersonalRoles.instanceId, c.instanceId), eq(dbPersonalRoles.userId, g.userId)));
    if (!identity) {
      guard();
      [identity] = await this.db.insert(dbPersonalRoles).values({ instanceId: c.instanceId, userId: g.userId, roleName: `eat-${g.userId}`, passwordEncrypted: encryptSecret(randomBytes(24).toString('hex')) }).returning();
    }
    // 先持久化身份，再检查用户状态：状态钩子一定能发现后续远端操作。
    await this.assertPersonalUserActive(identity.userId);
    if (identity.syncPending || !identity.loginEnabled) {
      if (!await this.applyPersonalStatus(identity, guard)) throw new ConflictException('个人数据库身份同步待完成，请稍后重试');
      [identity] = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.id, identity.id));
      if (identity.syncPending || !identity.loginEnabled) throw new ConflictException('个人数据库身份同步待完成，请稍后重试');
    }
    if (!identity.provisioned) {
      try {
        await grantPostgresAccess(await this.connection(c.instanceId), c, g.level, { ...identity, password: decryptSecret(identity.passwordEncrypted) }, guard);
        guard();
        [identity] = await this.db.update(dbPersonalRoles).set({ provisioned: true }).where(eq(dbPersonalRoles.id, identity.id)).returning();
      } catch (e) { throw new ConflictException(`个人身份创建待完成，请稍后重试：${this.error(e)}`); }
    }
    return identity;
  }
  /** pending密文先落平台，外部ALTER幂等重放；最后一次原子UPDATE才替换当前密码。 */
  private async applyPassword(identity: PersonalRole, guard: () => void): Promise<boolean> {
    if (!identity.pendingPasswordEncrypted) return true;
    try {
      await resetPostgresPersonalPassword(await this.connection(identity.instanceId), identity, decryptSecret(identity.pendingPasswordEncrypted), guard);
      guard();
      await this.db.update(dbPersonalRoles).set({ passwordEncrypted: identity.pendingPasswordEncrypted, pendingPasswordEncrypted: null, passwordError: null }).where(eq(dbPersonalRoles.id, identity.id));
      return true;
    } catch (e) {
      guard();
      await this.db.update(dbPersonalRoles).set({ passwordError: this.error(e) }).where(and(eq(dbPersonalRoles.id, identity.id), isNotNull(dbPersonalRoles.pendingPasswordEncrypted)));
      return false;
    }
  }
  async resetPassword(user: AuthUser, catalogId: string): Promise<DbPersonalPasswordReset> {
    const c = await this.catalog(catalogId);
    return this.locked(c.instanceId, async guard => {
      const g = await this.ownActiveGrant(user, c);
      let identity = await this.personalIdentity(c, g, guard);
      if (!identity.pendingPasswordEncrypted) {
        guard();
        try {
          [identity] = await this.db.update(dbPersonalRoles).set({ pendingPasswordEncrypted: encryptSecret(randomBytes(24).toString('hex')), passwordError: null }).where(eq(dbPersonalRoles.id, identity.id)).returning();
        } catch { throw new ConflictException('暂时无法保存新个人密码，密码尚未修改，请稍后重试'); }
      }
      const complete = await this.applyPassword(identity, guard);
      const [current] = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.id, identity.id));
      await this.audit.record({ actorId: user.id, action: 'db_access.password.reset', targetType: 'db_personal_role', targetId: identity.id, meta: { instanceId: c.instanceId, state: complete ? 'complete' : 'pending' } });
      return { instanceId: c.instanceId, state: complete ? 'complete' : 'pending', error: current.passwordError };
    });
  }
  async credentials(user: AuthUser, catalogId: string, ip?: string): Promise<DbAccessCredentials> {
    const c = await this.catalog(catalogId);
    return this.locked(c.instanceId, async guard => {
      const g = await this.ownActiveGrant(user, c);
      let identity = await this.personalIdentity(c, g, guard);
      if (identity.pendingPasswordEncrypted) {
        if (!await this.applyPassword(identity, guard)) throw new ConflictException('个人密码重置待完成，平台将自动重试；请稍后再读取凭证');
        [identity] = await this.db.select().from(dbPersonalRoles).where(eq(dbPersonalRoles.id, identity.id));
      }
      const i = await this.connection(c.instanceId);
      await this.audit.record({ actorId: user.id, actorTokenId: user.tokenId, action: 'db_access.credentials.read', targetType: 'db_access_grant', targetId: g.id, ip });
      const base = { engine: 'postgres' as const, host: i.host, port: i.port, database: c.dbName, user: identity.roleName, password: decryptSecret(identity.passwordEncrypted) };
      return { grantId: g.id, instanceId: c.instanceId, ...base, url: dbConnectionUrl(base) };
    });
  }
  private error(e: unknown): string {
    // Drizzle 包装错误含 SQL 参数；只呈现底层错误，避免把密文送到日志和客户端。
    const seen = new Set<unknown>();
    while (e instanceof Error && e.cause instanceof Error && !seen.has(e)) { seen.add(e); e = e.cause; }
    return (e instanceof Error ? e.message : String(e)).slice(0, 10000);
  }

  async revoke(user: AuthUser, id: string, reason: string, relinquish = false): Promise<DbAccessGrantInfo> {
    const initial = await this.grant(id);
    const c = await this.catalog(initial.catalogId);
    if (relinquish) {
      if (initial.userId !== user.id) throw new ForbiddenException('只能放弃自己的授权');
    } else this.manage(user, c.ownerId);
    return this.locked(c.instanceId, async guard => {
      guard();
      const g = await this.grant(id);
      // 撤销失败保留原撤销人和原因；重试不会把自助放弃变成管理员撤销。
      const actorId = g.state === 'revoking' ? g.revokedBy! : user.id;
      const why = g.state === 'revoking' ? g.revocationReason ?? '' : reason;
      await this.db.update(dbAccessGrants).set({ state: 'revoking', error: null, revokedBy: actorId, revocationReason: why, updatedAt: new Date() }).where(eq(dbAccessGrants.id, id));
      await this.executeRevoke(c, { ...g, revokedBy: actorId, revocationReason: why }, guard);
      return this.info(user, id);
    });
  }
  private async executeRevoke(c: Catalog, g: Grant, guard: () => void): Promise<void> {
    const actorId = g.revokedBy!;
    const why = g.revocationReason ?? '';
    try {
      const actual = await this.inspectDrift(c);
      guard();
      await this.audit.record({ actorId, action: 'db_access.revoke_checked', targetType: 'db_access_grant', targetId: g.id, meta: { actual } });
      const [identity] = await this.db.select().from(dbPersonalRoles).where(and(eq(dbPersonalRoles.instanceId, c.instanceId), eq(dbPersonalRoles.userId, g.userId)));
      guard();
      if (identity) await revokePostgresAccess(await this.connection(c.instanceId), c, identity, guard);
      guard();
      await this.db.update(dbAccessGrants).set({ state: 'revoked', error: null, updatedAt: new Date() }).where(eq(dbAccessGrants.id, g.id));
    } catch (e) {
      guard();
      await this.db.update(dbAccessGrants).set({ error: this.error(e), updatedAt: new Date() }).where(eq(dbAccessGrants.id, g.id));
      await this.syncRequestExecution(g.id);
      return;
    }
    await this.syncRequestExecution(g.id);
    await this.audit.record({ actorId, action: actorId === g.userId ? 'db_access.relinquished' : 'db_access.revoked', targetType: 'db_access_grant', targetId: g.id, meta: { reason: why } });
    if (actorId !== g.userId && g.state !== 'revoked') {
      const [actor] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
      this.notifier.notify(g.userId, 'approvalResult', 'db_access.revoked', {
        header: { template: 'orange', title: { tag: 'plain_text', content: '数据库授权已撤销' } },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: `数据库：${c.dbName}\n撤销人：${actor?.name ?? '已删除用户'}\n原因：${why || '未填写'}` } }],
      }, `数据库 ${c.dbName} 的授权已撤销`);
    }
  }
  async retry(user: AuthUser, id: string): Promise<DbAccessGrantInfo> {
    const g = await this.grant(id);
    if (g.state === 'revoking') return this.revoke(user, id, g.revocationReason ?? '', g.userId === user.id);
    if (g.state !== 'failed' && g.state !== 'pending') throw new ConflictException('仅未完成或执行失败的授权可重试');
    return this.give(user, g.catalogId, { userId: g.userId, level: g.level });
  }
}
