import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { DbAccessRequestResult, RequestDbAccess } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { PG_POOL } from '../db/db.module';
import type { RequestAction, RequestType } from '../requests/request-types';
import { DbAccessService } from './db-access.service';

/** New request types own snapshots directly; no dependency back into RequestsService. */
@Injectable()
export class DbAccessRequests {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, private readonly access: DbAccessService, private readonly audit: AuditService) {}

  private async validate(client: PoolClient, user: AuthUser, catalogId: string, level: string) {
    const { rows: [c] } = await client.query(`SELECT c.*,i.name instance_name,a.status assignment_status FROM db_catalog c JOIN db_instance i ON i.id=c.instance_id LEFT JOIN db_assignment a ON a.id=c.assignment_id WHERE c.id=$1 FOR SHARE OF c`, [catalogId]);
    if (!c) throw new NotFoundException('数据库目录记录不存在');
    if (c.assignment_id && !['active', 'disabled'].includes(c.assignment_status)) throw new ConflictException('数据库已删除或不可用');
    if (!c.open || c.state !== 'active') throw new ConflictException('该库未开放申请');
    const { rows: [grant] } = await client.query('SELECT * FROM db_access_grant WHERE catalog_id=$1 AND user_id=$2', [catalogId, user.id]);
    if (grant && grant.state !== 'revoked') {
      if (grant.level === 'write' && level === 'read') throw new ConflictException('你已持有读写权限，不能申请降级为只读；请联系 Owner 调整');
      if (grant.state !== 'active') throw new ConflictException('已有授权正在执行或执行失败，请联系 Owner 重试');
      if (grant.level === level) throw new ConflictException('你已持有所申请的权限');
    }
    const pending = await client.query(`SELECT id FROM approval_request WHERE group_key=$1 AND status='pending'`, [`db-access:${catalogId}:${user.id}`]);
    if (pending.rowCount) throw new ConflictException('同一个库已有待审批申请，请先撤回原申请');
    return c;
  }
  private async record(client: PoolClient, user: AuthUser, catalogId: string, dto: RequestDbAccess, sourceId = randomUUID()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`approval-group:db-access:${catalogId}:${user.id}`]);
    const c = await this.validate(client, user, catalogId, dto.level);
    await client.query(`SELECT eat_request_record('db-access',$1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NULL,NULL,NULL,NULL,now(),NULL,true)`,
      [sourceId, c.id, user.id, c.owner_id, `db-access:${c.id}:${user.id}`, `${c.db_name} @ ${c.instance_name}`, '/db?tab=access', dto.reason,
        JSON.stringify({ catalogId: c.id, instanceId: c.instance_id, instanceName: c.instance_name, dbName: c.db_name, level: dto.level })]);
    return (await client.query(`SELECT id FROM approval_request WHERE group_key=$1 AND latest`, [`db-access:${c.id}:${user.id}`])).rows[0].id as string;
  }
  async submit(user: AuthUser, catalogId: string, dto: RequestDbAccess): Promise<DbAccessRequestResult> {
    const client = await this.pool.connect();
    let direct = false;
    let requestId: string | null = null;
    try {
      await client.query('BEGIN');
      // Serialize duplicate submissions, including first rounds with no snapshot yet.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`approval-group:db-access:${catalogId}:${user.id}`]);
      const c = await this.validate(client, user, catalogId, dto.level);
      direct = user.role === 'admin' || c.owner_id === user.id;
      if (!direct) requestId = await this.record(client, user, catalogId, dto);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    if (direct) {
      const grant = await this.access.give(user, catalogId, { userId: user.id, level: dto.level });
      await this.audit.record({ actorId: user.id, action: 'db_access.self_granted', targetType: 'db_access_grant', targetId: grant.id, meta: { level: dto.level, reason: dto.reason } });
      return { requestId: null, grant };
    }
    await this.audit.record({ actorId: user.id, action: 'db_access.requested', targetType: 'approval_request', targetId: requestId! });
    return { requestId, grant: null };
  }
  private async resubmit({ row, client, user, reason }: RequestAction) {
    const { rows: [catalog] } = await client.query('SELECT owner_id FROM db_catalog WHERE id=$1', [row.resource_id]);
    if (user.role !== 'admin' && catalog?.owner_id !== user.id)
      return this.record(client, user, row.resource_id, { level: row.details.level, reason: reason! }, row.source_id);
    // 重提时权限可能已经变化。自己可管理时复用直接申请，保留已处理的历史轮次。
    // 这里不持目录行锁，避免等实例执行锁时阻塞同实例正在保存配置的操作。
    const result = await this.submit(user, row.resource_id, { level: row.details.level, reason: reason! });
    if (result.requestId) return result.requestId;
    const grant = result.grant!;
    await client.query(`SELECT eat_request_record('db-access',$1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',NULL,$10,$11,$3,now(),now(),true)`,
      [row.source_id, row.resource_id, user.id, catalog?.owner_id, row.group_key, row.target_name, row.resource_url, reason,
        JSON.stringify({ ...row.details, grantId: grant.id }), grant.state === 'pending' ? 'provisioning' : grant.state, grant.error]);
  }
  type(): RequestType {
    return {
      type: 'db-access', label: '数据库权限',
      owner: `(SELECT c.owner_id FROM db_catalog c JOIN "user" owner ON owner.id=c.owner_id AND owner.status='active' WHERE c.id=r.resource_id)`,
      resourceExists: 'EXISTS(SELECT 1 FROM db_catalog WHERE id=r.resource_id)',
      invalidReason: `CASE WHEN NOT EXISTS(SELECT 1 FROM db_catalog WHERE id=r.resource_id) THEN '数据库已删除'
        WHEN EXISTS(SELECT 1 FROM db_catalog c LEFT JOIN db_assignment a ON a.id=c.assignment_id WHERE c.id=r.resource_id AND c.assignment_id IS NOT NULL AND (a.id IS NULL OR a.status='deleted')) THEN '数据库已删除' END`,
      approve: ({ row, user }) => this.access.give(user, row.resource_id, { userId: row.requester_id, level: row.details.level }, row.id),
      async reject({ row, client, user, decision }: RequestAction) {
        await client.query(`UPDATE approval_request SET status='rejected',rejection_reason=$2,decided_by=$3,decided_at=now() WHERE id=$1`, [row.id, decision.reason, user.id]);
        await client.query(`INSERT INTO approval_notification(request_id,event) VALUES($1,'rejected') ON CONFLICT DO NOTHING`, [row.id]);
      },
      async withdraw() {},
      resubmit: action => this.resubmit(action),
      loadDetails: async row => {
        const { rows: [owner] } = await this.pool.query(`SELECT u.status FROM db_catalog c LEFT JOIN "user" u ON u.id=c.owner_id WHERE c.id=$1`, [row.resource_id]);
        return owner && owner.status !== 'active' ? { ownerNotice: 'Owner 已停用，由管理员审批' } : {};
      },
      presentation: row => ({
        lines: [`数据库：${row.details.dbName}`, `实例：${row.details.instanceName}`, `级别：${row.details.level === 'write' ? '读写' : '只读'}`],
        approvalNotice: '批准后执行数据库授权；执行失败可重试，不需要重新审批。',
      }),
    };
  }
}
