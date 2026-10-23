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
import { AccessRequestsService } from '../envs/access-requests.service';
import { McpConfigsService } from '../mcp-configs/mcp-configs.service';
import { DbsService } from '../dbs/dbs.service';
import { OssService } from '../oss/oss.service';
import { AppsService } from '../deploy/apps.service';

// Current resource owners, not a stale snapshot, decide who may approve/read.
const OWNER = `CASE r.type WHEN 'env' THEN coalesce((SELECT owner_id FROM environment WHERE id=r.resource_id),r.owner_id)
 WHEN 'mcp' THEN coalesce((SELECT owner_id FROM mcp_config WHERE id=r.resource_id),r.owner_id) ELSE NULL END`;
const ENV_VISIBLE = `(r.type<>'env' OR NOT EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id AND visibility='private' AND owner_id<>$1))`;
const SCOPE = `(${ENV_VISIBLE} AND (r.requester_id=$1 OR $2='admin' OR ${OWNER}=$1))`;
const APPROVER = `(${ENV_VISIBLE} AND ($2='admin' OR ${OWNER}=$1))`;
const SELECT = `SELECT r.*,coalesce(u.name,'已删除用户') requester_name,d.name decided_by_name,
 ${APPROVER} can_approve,
 CASE r.type WHEN 'env' THEN EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id)
 WHEN 'mcp' THEN EXISTS(SELECT 1 FROM mcp_config WHERE id=r.resource_id AND visibility='team')
 WHEN 'db' THEN EXISTS(SELECT 1 FROM db_assignment WHERE id=r.source_id AND status IN ('rejected','withdrawn'))
 WHEN 'oss' THEN EXISTS(SELECT 1 FROM oss_space WHERE id=r.source_id AND status IN ('rejected','withdrawn'))
 ELSE EXISTS(SELECT 1 FROM app WHERE id=r.resource_id AND owner_id=r.requester_id AND repo_version=(r.details->>'repoVersion')::int)
 END resource_exists FROM approval_request r LEFT JOIN "user" u ON u.id=r.requester_id
 LEFT JOIN "user" d ON d.id=r.decided_by`;
const SOURCE_TABLE = {
  env: 'access_request',
  mcp: 'mcp_subscription',
  db: 'db_assignment',
  oss: 'oss_space',
  app: 'app',
} as const;

@Injectable()
export class RequestsService {
  private readonly lockPool: Pool;
  async onModuleDestroy() {
    await this.lockPool.end();
  }
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly env: AccessRequestsService,
    private readonly mcp: McpConfigsService,
    private readonly audit: AuditService,
    private readonly dbs: DbsService,
    private readonly oss: OssService,
    private readonly apps: AppsService,
  ) {
    this.lockPool = new Pool({ ...pool.options, max: 4 });
    this.lockPool.on('error', () => undefined);
  }

  private info(r: any, user: AuthUser): ApprovalRequest {
    return {
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
      details: r.details,
      canApprove: !!r.can_approve && r.status === 'pending',
      canWithdraw: r.requester_id === user.id && r.status === 'pending',
      canResubmit:
        r.requester_id === user.id &&
        r.latest &&
        r.resource_exists &&
        (['rejected', 'withdrawn'].includes(r.status) || (r.type === 'app' && r.execution === 'revoked')),
      canRemind:
        r.requester_id === user.id &&
        r.status === 'pending' &&
        (!r.reminded_at || Date.now() - r.reminded_at.getTime() > 86400000),
      notificationError: r.notification_error,
    };
  }

  /** Invalidate stale work without inferring a refusal from an external API failure. */
  async reconcile() {
    await this.pool
      .query(`WITH invalidated AS (UPDATE approval_request r SET status='invalid',closed_reason=CASE
        WHEN NOT EXISTS(SELECT 1 FROM "user" WHERE id=r.requester_id AND status='active') THEN '申请人已停用或删除'
        WHEN type='env' AND NOT EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id) THEN '环境已删除'
        WHEN type='env' AND EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id AND visibility='private') THEN '环境已设为私有'
        WHEN type='env' THEN '申请的变量已删除或变化'
        WHEN type='mcp' THEN 'MCP 配置已删除'
        WHEN type='db' THEN '数据库实例已删除'
        WHEN type='oss' THEN '存储空间已删除'
        WHEN NOT EXISTS(SELECT 1 FROM app WHERE id=r.resource_id) THEN '应用已删除'
        ELSE '应用已更换仓库' END,decided_at=now()
      WHERE status='pending' AND (NOT EXISTS(SELECT 1 FROM "user" WHERE id=r.requester_id AND status='active')
      OR (type='env' AND (EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id AND visibility='private') OR NOT EXISTS(SELECT 1 FROM environment WHERE id=r.resource_id) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.details->'keys') requested(key) WHERE NOT EXISTS(SELECT 1 FROM env_variable v WHERE v.environment_id=r.resource_id AND v.key=requested.key))))
      OR (type='mcp' AND NOT EXISTS(SELECT 1 FROM mcp_config WHERE id=r.resource_id))
      OR (type='db' AND NOT EXISTS(SELECT 1 FROM db_instance WHERE id=r.resource_id))
      OR (type='oss' AND NOT EXISTS(SELECT 1 FROM oss_space WHERE id=r.resource_id))
      OR (type='app' AND NOT EXISTS(SELECT 1 FROM app WHERE id=r.resource_id AND repo_version=(r.details->>'repoVersion')::int))) RETURNING type,source_id)
      UPDATE access_request a SET status='invalid' FROM invalidated i WHERE i.type='env' AND a.id=i.source_id AND a.status='pending'`);
  }

  async list(user: AuthUser, q: RequestListQuery): Promise<ApprovalRequestPage> {
    await this.reconcile();
    const values: unknown[] = [user.id, user.role];
    const bind = (v: unknown) => {
      values.push(v);
      return '$' + values.length;
    };
    const filters = [
      '$2::text IS NOT NULL',
      ENV_VISIBLE,
      q.scope === 'mine' ? 'r.requester_id=$1' : q.scope === 'resource' ? SCOPE : APPROVER,
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
      `${SELECT} WHERE ${where} ORDER BY coalesce(r.decided_at,r.created_at) DESC,r.id DESC LIMIT ${bind(q.pageSize)} OFFSET ${bind((q.page - 1) * q.pageSize)}`,
      values,
    );
    const {
      rows: [pending],
    } = await this.pool.query(`SELECT count(*)::int n FROM approval_request r WHERE status='pending' AND ${APPROVER}`, [
      user.id,
      user.role,
    ]);
    return {
      items: rows.map((r) => this.info(r, user)),
      total: count.total,
      page: q.page,
      pageSize: q.pageSize,
      pendingCount: pending.n,
    };
  }

  private async row(user: AuthUser, id: string, db: Pool | PoolClient = this.pool) {
    const {
      rows: [r],
    } = await db.query(`${SELECT} WHERE r.id=$3 AND ${SCOPE}`, [user.id, user.role, id]);
    if (!r) throw new NotFoundException('申请不存在或无权查看');
    return r;
  }
  async get(user: AuthUser, id: string): Promise<ApprovalRequestDetail> {
    await this.reconcile();
    const r = await this.row(user, id);
    const { rows } = await this.pool.query(`${SELECT} WHERE r.group_key=$3 AND ${SCOPE} ORDER BY r.round DESC`, [
      user.id,
      user.role,
      r.group_key,
    ]);
    return { request: this.info(r, user), rounds: rows.map((x) => this.info(x, user)) };
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

  async decide(user: AuthUser, id: string, input: RequestDecision) {
    const parsed = requestDecisionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const dto = parsed.data;
    await this.locked(user, id, async (r, c) => {
      if (!r.can_approve) throw new ForbiddenException('无权审批该申请');
      if (r.status !== 'pending') throw new ConflictException('该申请已处理，请刷新');
      if (dto.decision === 'rejected') {
        // Persist both the business state and rejection snapshot in one transaction.
        await c.query('BEGIN');
        try {
          if (r.type === 'app') {
            await c.query(
              `UPDATE approval_request SET status='rejected',rejection_reason=$2,decided_by=$3,decided_at=now() WHERE id=$1`,
              [id, dto.reason, user.id],
            );
            await c.query(
              `INSERT INTO approval_notification(request_id,event) VALUES($1,'rejected') ON CONFLICT DO NOTHING`,
              [id],
            );
          } else {
            const table = SOURCE_TABLE[r.type as keyof typeof SOURCE_TABLE];
            const extra = ['env', 'mcp'].includes(r.type) ? ',decided_at=now()' : ',updated_at=now()';
            const result = await c.query(
              `UPDATE ${table} SET status='rejected',rejection_reason=$2,decided_by=$3${extra} WHERE id=$1 AND status='pending' RETURNING id`,
              [r.source_id, dto.reason, user.id],
            );
            if (!result.rowCount) throw new ConflictException('申请状态已变化');
          }
          await c.query('COMMIT');
          const legacy = {
            env: ['access_request.decided', 'access_request'],
            mcp: ['mcp_config.subscription_decided', 'mcp_config'],
            db: ['db_assignment.rejected', 'db_assignment'],
            oss: ['oss_space.reject', 'oss_space'],
          }[r.type as 'env' | 'mcp' | 'db' | 'oss'];
          if (legacy)
            await this.audit.record({
              actorId: user.id,
              action: legacy[0],
              targetType: legacy[1],
              targetId: r.type === 'mcp' ? r.resource_id : r.source_id,
              meta: { decision: 'rejected' },
            });
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      } else {
        // Existing domain services remain the authority for grants / provisioning.
        if (r.type === 'env')
          await this.env.decide(user, r.source_id, { decision: 'approved', grantExpiresAt: dto.grantExpiresAt });
        if (r.type === 'mcp') await this.mcp.decide(user, r.source_id, { decision: 'approved' });
        if (r.type === 'db') await this.dbs.approve(user, r.source_id);
        if (r.type === 'oss') await this.oss.decide(user, r.source_id, 'approve');
        if (r.type === 'app') {
          const {
            rows: [a],
          } = await c.query('SELECT slug,repo_version FROM app WHERE id=$1', [r.source_id]);
          if (!a || a.repo_version !== r.details.repoVersion) throw new ConflictException('仓库已变化，请刷新');
          await this.apps.approveDeploy(user, a.slug, r.details.repoVersion);
        }
      }
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
    } = await this.pool.query(`SELECT ${APPROVER} allowed FROM approval_request r WHERE id=$3`, [
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
      await c.query('BEGIN');
      try {
        await c.query(
          `UPDATE approval_request SET status='withdrawn',closed_reason='申请人主动撤回',decided_at=now() WHERE id=$1`,
          [id],
        );
        if (r.type === 'mcp')
          await c.query(`DELETE FROM mcp_subscription WHERE id=$1 AND status='pending'`, [r.source_id]);
        else if (r.type !== 'app')
          await c.query(
            `UPDATE ${SOURCE_TABLE[r.type as keyof typeof SOURCE_TABLE]} SET status='withdrawn' WHERE id=$1 AND status='pending'`,
            [r.source_id],
          );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    return this.get(user, id);
  }
  async resubmit(user: AuthUser, id: string, reason: string) {
    let nextId = id;
    await this.locked(user, id, async (r, c) => {
      if (!this.info(r, user).canResubmit) throw new ConflictException('该申请不可重新提交，请查看最新记录');
      await c.query('BEGIN');
      try {
        if (r.type === 'app') {
          const {
            rows: [a],
          } = await c.query('SELECT * FROM app WHERE id=$1 AND owner_id=$2 FOR UPDATE', [r.source_id, user.id]);
          if (!a || a.repo_version !== r.details.repoVersion)
            throw new ConflictException('应用或仓库已变化，请查看当前申请');
          await c.query(
            `SELECT eat_request_record('app',$1,$1,$2,NULL,$3,$4,$5,$6,$7,'pending',NULL,NULL,NULL,NULL,now(),NULL,true)`,
            [a.id, user.id, r.group_key, a.name, '/apps/' + a.slug, reason, JSON.stringify(r.details)],
          );
        } else if (r.type === 'mcp') {
          const {
            rows: [config],
          } = await c.query('SELECT id,visibility FROM mcp_config WHERE id=$1', [r.resource_id]);
          if (!config || config.visibility === 'private')
            throw new ConflictException('配置已删除或不再公开，请联系 owner');
          const updated = await c.query(
            `INSERT INTO mcp_subscription(user_id,config_id,source,status,reason) VALUES($1,$2,'manual','pending',$3)
            ON CONFLICT(user_id,config_id) DO UPDATE SET status='pending',reason=$3,decided_by=NULL,decided_at=NULL,rejection_reason=NULL,excluded=false WHERE mcp_subscription.status='rejected' RETURNING id`,
            [user.id, r.resource_id, reason],
          );
          if (!updated.rowCount) throw new ConflictException('订阅已生效或正在申请，请刷新状态');
        } else {
          const table = SOURCE_TABLE[r.type as keyof typeof SOURCE_TABLE];
          const field = r.type === 'env' ? 'reason' : 'purpose';
          const extra = r.type === 'env' ? ',decided_at=NULL' : ',updated_at=now()';
          const result = await c.query(
            `UPDATE ${table} SET status='pending',${field}=$2,rejection_reason=NULL,decided_by=NULL${extra} WHERE id=$1 AND status IN ('rejected','withdrawn') RETURNING id`,
            [r.source_id, reason],
          );
          if (!result.rowCount) throw new ConflictException('资源已变化，请重新发起申请');
        }
        const {
          rows: [next],
        } = await c.query('SELECT id FROM approval_request WHERE group_key=$1 AND latest', [r.group_key]);
        nextId = next.id;
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    return this.get(user, nextId);
  }
  async remind(user: AuthUser, id: string) {
    await this.locked(user, id, async (r, c) => {
      if (!this.info(r, user).canRemind) throw new ConflictException('仅自己的待审批申请可提醒，每 24 小时一次');
      await c.query('BEGIN');
      try {
        await c.query('UPDATE approval_request SET reminded_at=now() WHERE id=$1', [id]);
        await c.query(
          `INSERT INTO approval_notification(request_id,event) VALUES($1,'reminder') ON CONFLICT(request_id,event) DO UPDATE SET state='pending',retry_at=now(),attempts=0,sent_to='[]'`,
          [id],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    return this.get(user, id);
  }
}
