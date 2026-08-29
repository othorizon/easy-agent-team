import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, ne } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { CreateDbAssignmentRequest, CreateDbInstanceRequest, DbAssignmentInfo, DbInstanceInfo } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { dbAssignments, dbInstances, environments, envVariables, users } from '../db/schema';
import { disablePostgres, enablePostgres, provisionPostgres, type AdminConn } from './provisioner';

type AssignmentRow = typeof dbAssignments.$inferSelect;
type InstanceRow = typeof dbInstances.$inferSelect;

@Injectable()
export class DbsService {
  private readonly logger = new Logger(DbsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------- 实例（管理员维护，成员可见基本信息用于发起申请） ----------

  async listInstances(): Promise<DbInstanceInfo[]> {
    const rows = await this.db
      .select({ instance: dbInstances, assignmentCount: count(dbAssignments.id) })
      .from(dbInstances)
      .leftJoin(dbAssignments, and(eq(dbAssignments.instanceId, dbInstances.id), ne(dbAssignments.status, 'deleted')))
      .groupBy(dbInstances.id);
    return rows.map((r) => ({
      id: r.instance.id,
      name: r.instance.name,
      engine: r.instance.engine,
      host: r.instance.host,
      port: r.instance.port,
      adminUser: r.instance.adminUser,
      note: r.instance.note,
      assignmentCount: Number(r.assignmentCount),
      createdAt: r.instance.createdAt.toISOString(),
    }));
  }

  async createInstance(user: AuthUser, dto: CreateDbInstanceRequest) {
    const [row] = await this.db
      .insert(dbInstances)
      .values({
        name: dto.name,
        engine: dto.engine,
        host: dto.host,
        port: dto.port,
        adminUser: dto.adminUser,
        adminPasswordEncrypted: encryptSecret(dto.adminPassword),
        note: dto.note,
        createdBy: user.id,
      })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'db_instance.created', targetType: 'db_instance', targetId: row.id });
    return { id: row.id };
  }

  async removeInstance(user: AuthUser, id: string) {
    const [{ active }] = await this.db
      .select({ active: count(dbAssignments.id) })
      .from(dbAssignments)
      .where(and(eq(dbAssignments.instanceId, id), eq(dbAssignments.status, 'active')));
    if (Number(active) > 0) {
      throw new ConflictException({ error: 'CONFLICT', message: '实例上仍有 active 的分配，先回收再删除' });
    }
    await this.db.delete(dbInstances).where(eq(dbInstances.id, id));
    await this.audit.record({ actorId: user.id, action: 'db_instance.deleted', targetType: 'db_instance', targetId: id });
    return { ok: true };
  }

  private async getInstance(id: string): Promise<InstanceRow> {
    const row = (await this.db.select().from(dbInstances).where(eq(dbInstances.id, id)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '数据库实例不存在' });
    return row;
  }

  private adminConn(instance: InstanceRow): AdminConn {
    return {
      host: instance.host,
      port: instance.port,
      adminUser: instance.adminUser,
      adminPassword: decryptSecret(instance.adminPasswordEncrypted),
    };
  }

  // ---------- 分配 ----------

  private async toInfo(row: AssignmentRow): Promise<DbAssignmentInfo> {
    const instance = (await this.db.select().from(dbInstances).where(eq(dbInstances.id, row.instanceId)).limit(1))[0];
    const [requester] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.requesterId));
    const env = row.environmentId
      ? (await this.db.select({ slug: environments.slug }).from(environments).where(eq(environments.id, row.environmentId)).limit(1))[0]
      : undefined;
    return {
      id: row.id,
      instanceName: instance?.name ?? '(已删除)',
      engine: instance?.engine ?? 'postgres',
      dbName: row.dbName,
      dbUser: row.dbUser,
      purpose: row.purpose,
      status: row.status,
      requesterId: row.requesterId,
      requesterName: requester?.name ?? '(已删除)',
      environmentSlug: env?.slug ?? null,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async createAssignment(user: AuthUser, dto: CreateDbAssignmentRequest): Promise<DbAssignmentInfo> {
    await this.getInstance(dto.instanceId);
    const dbUser = `u_${dto.dbName}`.slice(0, 31);
    const exists = await this.db
      .select({ id: dbAssignments.id })
      .from(dbAssignments)
      .where(and(eq(dbAssignments.instanceId, dto.instanceId), eq(dbAssignments.dbName, dto.dbName)))
      .limit(1);
    if (exists.length > 0) {
      throw new ConflictException({ error: 'CONFLICT', message: `该实例上库名 ${dto.dbName} 已被占用` });
    }
    const [row] = await this.db
      .insert(dbAssignments)
      .values({ instanceId: dto.instanceId, requesterId: user.id, dbName: dto.dbName, dbUser, purpose: dto.purpose })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'db_assignment.requested', targetType: 'db_assignment', targetId: row.id, meta: { dbName: dto.dbName } });
    return this.toInfo(row);
  }

  // 已删除的分配不再出现在列表里（记录保留在库中供审计追溯）

  async listMine(user: AuthUser): Promise<DbAssignmentInfo[]> {
    const rows = await this.db
      .select()
      .from(dbAssignments)
      .where(and(eq(dbAssignments.requesterId, user.id), ne(dbAssignments.status, 'deleted')))
      .orderBy(desc(dbAssignments.createdAt));
    return Promise.all(rows.map((r) => this.toInfo(r)));
  }

  async listAll(): Promise<DbAssignmentInfo[]> {
    const rows = await this.db
      .select()
      .from(dbAssignments)
      .where(ne(dbAssignments.status, 'deleted'))
      .orderBy(desc(dbAssignments.createdAt))
      .limit(200);
    return Promise.all(rows.map((r) => this.toInfo(r)));
  }

  private async getAssignment(id: string): Promise<AssignmentRow> {
    const row = (await this.db.select().from(dbAssignments).where(eq(dbAssignments.id, id)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '分配记录不存在' });
    return row;
  }

  /** 批准：在实例上真实建库建号，并把凭证生成为环境（Owner=申请人） */
  async approve(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== 'pending') throw new ConflictException({ error: 'CONFLICT', message: '仅 pending 的申请可批准' });
    const instance = await this.getInstance(row.instanceId);
    if (instance.engine !== 'postgres') {
      throw new BadRequestException({
        error: 'NOT_SUPPORTED',
        message: 'MySQL 实例暂不支持自动执行（后续版本提供），请先使用 postgres 实例',
      });
    }
    const password = randomBytes(18).toString('hex');
    try {
      await provisionPostgres(this.adminConn(instance), row.dbName, row.dbUser, password);
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await this.db.update(dbAssignments).set({ status: 'failed', error: message, decidedBy: user.id, updatedAt: new Date() }).where(eq(dbAssignments.id, id));
      this.logger.warn(`建库失败(${row.dbName}): ${message}`);
      return this.toInfo(await this.getAssignment(id));
    }

    // 凭证 → 环境（复用环境变量的授权/拉取/审计通道），Owner=申请人便于自助共享
    let slug = `db-${row.dbName.replace(/_/g, '-')}`;
    const slugTaken = await this.db.select({ id: environments.id }).from(environments).where(eq(environments.slug, slug)).limit(1);
    if (slugTaken.length > 0) slug = `${slug}-${row.id.slice(0, 4)}`;
    const [env] = await this.db
      .insert(environments)
      .values({
        slug,
        name: `数据库 ${row.dbName}`,
        description: `实例「${instance.name}」上为项目分配的库（用途：${row.purpose}）。连接凭证见变量，eat env pull ${slug} 获取。`,
        ownerId: row.requesterId,
        source: 'db_assignment',
      })
      .returning();
    // 仅密码敏感（加密存储、读取落审计）；主机/端口/库名/账号非敏感（明文存储、有权限者平台上直接明文可见）。读值授权不变：默认仅申请人（环境 Owner）可读
    const vars: Array<[string, string, string, boolean]> = [
      ['DB_HOST', instance.host, '数据库主机', false],
      ['DB_PORT', String(instance.port), '数据库端口', false],
      ['DB_NAME', row.dbName, '库名', false],
      ['DB_USER', row.dbUser, '专属账号（权限限定在本库）', false],
      ['DB_PASSWORD', password, '账号密码（平台生成，读取受审计）', true],
    ];
    for (const [key, value, description, secret] of vars) {
      await this.db.insert(envVariables).values({
        environmentId: env.id,
        key,
        valueEncrypted: secret ? encryptSecret(value) : null,
        valuePlain: secret ? null : value,
        secret,
        description,
      });
    }
    await this.db
      .update(dbAssignments)
      .set({ status: 'active', environmentId: env.id, error: null, decidedBy: user.id, updatedAt: new Date() })
      .where(eq(dbAssignments.id, id));
    await this.audit.record({
      actorId: user.id,
      action: 'db_assignment.provisioned',
      targetType: 'db_assignment',
      targetId: id,
      meta: { dbName: row.dbName, environment: slug },
    });
    return this.toInfo(await this.getAssignment(id));
  }

  async reject(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== 'pending') throw new ConflictException({ error: 'CONFLICT', message: '仅 pending 的申请可驳回' });
    await this.db.update(dbAssignments).set({ status: 'rejected', decidedBy: user.id, updatedAt: new Date() }).where(eq(dbAssignments.id, id));
    await this.audit.record({ actorId: user.id, action: 'db_assignment.rejected', targetType: 'db_assignment', targetId: id });
    return this.toInfo(await this.getAssignment(id));
  }

  /** 禁用账号（可恢复）：ALTER ROLE NOLOGIN + 断开现有连接 */
  async disable(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== 'active') throw new ConflictException({ error: 'CONFLICT', message: '仅 active 的分配可禁用' });
    const instance = await this.getInstance(row.instanceId);
    await disablePostgres(this.adminConn(instance), row.dbName, row.dbUser);
    await this.db.update(dbAssignments).set({ status: 'disabled', decidedBy: user.id, updatedAt: new Date() }).where(eq(dbAssignments.id, id));
    await this.audit.record({ actorId: user.id, action: 'db_assignment.disabled', targetType: 'db_assignment', targetId: id });
    return this.toInfo(await this.getAssignment(id));
  }

  async enable(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== 'disabled') throw new ConflictException({ error: 'CONFLICT', message: '仅 disabled 的分配可恢复' });
    const instance = await this.getInstance(row.instanceId);
    await enablePostgres(this.adminConn(instance), row.dbUser);
    await this.db.update(dbAssignments).set({ status: 'active', decidedBy: user.id, updatedAt: new Date() }).where(eq(dbAssignments.id, id));
    return this.toInfo(await this.getAssignment(id));
  }

  /** 删除（仅记录级，决策 13）：标记 deleted 并删除凭证环境；实例上的数据库与账号不做物理删除，需管理员在实例上手动清理 */
  async remove(user: AuthUser, id: string): Promise<DbAssignmentInfo> {
    const row = await this.getAssignment(id);
    if (row.status !== 'active' && row.status !== 'disabled' && row.status !== 'failed' && row.status !== 'rejected') {
      throw new ConflictException({ error: 'CONFLICT', message: '仅 active/disabled/failed/rejected 的分配可删除' });
    }
    if (row.environmentId) {
      await this.db.delete(environments).where(eq(environments.id, row.environmentId));
    }
    await this.db.update(dbAssignments).set({ status: 'deleted', environmentId: null, decidedBy: user.id, updatedAt: new Date() }).where(eq(dbAssignments.id, id));
    await this.audit.record({ actorId: user.id, action: 'db_assignment.deleted', targetType: 'db_assignment', targetId: id, meta: { dbName: row.dbName, physicalDrop: false } });
    return this.toInfo(await this.getAssignment(id));
  }
}
