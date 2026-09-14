import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  AccessRequestHistoryQuery,
  AccessRequestHistoryResult,
  AccessRequestInfo,
  CreateAccessRequest,
  DecideAccessRequest,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { accessRequests, environments, envVariables, users, variableGrants } from '../db/schema';
import { EnvsService } from './envs.service';

/** 申请人与审批人都是 user 表，一条查询里要 join 两次，各起别名 */
const requester = alias(users, 'requester');
const decider = alias(users, 'decider');

type JoinedRow = {
  req: typeof accessRequests.$inferSelect;
  requesterName: string | null;
  environmentSlug: string | null;
  environmentOwnerId: string | null;
  deciderName: string | null;
};

@Injectable()
export class AccessRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly envs: EnvsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 申请 + 申请人 / 环境 / 审批人一次 join 出来：清单是分页的，逐行再去查名字会变成 N+1。
   * 申请人与环境都是级联删除的外键，left join 只是防御；审批人未处理时为 null。
   */
  private joined() {
    return this.db
      .select({
        req: accessRequests,
        requesterName: requester.name,
        environmentSlug: environments.slug,
        environmentOwnerId: environments.ownerId,
        deciderName: decider.name,
      })
      .from(accessRequests)
      .leftJoin(requester, eq(accessRequests.requesterId, requester.id))
      .leftJoin(environments, eq(accessRequests.environmentId, environments.id))
      .leftJoin(decider, eq(accessRequests.decidedBy, decider.id));
  }

  private toInfo(row: JoinedRow): AccessRequestInfo {
    const r = row.req;
    return {
      id: r.id,
      requesterId: r.requesterId,
      requesterName: row.requesterName ?? '(已删除)',
      environmentSlug: row.environmentSlug ?? '(已删除)',
      keys: r.keys,
      reason: r.reason,
      status: r.status,
      decidedBy: r.decidedBy,
      decidedByName: r.decidedBy ? (row.deciderName ?? '(已删除)') : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      grantExpiresAt: r.grantExpiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async loadOne(id: string): Promise<JoinedRow | undefined> {
    return (await this.joined().where(eq(accessRequests.id, id)).limit(1))[0];
  }

  /** 审批范围：管理员见全部，其他人只见自己 Own 的环境上的申请（inbox 与历史共用同一条规则） */
  private approverScope(user: AuthUser): SQL | undefined {
    return user.role === 'admin' ? undefined : eq(environments.ownerId, user.id);
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
    return this.toInfo((await this.loadOne(row.id))!);
  }

  /** 我发起的申请 */
  async listMine(user: AuthUser): Promise<AccessRequestInfo[]> {
    const rows = await this.joined()
      .where(eq(accessRequests.requesterId, user.id))
      .orderBy(desc(accessRequests.createdAt))
      .limit(100);
    return rows.map((r) => this.toInfo(r));
  }

  /** 待我审批的申请（我 Own 的环境；管理员见全部） */
  async listInbox(user: AuthUser): Promise<AccessRequestInfo[]> {
    const rows = await this.joined()
      .where(and(eq(accessRequests.status, 'pending'), this.approverScope(user)))
      .orderBy(desc(accessRequests.createdAt))
      .limit(100);
    return rows.map((r) => this.toInfo(r));
  }

  /**
   * 历史审批：我审批范围内**已处理**的申请（决策 45）。范围与 inbox 同一条规则——按环境归属而不是
   * 按「谁点的批准」，管理员替 Owner 批掉的申请，Owner 在自己环境的历史里同样看得到。
   * 按审批时间倒序、分页；`counts` 在范围内按结果分别计数，`status` 筛选不参与。
   */
  async listHistory(user: AuthUser, query: AccessRequestHistoryQuery): Promise<AccessRequestHistoryResult> {
    const scope = and(ne(accessRequests.status, 'pending'), this.approverScope(user));
    const grouped = await this.db
      .select({ status: accessRequests.status, n: count() })
      .from(accessRequests)
      .innerJoin(environments, eq(accessRequests.environmentId, environments.id))
      .where(scope)
      .groupBy(accessRequests.status);
    const counts = { approved: 0, rejected: 0 };
    for (const g of grouped) {
      if (g.status === 'approved' || g.status === 'rejected') counts[g.status] = Number(g.n);
    }
    const filtered = query.status === 'all' ? scope : and(scope, eq(accessRequests.status, query.status));
    const rows = await this.joined()
      .where(filtered)
      .orderBy(desc(accessRequests.decidedAt), desc(accessRequests.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      items: rows.map((r) => this.toInfo(r)),
      total: query.status === 'all' ? counts.approved + counts.rejected : counts[query.status],
      page: query.page,
      pageSize: query.pageSize,
      counts,
    };
  }

  async get(user: AuthUser, id: string): Promise<AccessRequestInfo> {
    const row = await this.loadOne(id);
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '申请不存在' });
    const involved =
      row.req.requesterId === user.id || user.role === 'admin' || row.environmentOwnerId === user.id;
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
    await this.db
      .update(accessRequests)
      .set({ status: dto.decision, decidedBy: user.id, decidedAt: new Date(), grantExpiresAt })
      .where(eq(accessRequests.id, id));
    await this.audit.record({
      actorId: user.id,
      action: 'access_request.decided',
      targetType: 'access_request',
      targetId: id,
      meta: { decision: dto.decision, environment: env.slug, keys: row.keys },
    });
    return this.toInfo((await this.loadOne(id))!);
  }
}
