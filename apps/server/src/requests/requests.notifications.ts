import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { REQUEST_TYPES, REQUEST_STATUSES } from '@eat/shared';
import { PG_POOL } from '../db/db.module';
import { WebhookService } from '../notify/webhook.service';
import { decryptSecret } from '../common/crypto';
import { loadConfig } from '../config';
import { RequestsService } from './requests.service';
import { createRequestActionToken } from './request-action-link';

/** Durable notification outbox; processing never blocks or rolls back approval. */
@Injectable()
export class RequestNotifications implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(RequestNotifications.name);
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly webhook: WebhookService,
    private readonly requests: RequestsService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.requests.reconcile();
      for (let i = 0; i < 20; i++) if (!(await this.next())) break;
    } catch (e) {
      this.logger.warn(`审批通知处理失败：${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
  private async next() {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const {
        rows: [event],
      } = await c.query(
        `SELECT * FROM approval_notification WHERE state='pending' AND retry_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!event) {
        await c.query('COMMIT');
        return false;
      }
      const {
        rows: [r],
      } = await c.query(
        `SELECT r.*,u.name requester_name,u.email requester_email,a.name approver_name
        FROM approval_request r LEFT JOIN "user" u ON u.id=r.requester_id
        LEFT JOIN "user" a ON a.id=r.decided_by WHERE r.id=$1`,
        [event.request_id],
      );
      const submitted = ['submitted', 'reminder'].includes(event.event);
      if (submitted && r.status !== 'pending') {
        await c.query(`UPDATE approval_notification SET state='skipped' WHERE id=$1`, [event.id]);
        await c.query('COMMIT');
        return true;
      }
      const { rows: subscribers } = await c.query(
        `SELECT u.id,n.webhook_url,n.webhook_secret_encrypted,n.verified_at FROM "user" u
        LEFT JOIN user_notification n ON n.user_id=u.id
        WHERE u.status='active' AND coalesce(n.${submitted ? 'notify_approval_request' : 'notify_approval_result'},true)
        AND $1::uuid IS NOT NULL AND ${submitted ? `(u.role='admin' OR u.id=CASE $2 WHEN 'env' THEN (SELECT owner_id FROM environment WHERE id=$3) WHEN 'mcp' THEN (SELECT owner_id FROM mcp_config WHERE id=$3) ELSE NULL END)` : `u.id=$1 AND $2::text IS NOT NULL AND $3::uuid IS NOT NULL`}`,
        [r.requester_id, r.type, r.resource_id],
      );
      // Opting out is intentional, not a delivery failure. Recheck on every retry.
      if (!subscribers.length) {
        await c.query(`UPDATE approval_notification SET state='skipped',last_error=NULL WHERE id=$1`, [
          event.id,
        ]);
        await c.query('UPDATE approval_request SET notification_error=NULL WHERE id=$1', [r.id]);
        await c.query('COMMIT');
        return true;
      }
      const recipients = subscribers.filter((u) => u.webhook_url && u.verified_at);
      let error: string | null = recipients.length
        ? null
        : '没有可用的已验证飞书通知渠道，请在页面查看处理结果';
      const sent: string[] = event.sent_to ?? [];
      for (const recipient of recipients) {
        if (sent.includes(recipient.id)) continue;
        try {
          const url = new URL(`/requests?request=${r.id}`, loadConfig().publicUrl).toString();
          const approveUrl = new URL(`/requests/${r.id}/approve`, loadConfig().publicUrl);
          approveUrl.searchParams.set('token', createRequestActionToken(r.id, recipient.id));
          const button = (content: string, href: string, type = 'default') => ({
            tag: 'button',
            text: { tag: 'plain_text', content },
            url: href,
            type,
          });
          const actions = submitted
            ? [
                button('同意', approveUrl.toString(), 'primary'),
                button('驳回', url + '&action=reject'),
                button('查看详情', url),
              ]
            : [button('查看详情', url)];
          const content = [
            `申请类型：${REQUEST_TYPES[r.type as keyof typeof REQUEST_TYPES]}`,
            `申请资源：${r.target_name}`,
            ...(Array.isArray(r.details?.keys) ? [`申请变量：${r.details.keys.join('、')}`] : []),
            ...(r.type === 'app' && r.details?.repoUrl ? [`仓库：${r.details.repoUrl}`, `分支：${r.details.branch ?? '未记录'}`] : []),
            `申请人：${r.requester_name ?? '已删除用户'}${r.requester_email ? `（${r.requester_email}）` : ''}`,
            `申请时间：${new Date(r.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`,
            `申请原因：${r.reason || '未填写'}`,
            ...(!submitted ? [`审批人：${r.approver_name ?? '未记录'}`] : []),
            ...(r.rejection_reason ? [`驳回原因：${r.rejection_reason}`] : []),
            ...(!submitted && r.execution === 'failed' ? ['资源开通失败，请在详情查看处理进度。'] : []),
            ...(!submitted && r.execution === 'provisioning' ? ['审批已通过，资源正在开通。'] : []),
          ].join('\n');
          await this.webhook.sendCardOnce(
            recipient.webhook_url,
            recipient.webhook_secret_encrypted ? decryptSecret(recipient.webhook_secret_encrypted) : null,
            {
              config: { wide_screen_mode: true },
              header: {
                template: submitted ? 'blue' : r.status === 'approved' ? 'green' : 'red',
                title: {
                  tag: 'plain_text',
                  content: `EAT ${submitted ? '待审批提醒' : REQUEST_STATUSES[r.status as keyof typeof REQUEST_STATUSES]}`,
                },
              },
              elements: [
                {
                  tag: 'div',
                  text: {
                    tag: 'plain_text',
                    content,
                  },
                },
                ...(submitted && r.type === 'env'
                  ? [
                      {
                        tag: 'note',
                        elements: [
                          {
                            tag: 'plain_text',
                            content:
                              '快捷同意将授权本次申请的全部变量，不设置到期时间；需要限制有效期请查看详情。',
                          },
                        ],
                      },
                    ]
                  : []),
                { tag: 'action', actions },
              ],
            },
          );
          sent.push(recipient.id);
        } catch {
          error = '飞书通知投递失败，审批结果已保存，请在页面查看';
        }
      }
      await c.query(
        `UPDATE approval_notification SET state=$2,attempts=attempts+1,last_error=$3,sent_to=$4,retry_at=now()+interval '1 minute'*power(2,attempts) WHERE id=$1`,
        [
          event.id,
          error ? (recipients.length && event.attempts < 4 ? 'pending' : 'failed') : 'sent',
          error,
          JSON.stringify(sent),
        ],
      );
      await c.query('UPDATE approval_request SET notification_error=$2 WHERE id=$1', [r.id, error]);
      await c.query('COMMIT');
      return true;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
