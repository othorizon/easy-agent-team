import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RequestDecision, RequestPresentation } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';

export interface RequestAction {
  row: any;
  client: PoolClient;
  user: AuthUser;
  decision: RequestDecision;
  reason?: string;
}

/** SQL expressions are trusted application code, evaluated against approval_request alias r.
 * Viewer expressions use $1 (user id), $2 (role). Owners are always read from the current resource. */
export interface RequestType {
  type: string;
  label: string;
  owner: string;
  visible?: string;
  approvable?: string;
  /** Approval execution can be blocked independently of permission to reject. */
  approvalBlocker?: string;
  /** Current resource presentation, evaluated on every list/card read. Never secrets. */
  presentationDetails?: string;
  notificationsAllowed?: string;
  resourceExists: string;
  invalidReason: string;
  resubmittable?: (row: any) => boolean;
  invalidated?: (client: PoolClient, sourceIds: string[]) => Promise<void>;
  approve: (action: RequestAction) => Promise<unknown>;
  reject: (action: RequestAction) => Promise<unknown>;
  withdraw: (action: RequestAction) => Promise<unknown>;
  resubmit: (action: RequestAction) => Promise<unknown>;
  afterReject?: (action: RequestAction) => Promise<unknown>;
  /** Resource-wide write barrier spans the action and its transaction commit. */
  runAction?: (kind: 'approve' | 'reject' | 'withdraw' | 'resubmit' | 'remind', work: (guard: () => void) => Promise<void>) => Promise<void>;
  loadDetails?: (row: any, user: AuthUser) => Promise<Record<string, unknown>>;
  presentation?: (row: any) => Partial<Omit<RequestPresentation, 'label'>> & { approvalHint?: string; cardLines?: string[] };
}

@Injectable()
export class RequestTypes {
  private readonly types = new Map<string, RequestType>();

  register(type: RequestType) {
    if (!/^[a-z][a-z0-9-]*$/.test(type.type) || this.types.has(type.type))
      throw new Error(`申请类型重复或无效：${type.type}`);
    this.types.set(type.type, type);
  }
  has(type: string) { return this.types.has(type); }
  get(type: string): RequestType {
    const handler = this.types.get(type);
    if (!handler) throw new NotFoundException('申请类型未注册');
    return handler;
  }
  all() { return [...this.types.values()]; }
  expression(field: 'owner' | 'visible' | 'approvable' | 'resourceExists' | 'invalidReason' | 'notificationsAllowed' | 'approvalBlocker' | 'presentationDetails') {
    const fallback = { owner: 'NULL::uuid', visible: 'true', approvable: 'true', resourceExists: 'false', invalidReason: 'NULL::text', notificationsAllowed: 'true', approvalBlocker: 'NULL::text', presentationDetails: "'{}'::jsonb" }[field];
    return `CASE r.type ${this.all().map(t => `WHEN '${t.type}' THEN (${t[field] ?? fallback})`).join(' ')} ELSE ${fallback} END`;
  }
  visible() { return `(${this.expression('visible')})`; }
  approver() { return `(${this.visible()} AND ($2='admin' OR (${this.expression('owner')})=$1) AND (${this.expression('approvable')}))`; }
  scope() { return `(${this.visible()} AND (r.requester_id=$1 OR $2='admin' OR (${this.expression('owner')})=$1))`; }
  dynamicSelect() {
    return `(${this.expression('approvalBlocker')}) approval_blocker,(${this.expression('presentationDetails')}) presentation_details,
      r.status||':'||coalesce(r.execution,'')||':'||coalesce((${this.expression('owner')})::text,'')||':'||coalesce((${this.expression('approvalBlocker')}),'')||':'||coalesce((${this.expression('presentationDetails')})::text,'') presentation_state`;
  }
  forViewer(userId: string, role: string) { return `coalesce(${this.approver().replace(/\$1\b/g, userId).replace(/\$2\b/g, role)},false)`; }
  select() {
    return `SELECT r.*,coalesce(u.name,'已删除用户') requester_name,d.name decided_by_name,
      ${this.dynamicSelect()},${this.approver()} can_approve,(${this.expression('resourceExists')}) resource_exists
      FROM approval_request r LEFT JOIN "user" u ON u.id=r.requester_id LEFT JOIN "user" d ON d.id=r.decided_by`;
  }
  present(row: any) {
    row = { ...row, details: { ...row.details, ...row.presentation_details } };
    const type = this.get(row.type);
    const presentation = type.presentation?.(row);
    return { ...row, presentation: { label: type.label, approvalBlocker: row.approval_blocker ?? null, ...presentation, lines: presentation?.lines ?? [] }, type_label: type.label, detail_lines: presentation?.cardLines ?? presentation?.lines ?? [], approval_hint: presentation?.approvalHint };
  }
}

/** Legacy source tables are still synchronized by their existing database triggers. */
export function sourceRequest(options: Omit<RequestType, 'reject' | 'withdraw' | 'resubmit'> & {
  table: string;
  reasonColumn?: string;
  timeColumn?: string;
  withdraw?: RequestType['withdraw'];
  resubmit?: RequestType['resubmit'];
}): RequestType {
  const { table, reasonColumn = 'purpose', timeColumn = 'updated_at' } = options;
  return {
    ...options,
    async reject({ row, client, user, decision }) {
      const result = await client.query(
        `UPDATE ${table} SET status='rejected',rejection_reason=$2,decided_by=$3,${timeColumn}=now() WHERE id=$1 AND status='pending' RETURNING id`,
        [row.source_id, decision.reason, user.id]);
      if (!result.rowCount) throw new ConflictException('申请状态已变化');
    },
    withdraw: options.withdraw ?? (async ({ row, client }) => {
      await client.query(`UPDATE ${table} SET status='withdrawn' WHERE id=$1 AND status='pending'`, [row.source_id]);
    }),
    resubmit: options.resubmit ?? (async ({ row, client, reason }) => {
      const timestamp = timeColumn === 'decided_at' ? 'NULL' : 'now()';
      const result = await client.query(`UPDATE ${table} SET status='pending',${reasonColumn}=$2,rejection_reason=NULL,decided_by=NULL,${timeColumn}=${timestamp} WHERE id=$1 AND status IN ('rejected','withdrawn') RETURNING id`, [row.source_id, reason]);
      if (!result.rowCount) throw new ConflictException('资源已变化，请重新发起申请');
    }),
  };
}
