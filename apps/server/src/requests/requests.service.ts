import { AuditService } from '../audit/audit.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import {
  requestDecisionSchema,
  type ApprovalRequest,
  type ApprovalRequestDetail,
  type ApprovalRequestPage,
  type RequestDecision,
  type RequestListQuery,
} from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { PG_POOL } from '../db/db.module';
import { RequestTypes } from './request-types';

@Injectable()
export class RequestsService {
  private readonly lockPool: Pool;
  async onModuleDestroy() {
    await this.lockPool.end();
  }
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly types: RequestTypes,
  ) {
    this.lockPool = new Pool({ ...pool.options, max: 4 });
    this.lockPool.on('error', () => undefined);
  }

  private info(r: any, user: AuthUser): ApprovalRequest {
    return {
      presentation: this.types.present(r).presentation,
      id: r.id,
      type: r.type,
      sourceId: r.source_id,
      resourceId: r.resource_id,
      requesterId: r.requester_id,
      requesterName: r.requester_name,
      targetName: r.target_name,
      resourceUrl: r.resource_url,
      reason: r.reason,
      status: r.status,
      rejectionReason: r.rejection_reason,
      closedReason: r.closed_reason,
      execution: r.execution,
      executionError: r.execution_error,
      decidedByName: r.decided_by_name ?? null,
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null,
      round: r.round,
      latest: r.latest,
      details: this.types.present(r).details,
      canApprove: !!r.can_approve && r.status === 'pending',
      canWithdraw: r.requester_id === user.id && r.status === 'pending',
      canResubmit:
        r.requester_id === user.id &&
        r.latest &&
        r.resource_exists &&
        (['rejected', 'withdrawn'].includes(r.status) || (this.types.get(r.type).resubmittable?.(r) ?? false)),
      canRemind:
        r.requester_id === user.id &&
        r.status === 'pending' &&
        (!r.reminded_at || Date.now() - r.reminded_at.getTime() > 86400000),
      notificationError: r.notification_error,
    };
  }

  /** Invalidate stale work without inferring a refusal from an external API failure. */
  async reconcile() {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const invalidReason = this.types.expression('invalidReason');
      const { rows: invalidated } = await c.query(`UPDATE approval_request r SET status='invalid',closed_reason=CASE
        WHEN NOT EXISTS(SELECT 1 FROM "user" WHERE id=r.requester_id AND status='active') THEN '申请人已停用或删除'
        ELSE (${invalidReason}) END,decided_at=now()
        WHERE status='pending' AND (NOT EXISTS(SELECT 1 FROM "user" WHERE id=r.requester_id AND status='active') OR (${invalidReason}) IS NOT NULL) RETURNING type,source_id`);
      for (const type of this.types.all()) {
        const ids = invalidated.filter(row => row.type === type.type).map(row => row.source_id);
        if (ids.length) await type.invalidated?.(c, ids);
      }
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }

  async list(user: AuthUser, q: Omit<RequestListQuery, 'type'> & { type?: string }): Promise<ApprovalRequestPage> {
    await this.reconcile();
    const values: unknown[] = [user.id, user.role];
    const bind = (v: unknown) => {
      values.push(v);
      return '$' + values.length;
    };
    const filters = [
      '$2::text IS NOT NULL',
      this.types.visible(),
      q.scope === 'mine' ? 'r.requester_id=$1' : q.scope === 'resource' ? this.types.scope() : this.types.approver(),
      q.scope === 'history'
        ? `NOT EXISTS(SELECT 1 FROM approval_request newer WHERE newer.group_key=r.group_key AND newer.round>r.round AND newer.status<>'pending')`
        : 'r.latest',
    ];
    if (q.scope === 'inbox') filters.push(`r.status='pending'`);
    if (q.scope === 'history') filters.push(`r.status<>'pending'`);
    if (q.type) filters.push(`r.type=${bind(q.type)}`);
    if (q.sourceId) filters.push(`r.source_id=${bind(q.sourceId)}`);
    if (q.resourceId) filters.push(`r.resource_id=${bind(q.resourceId)}`);
    if (q.status === 'ongoing')
      filters.push(`(r.status='pending' OR r.status='approved' AND r.execution IN ('provisioning','failed'))`);
    else if (q.status !== 'all') filters.push(`r.status=${bind(q.status)}`);
    if (q.days && q.scope !== 'inbox')
      filters.push(`coalesce(r.decided_at,r.created_at)>=now()-${bind(q.days)}::int*interval '1 day'`);
    if (q.q)
      filters.push(
        `(r.target_name ILIKE ${bind('%' + q.q.replace(/[\\%_]/g, '\\$&') + '%')} OR u.name ILIKE $${values.length} OR r.reason ILIKE $${values.length})`,
      );
    const where = filters.join(' AND ');
    const {
      rows: [count],
    } = await this.pool.query(
      `SELECT count(*)::int total FROM approval_request r LEFT JOIN "user" u ON u.id=r.requester_id WHERE ${where}`,
      values,
    );
    const { rows } = await this.pool.query(
      `${this.types.select()} WHERE ${where} ORDER BY coalesce(r.decided_at,r.created_at) DESC,r.id DESC LIMIT ${bind(q.pageSize)} OFFSET ${bind((q.page - 1) * q.pageSize)}`,
      values,
    );
    const {
      rows: [pending],
    } = await this.pool.query(`SELECT count(*)::int n FROM approval_request r WHERE status='pending' AND ${this.types.approver()}`, [
      user.id,
      user.role,
    ]);
    return {
      items: rows.map((r) => this.info(r, user)),
      total: count.total,
      page: q.page,
      pageSize: q.pageSize,
      pendingCount: pending.n,
      types: Object.fromEntries(this.types.all().map(type => [type.type, type.label])),
    };
  }

  private async row(user: AuthUser, id: string, db: Pool | PoolClient = this.pool) {
    const {
      rows: [r],
    } = await db.query(`${this.types.select()} WHERE r.id=$3 AND ${this.types.scope()}`, [user.id, user.role, id]);
    if (!r) throw new NotFoundException('申请不存在或无权查看');
    return r;
  }
  async get(user: AuthUser, id: string): Promise<ApprovalRequestDetail> {
    await this.reconcile();
    const r = await this.row(user, id);
    const { rows } = await this.pool.query(`${this.types.select()} WHERE r.group_key=$3 AND ${this.types.scope()} ORDER BY r.round DESC`, [
      user.id,
      user.role,
      r.group_key,
    ]);
    const request = this.info(r, user);
    const details = await this.types.get(r.type).loadDetails?.(r, user);
    if (details) request.details = { ...request.details, ...details };
    return { request, rounds: rows.map((x) => this.info(x, user)) };
  }
  private async locked<T>(user: AuthUser, id: string, fn: (r: any, c: PoolClient) => Promise<T>): Promise<T> {
    await this.reconcile();
    const first = await this.row(user, id);
    const c = await this.lockPool.connect();
    let held = false,
      lost = false;
    const onError = () => {
      lost = true;
    };
    c.on('error', onError);
    try {
      held = (
        await c.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok`, ['approval-action:' + first.group_key])
      ).rows[0].ok;
      if (!held) throw new ConflictException('该申请正在处理中，请稍后刷新');
      const r = await this.row(user, id, c);
      const {
        rows: [actor],
      } = await c.query('SELECT status,role FROM "user" WHERE id=$1', [user.id]);
      if (!actor || actor.status !== 'active' || actor.role !== user.role)
        throw new ForbiddenException('账户权限已变化，请重新登录');
      return await fn(r, c);
    } finally {
      if (held && !lost)
        await c
          .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['approval-action:' + first.group_key])
          .catch(() => {
            lost = true;
          });
      c.off('error', onError);
      c.release(lost);
    }
  }

  private async runAction(type: string, kind: 'approve' | 'reject' | 'withdraw' | 'resubmit' | 'remind', work: (guard: () => void) => Promise<void>) {
    const guard = this.types.get(type).runAction;
    return guard ? guard(kind, work) : work(() => {});
  }
  async decide(user: AuthUser, id: string, input: RequestDecision) {
    const parsed = requestDecisionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const dto = parsed.data;
    await this.locked(user, id, async (r, c) => {
      if (!r.can_approve) throw new ForbiddenException('无权审批该申请');
      if (r.status !== 'pending') throw new ConflictException('该申请已处理，请刷新');
      const type = this.types.get(r.type);
      const action = { row: r, client: c, user, decision: dto };
      await this.runAction(r.type, dto.decision === 'approved' ? 'approve' : 'reject', async guard => {
        if (dto.decision === 'rejected') {
          await c.query('BEGIN');
          try {
            await type.reject(action);
            guard();
            await c.query('COMMIT');
          } catch (error) { await c.query('ROLLBACK'); throw error; }
          await type.afterReject?.(action);
        } else {
          if (r.approval_blocker) throw new ConflictException(r.approval_blocker);
          await type.approve(action);
        }
      });
    });
    await this.audit.record({
      actorId: user.id,
      action: 'request.decided',
      targetType: 'approval_request',
      targetId: id,
      meta: { decision: dto.decision },
    });
    return this.get(user, id);
  }
  async decideSource(user: AuthUser, type: string, sourceId: string, dto: RequestDecision) {
    const {
      rows: [r],
    } = await this.pool.query(
      'SELECT id FROM approval_request WHERE type=$1 AND source_id=$2 AND latest ORDER BY created_at DESC,id DESC LIMIT 1',
      [type, sourceId],
    );
    if (!r) throw new NotFoundException('申请不存在，请先提交申请');
    const {
      rows: [permission],
    } = await this.pool.query(`SELECT ${this.types.approver()} allowed FROM approval_request r WHERE id=$3`, [
      user.id,
      user.role,
      r.id,
    ]);
    if (!permission?.allowed) throw new ForbiddenException('无权审批该申请');
    return this.decide(user, r.id, dto);
  }
  async withdraw(user: AuthUser, id: string) {
    await this.locked(user, id, async (r, c) => {
      if (r.requester_id !== user.id) throw new ForbiddenException('只能撤回自己的申请');
      if (r.status !== 'pending') throw new ConflictException('仅待审批申请可撤回');
      await this.runAction(r.type, 'withdraw', async guard => {
        await c.query('BEGIN');
        try {
          await c.query(
            `UPDATE approval_request SET status='withdrawn',closed_reason='申请人主动撤回',decided_at=now() WHERE id=$1`,
            [id],
          );
          await this.types.get(r.type).withdraw({ row: r, client: c, user, decision: { decision: 'rejected' } });
          guard();
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      });
    });
    return this.get(user, id);
  }
  async resubmit(user: AuthUser, id: string, reason: string) {
    let nextId = id;
    await this.locked(user, id, async (r, c) => {
      if (!this.info(r, user).canResubmit) throw new ConflictException('该申请不可重新提交，请查看最新记录');
      await this.runAction(r.type, 'resubmit', async guard => {
        await c.query('BEGIN');
        try {
          await this.types.get(r.type).resubmit({ row: r, client: c, user, decision: { decision: 'approved' }, reason });
          const {
            rows: [next],
          } = await c.query('SELECT id FROM approval_request WHERE group_key=$1 AND latest', [r.group_key]);
          nextId = next.id;
          guard();
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      });
    });
    return this.get(user, nextId);
  }
  async remind(user: AuthUser, id: string) {
    await this.locked(user, id, async (r, c) => {
      if (!this.info(r, user).canRemind) throw new ConflictException('仅自己的待审批申请可提醒，每 24 小时一次');
      await this.runAction(r.type, 'remind', async guard => {
        await c.query('BEGIN');
        try {
          await c.query('UPDATE approval_request SET reminded_at=now() WHERE id=$1', [id]);
          await c.query(
            `INSERT INTO approval_notification(request_id,event) VALUES($1,'reminder') ON CONFLICT(request_id,event) DO UPDATE SET state='pending',retry_at=now(),attempts=0,sent_to='[]'`,
            [id],
          );
          guard();
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      });
    });
    return this.get(user, id);
  }
}
