import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AliyunCatalogPermission, AliyunPermissionDocument, AliyunPermissionRequestResult, ConfiguredAliyunPermission, ConfigureAliyunPermission, RequestAliyunPermission } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { PG_POOL } from '../db/db.module';
import { RamCloud, ramMissing } from '../ram/ram-cloud';
import type { RequestAction, RequestType } from '../requests/request-types';
import { AliyunService } from './aliyun.service';
import { AliyunGrantsService } from './aliyun-grants.service';

const PAUSED = '接入已暂停，不能申请或批准新的授权；请管理员恢复接入后重试';
@Injectable()
export class AliyunRequests {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, private readonly aliyun: AliyunService,
    private readonly grants: AliyunGrantsService, private readonly ram: RamCloud, private readonly audit: AuditService) {}

  async list(user: AuthUser, manage = false): Promise<AliyunCatalogPermission[]> {
    const { rows } = await this.pool.query(`SELECT p.*, c.name connection_name,c.account_id,c.status connection_status,
      u.name owner_name,u.status owner_status,
      EXISTS(SELECT 1 FROM aliyun_grant g WHERE g.permission_id=p.id AND g.user_id=$1 AND g.state<>'revoked') held,
      (SELECT id FROM approval_request r WHERE r.type='aliyun' AND r.resource_id=p.id AND r.requester_id=$1 AND r.status='pending' LIMIT 1) pending_request_id
      FROM aliyun_permission p JOIN aliyun_connection c ON c.id=p.connection_id LEFT JOIN "user" u ON u.id=p.owner_id
      WHERE $2::text IS NOT NULL AND ${manage ? "($2='admin' OR p.owner_id=$1)" : 'p.open AND p.cloud_exists'} ORDER BY c.name,p.policy_name`, [user.id, user.role]);
    return rows.map(p => ({ id: p.id, connectionId: p.connection_id, connectionName: p.connection_name, accountId: p.account_id,
      connectionStatus: p.connection_status, policyName: p.policy_name, description: p.description, cloudExists: p.cloud_exists,
      open: p.open, purpose: p.purpose, dataScope: p.data_scope, ownerId: p.owner_id, ownerName: p.owner_name, ownerStatus: p.owner_status,
      canManage: user.role === 'admin' || p.owner_id === user.id, held: p.held, pendingRequestId: p.pending_request_id,
      discoveredAt: p.discovered_at.toISOString(), updatedAt: p.updated_at.toISOString() }));
  }
  async configure(user: AuthUser, id: string, dto: ConfigureAliyunPermission): Promise<ConfiguredAliyunPermission> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [p] } = await client.query('SELECT * FROM aliyun_permission WHERE id=$1 FOR UPDATE', [id]);
      if (!p) throw new NotFoundException('权限点不存在');
      if (user.role !== 'admin' && p.owner_id !== user.id) throw new ForbiddenException('仅权限点 Owner 或管理员可管理开放申请');
      if (dto.open && !p.cloud_exists) throw new ConflictException('权限点在云端已删除，不能开放申请');
      if (dto.ownerId) {
        const { rows: [owner] } = await client.query('SELECT status FROM "user" WHERE id=$1', [dto.ownerId]);
        if (!owner || (owner.status !== 'active' && p.owner_id !== dto.ownerId)) throw new ConflictException('请选择启用中的 Owner');
      }
      await client.query('UPDATE aliyun_permission SET open=$2,purpose=$3,data_scope=$4,owner_id=$5,updated_at=now() WHERE id=$1', [id, dto.open, dto.purpose, dto.dataScope, dto.ownerId]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    await this.audit.record({ actorId: user.id, actorTokenId: user.tokenId, action: 'aliyun.permission.configure', targetType: 'aliyun_permission', targetId: id, meta: dto });
    // A transferred Owner may no longer see the management list; return only the submitted configuration.
    return { id, ...dto };
  }
  async document(user: AuthUser, id: string): Promise<AliyunPermissionDocument> {
    const { rows: [p] } = await this.pool.query('SELECT * FROM aliyun_permission WHERE id=$1', [id]);
    if (!p) throw new NotFoundException('权限点不存在');
    if (user.role !== 'admin' && p.owner_id !== user.id) throw new ForbiddenException('仅当前 Owner 或管理员可查看策略原文');
    const c = await this.aliyun.connection(p.connection_id);
    try {
      const policy = await this.ram.getPolicy(this.aliyun.credentials(c), p.policy_name);
      return { policyName: policy.name, document: policy.document, fetchedAt: new Date().toISOString() };
    } catch (e) {
      if (!ramMissing(e)) throw e;
      await this.pool.query('UPDATE aliyun_permission SET cloud_exists=false,open=false,updated_at=now() WHERE id=$1', [id]);
      throw new ConflictException('权限点在云端已删除，已关闭申请');
    }
  }
  private async validate(client: PoolClient, user: AuthUser, id: string) {
    const { rows: [p] } = await client.query(`SELECT p.*,c.name connection_name,c.account_id,c.status connection_status FROM aliyun_permission p JOIN aliyun_connection c ON c.id=p.connection_id WHERE p.id=$1 FOR SHARE OF p,c`, [id]);
    if (!p) throw new NotFoundException('权限点不存在');
    if (!p.cloud_exists) throw new ConflictException('权限点在云端已删除');
    if (!p.open) throw new ConflictException('权限点未开放申请');
    if (p.connection_status === 'paused') throw new ConflictException(PAUSED);
    const { rows: [target] } = await client.query('SELECT status FROM "user" WHERE id=$1', [user.id]);
    if (!target || target.status !== 'active') throw new ForbiddenException('停用的 EAT 用户不能申请授权');
    if ((await client.query("SELECT id FROM aliyun_grant WHERE permission_id=$1 AND user_id=$2 AND state<>'revoked'", [id, user.id])).rowCount)
      throw new ConflictException('你已持有该权限点的授权；正在执行或失败的授权请联系 Owner 重试');
    if ((await client.query("SELECT id FROM approval_request WHERE group_key=$1 AND status='pending'", [`aliyun:${id}:${user.id}`])).rowCount)
      throw new ConflictException('同一个权限点已有待审批申请，请先撤回原申请');
    return p;
  }
  private async record(client: PoolClient, user: AuthUser, id: string, dto: RequestAliyunPermission, sourceId = randomUUID()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`approval-group:aliyun:${id}:${user.id}`]);
    const p = await this.validate(client, user, id);
    await client.query(`SELECT eat_request_record('aliyun',$1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',NULL,NULL,NULL,NULL,now(),NULL,true)`,
      [sourceId, p.id, user.id, p.owner_id, `aliyun:${p.id}:${user.id}`, `${p.policy_name} @ ${p.connection_name}`, '/aliyun', dto.reason,
        JSON.stringify({ permissionId: p.id, policyName: p.policy_name, connectionName: p.connection_name, accountId: p.account_id, description: p.description, purpose: p.purpose, dataScope: p.data_scope })]);
    return (await client.query('SELECT id FROM approval_request WHERE group_key=$1 AND latest', [`aliyun:${p.id}:${user.id}`])).rows[0].id as string;
  }
  async submit(user: AuthUser, id: string, dto: RequestAliyunPermission): Promise<AliyunPermissionRequestResult> {
    const client = await this.pool.connect();
    let direct = false, requestId: string | null = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`approval-group:aliyun:${id}:${user.id}`]);
      const p = await this.validate(client, user, id);
      direct = user.role === 'admin' || p.owner_id === user.id;
      if (!direct) requestId = await this.record(client, user, id, dto);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    if (direct) {
      const grant = await this.grants.give(user, id, { userId: user.id }, 'self');
      await this.audit.record({ actorId: user.id, actorTokenId: user.tokenId, action: 'aliyun.self_granted', targetType: 'aliyun_grant', targetId: grant.id, meta: { reason: dto.reason } });
      return { requestId: null, grant };
    }
    await this.audit.record({ actorId: user.id, actorTokenId: user.tokenId, action: 'aliyun.requested', targetType: 'approval_request', targetId: requestId! });
    return { requestId, grant: null };
  }
  private async resubmit({ row, client, user, reason }: RequestAction) {
    const { rows: [p] } = await client.query('SELECT owner_id,open FROM aliyun_permission WHERE id=$1', [row.resource_id]);
    if (user.role !== 'admin' && !(p?.open && p.owner_id === user.id)) return this.record(client, user, row.resource_id, { reason: reason! }, row.source_id);
    const result = await this.submit(user, row.resource_id, { reason: reason! });
    const g = result.grant!;
    await client.query(`SELECT eat_request_record('aliyun',$1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',NULL,$10,$11,$3,now(),now(),true)`,
      [row.source_id, row.resource_id, user.id, p?.owner_id, row.group_key, row.target_name, row.resource_url, reason,
        JSON.stringify({ ...row.details, grantId: g.id }), g.state === 'pending' ? 'provisioning' : g.state, g.error]);
  }
  type(): RequestType {
    return {
      type: 'aliyun', label: '阿里云权限',
      owner: `(SELECT p.owner_id FROM aliyun_permission p JOIN "user" u ON u.id=p.owner_id AND u.status='active' WHERE p.id=r.resource_id AND p.open)`,
      resourceExists: 'EXISTS(SELECT 1 FROM aliyun_permission WHERE id=r.resource_id AND cloud_exists AND open)',
      invalidReason: `CASE WHEN NOT EXISTS(SELECT 1 FROM aliyun_permission WHERE id=r.resource_id AND cloud_exists) THEN '权限点在云端已删除' END`,
      approvalBlocker: `(SELECT CASE WHEN c.status='paused' THEN '${PAUSED}' END FROM aliyun_permission p JOIN aliyun_connection c ON c.id=p.connection_id WHERE p.id=r.resource_id)`,
      presentationDetails: `(SELECT jsonb_build_object('ownerNotice',CASE WHEN u.status='disabled' THEN 'Owner 已停用，由管理员审批' ELSE NULL END) FROM aliyun_permission p LEFT JOIN "user" u ON u.id=p.owner_id WHERE p.id=r.resource_id)`,
      approve: ({ row, user }) => this.grants.give(user, row.resource_id, { userId: row.requester_id }, 'approval', row.id),
      async reject({ row, client, user, decision }) {
        await client.query("UPDATE approval_request SET status='rejected',rejection_reason=$2,decided_by=$3,decided_at=now() WHERE id=$1", [row.id, decision.reason, user.id]);
        await client.query("INSERT INTO approval_notification(request_id,event) VALUES($1,'rejected') ON CONFLICT DO NOTHING", [row.id]);
      },
      async withdraw() {},
      resubmit: action => this.resubmit(action),
      loadDetails: async (row, user) => {
        const { rows: [p] } = await this.pool.query('SELECT owner_id FROM aliyun_permission WHERE id=$1', [row.resource_id]);
        return user.role === 'admin' || p?.owner_id === user.id ? { policyDocumentUrl: `/api/aliyun/permissions/${row.resource_id}/document` } : {};
      },
      presentation: row => {
        const lines = [`权限点：${row.details.policyName}`, `云账号：${row.details.connectionName}（${row.details.accountId}）`, `权限点说明：${row.details.description || '未填写'}`, `用途：${row.details.purpose || '未填写'}`, `数据范围：${row.details.dataScope || '未填写'}`];
        return { lines, cardLines: [...lines, ...(row.details.ownerNotice ? [row.details.ownerNotice] : [])],
          approvalNotice: '批准后执行云端授权；已批准与已生效分别显示，执行失败可重试，无需重新审批。' };
      },
    };
  }
}
