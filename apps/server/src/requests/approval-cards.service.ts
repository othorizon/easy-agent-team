import { HttpException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { PG_POOL } from '../db/db.module';
import { loadConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { FeishuAppService } from '../notify/feishu/feishu-app.service';
import {
  FeishuCallbackService,
  type FeishuCardActionContext,
  type FeishuCardActionResult,
} from '../notify/feishu/feishu-callback.service';
import { RequestsService } from './requests.service';
import { approvalCardState, buildApprovalCard, type ApprovalCardRow, type ApprovalCardView } from './approval-card';

/** 飞书卡片回调必须 3 秒内应答；开通资源超过这个时间就先回「正在处理」，完成后再回写卡片 */
const CALLBACK_BUDGET_MS = 2500;
const SELECT = `SELECT r.*,u.name requester_name,u.email requester_email,a.name approver_name
  FROM approval_request r LEFT JOIN "user" u ON u.id=r.requester_id LEFT JOIN "user" a ON a.id=r.decided_by`;
const actionSchema = z.object({
  requestId: z.uuid(),
  action: z.enum(['approve', 'reject_start', 'reject_cancel', 'reject']),
});

const errorText = (e: unknown) => {
  if (e instanceof HttpException) {
    const res = e.getResponse();
    return typeof res === 'string' ? res : String((res as { message?: unknown }).message ?? e.message);
  }
  return '处理失败，请在 EAT 页面重试';
};

/**
 * 审批卡片的回调与回写（决策 92）。
 * 回调：卡片按钮直接执行同意 / 驳回，身份取「操作人飞书账号绑定的 EAT 用户」，
 * 且卡片必须是发给这个人的那一张——转发出去的卡片点了也不算数；权限照常由 RequestsService 复核。
 * 回写：申请状态变化后（不论在卡片、网页还是撤回 / 失效），把每张卡片改成最新状态。
 */
@Injectable()
export class ApprovalCards implements OnModuleInit {
  private readonly logger = new Logger(ApprovalCards.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly feishu: FeishuAppService,
    private readonly callback: FeishuCallbackService,
    private readonly requests: RequestsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.callback.registerCardAction('approval', (ctx) => this.onAction(ctx));
  }

  detailUrl(id: string) {
    return new URL(`/requests?request=${id}`, loadConfig().publicUrl).toString();
  }

  private async load(id: string): Promise<ApprovalCardRow | null> {
    return (await this.pool.query(`${SELECT} WHERE r.id=$1`, [id])).rows[0] ?? null;
  }

  private respond(
    r: ApprovalCardRow,
    view: ApprovalCardView,
    toast?: FeishuCardActionResult['toast'],
    notice?: string,
  ): FeishuCardActionResult {
    return { ...(toast ? { toast } : {}), card: { type: 'raw', data: buildApprovalCard(r, { view, detailUrl: this.detailUrl(r.id), notice }) } };
  }

  async onAction(ctx: FeishuCardActionContext): Promise<FeishuCardActionResult> {
    const parsed = actionSchema.safeParse(ctx.value);
    if (!parsed.success) return { toast: { type: 'warning', content: '这张卡片已失效，请在 EAT 页面处理' } };
    const { requestId, action } = parsed.data;
    const user = await this.feishu.userByOpenId(ctx.appId, ctx.operatorOpenId);
    if (!user) {
      return { toast: { type: 'error', content: '你的飞书账号还没有绑定 EAT 账号，请先在 EAT 个人中心完成绑定' } };
    }
    const {
      rows: [card],
    } = await this.pool.query('SELECT * FROM feishu_card WHERE message_id=$1 AND app_id=$2', [ctx.messageId, ctx.appId]);
    if (!card || card.request_id !== requestId || card.user_id !== user.id) {
      return { toast: { type: 'warning', content: '这张卡片不是发给你的，请在 EAT 页面处理' } };
    }
    const current = await this.load(requestId);
    if (!current) return { toast: { type: 'warning', content: '申请不存在或已删除' } };
    if (current.status !== 'pending') {
      await this.markRendered(card.id, current);
      return this.respond(current, 'result', { type: 'info', content: '该申请已处理' });
    }
    if (action === 'reject_start') return this.respond(current, 'rejecting');
    if (action === 'reject_cancel') return this.respond(current, 'pending');
    const reason = String(ctx.formValue.reason ?? '').trim();
    if (action === 'reject' && !reason) {
      return this.respond(current, 'rejecting', { type: 'error', content: '请填写驳回原因' });
    }
    const actor: AuthUser = { id: user.id, name: user.name, email: user.email, role: user.role, tokenId: '' };
    const run = this.requests.decide(
      actor,
      requestId,
      action === 'approve' ? { decision: 'approved' } : { decision: 'rejected', reason: reason.slice(0, 2000) },
    );
    const outcome = await Promise.race([
      run.then(
        () => ({ kind: 'done' as const }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), CALLBACK_BUDGET_MS)),
    ]);
    if (outcome.kind === 'timeout') {
      // 回调已经先应答了「处理中」；完成后再改卡片（飞书要求延时更新必须发生在回调应答之后）
      void run.then(
        () => setTimeout(() => void this.sync(requestId).catch(() => undefined), 1000),
        async (error: unknown) => {
          const latest = await this.load(requestId);
          const api = this.feishu.client(await this.feishu.row());
          if (latest && api) {
            const data = buildApprovalCard(latest, {
              view: 'pending',
              detailUrl: this.detailUrl(requestId),
              notice: `处理失败：${errorText(error)}`,
            });
            await api.updateCard(ctx.messageId, data).catch(() => undefined);
          }
        },
      );
      await this.recordAction(user.id, requestId, action);
      return this.respond(current, 'processing', { type: 'info', content: '已提交，正在处理…' }, '处理完成后卡片会自动更新');
    }
    const latest = (await this.load(requestId)) ?? current;
    if (outcome.kind === 'error') {
      if (latest.status !== 'pending') await this.markRendered(card.id, latest);
      return this.respond(latest, latest.status === 'pending' ? 'pending' : 'result', {
        type: 'error',
        content: errorText(outcome.error),
      });
    }
    await this.recordAction(user.id, requestId, action);
    await this.markRendered(card.id, latest);
    // 其他审批人手里的同一张申请卡片一并更新
    setTimeout(() => void this.sync(requestId).catch(() => undefined), 1000);
    return this.respond(latest, 'result', {
      type: 'success',
      content: action === 'approve' ? '已同意' : '已驳回',
    });
  }

  private async recordAction(actorId: string, requestId: string, action: string) {
    await this.audit.record({
      actorId,
      action: 'request.feishu_card_action',
      targetType: 'approval_request',
      targetId: requestId,
      meta: { action },
    });
  }

  private async markRendered(cardId: string, r: ApprovalCardRow) {
    await this.pool.query('UPDATE feishu_card SET state=$2,update_error=NULL,updated_at=now() WHERE id=$1', [
      cardId,
      approvalCardState(r),
    ]);
  }

  /** 把与申请当前状态不一致的卡片改成最新样子。失败的 10 分钟后再试，卡片发出 30 天后不再跟进 */
  async sync(requestId?: string): Promise<void> {
    const settings = await this.feishu.row();
    const api = this.feishu.client(settings);
    if (!api) return;
    const { rows } = await this.pool.query(
      `SELECT c.id card_id,c.message_id,c.state card_state,x.* FROM feishu_card c
      JOIN (${SELECT}) x ON x.id=c.request_id
      WHERE c.app_id=$1 AND c.state <> x.status||':'||coalesce(x.execution,'')
      AND c.created_at > now()-interval '30 days'
      AND (c.update_error IS NULL OR c.updated_at < now()-interval '10 minutes')
      ${requestId ? 'AND c.request_id=$2' : ''}
      ORDER BY c.updated_at LIMIT 50`,
      requestId ? [settings.appId, requestId] : [settings.appId],
    );
    for (const row of rows) {
      try {
        await api.updateCard(row.message_id, buildApprovalCard(row, { view: 'result', detailUrl: this.detailUrl(row.id) }));
        await this.pool.query('UPDATE feishu_card SET state=$2,update_error=NULL,updated_at=now() WHERE id=$1 AND state=$3', [
          row.card_id,
          approvalCardState(row),
          row.card_state,
        ]);
      } catch (e) {
        this.logger.warn(`审批卡片更新失败：${(e as Error).message}`);
        await this.pool.query('UPDATE feishu_card SET update_error=$2,updated_at=now() WHERE id=$1', [
          row.card_id,
          (e as Error).message.slice(0, 500),
        ]);
      }
    }
  }
}
