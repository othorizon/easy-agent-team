import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AccessRequestInfo, CreateAccessRequest, DecideAccessRequest } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { accessRequests, environments, envVariables, users, variableGrants } from '../db/schema';
import { EnvsService } from './envs.service';

@Injectable()
export class AccessRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly envs: EnvsService,
    private readonly audit: AuditService,
  ) {}

  private async toInfo(row: typeof accessRequests.$inferSelect): Promise<AccessRequestInfo> {
    const [requester] = await this.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, row.requesterId))
      .limit(1);
    const [env] = await this.db
      .select({ slug: environments.slug })
      .from(environments)
      .where(eq(environments.id, row.environmentId))
      .limit(1);
    return {
      id: row.id,
      requesterId: row.requesterId,
      requesterName: requester?.name ?? '(已删除)',
      environmentSlug: env?.slug ?? '(已删除)',
      keys: row.keys,
      reason: row.reason,
      status: row.status,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      grantExpiresAt: row.grantExpiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async create(user: AuthUser, dto: CreateAccessRequest): Promise<AccessRequestInfo> {
    const env = await this.envs.getEnvBySlug(dto.environmentSlug);
    // 只允许申请真实存在的变量，避免拼错 key 的无效申请
    const vars = await this.db
      .select({ key: envVariables.key })
      .from(envVariables)
      .where(and(eq(envVariables.environmentId, env.id), inArray(envVariables.key, dto.keys)));
    const existKeys = new Set(vars.map((v) => v.key));
    const missing = dto.keys.filter((k) => !existKeys.has(k));
    if (missing.length > 0) {
      throw new BadRequestException({
        error: 'NOT_FOUND',
        message: `以下变量在环境 ${env.slug} 中不存在：${missing.join(', ')}`,
      });
    }
    const [row] = await this.db
      .insert(accessRequests)
      .values({ requesterId: user.id, environmentId: env.id, keys: dto.keys, reason: dto.reason })
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: 'access_request.created',
      targetType: 'access_request',
      targetId: row.id,
      meta: { environment: env.slug, keys: dto.keys },
    });
    return this.toInfo(row);
  }

  /** 我发起的申请 */
  async listMine(user: AuthUser): Promise<AccessRequestInfo[]> {
    const rows = await this.db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.requesterId, user.id))
      .orderBy(desc(accessRequests.createdAt))
      .limit(100);
    return Promise.all(rows.map((r) => this.toInfo(r)));
  }

  /** 待我审批的申请（我 Own 的环境；管理员见全部） */
  async listInbox(user: AuthUser): Promise<AccessRequestInfo[]> {
    const pending = await this.db
      .select({ req: accessRequests, ownerId: environments.ownerId })
      .from(accessRequests)
      .innerJoin(environments, eq(accessRequests.environmentId, environments.id))
      .where(eq(accessRequests.status, 'pending'))
      .orderBy(desc(accessRequests.createdAt))
      .limit(100);
    const visible = pending.filter((p) => user.role === 'admin' || p.ownerId === user.id);
    return Promise.all(visible.map((p) => this.toInfo(p.req)));
  }

  async get(user: AuthUser, id: string): Promise<AccessRequestInfo> {
    const row = (
      await this.db.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1)
    )[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '申请不存在' });
    const env = (
      await this.db.select().from(environments).where(eq(environments.id, row.environmentId)).limit(1)
    )[0];
    const involved = row.requesterId === user.id || user.role === 'admin' || env?.ownerId === user.id;
    if (!involved) throw new ForbiddenException({ error: 'FORBIDDEN', message: '无权查看该申请' });
    return this.toInfo(row);
  }

  async decide(user: AuthUser, id: string, dto: DecideAccessRequest): Promise<AccessRequestInfo> {
    const row = (
      await this.db.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1)
    )[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '申请不存在' });
    if (row.status !== 'pending') {
      throw new ConflictException({ error: 'CONFLICT', message: '该申请已被处理' });
    }
    const env = (
      await this.db.select().from(environments).where(eq(environments.id, row.environmentId)).limit(1)
    )[0];
    if (!env) throw new NotFoundException({ error: 'NOT_FOUND', message: '环境已删除' });
    if (!(user.role === 'admin' || env.ownerId === user.id)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅环境 Owner 或管理员可审批' });
    }

    const grantExpiresAt = dto.grantExpiresAt ? new Date(dto.grantExpiresAt) : null;
    if (dto.decision === 'approved') {
      const vars = await this.db
        .select({ id: envVariables.id, key: envVariables.key })
        .from(envVariables)
        .where(and(eq(envVariables.environmentId, env.id), inArray(envVariables.key, row.keys)));
      for (const v of vars) {
        await this.db.insert(variableGrants).values({
          userId: row.requesterId,
          variableId: v.id,
          environmentId: null,
          grantedBy: user.id,
          expiresAt: grantExpiresAt,
        });
      }
    }
    const [updated] = await this.db
      .update(accessRequests)
      .set({ status: dto.decision, decidedBy: user.id, decidedAt: new Date(), grantExpiresAt })
      .where(eq(accessRequests.id, id))
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: 'access_request.decided',
      targetType: 'access_request',
      targetId: id,
      meta: { decision: dto.decision, environment: env.slug, keys: row.keys },
    });
    return this.toInfo(updated);
  }
}
