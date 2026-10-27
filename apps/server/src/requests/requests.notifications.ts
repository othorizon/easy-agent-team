import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { REQUEST_TYPES, REQUEST_STATUSES } from '@eat/shared';
import { PG_POOL } from '../db/db.module';
import { WebhookService } from '../notify/webhook.service';
import { decryptSecret } from '../common/crypto';
import { loadConfig } from '../config';
import { RequestsService } from './requests.service';
import { createRequestActionToken } from './request-action-link';
import { FeishuAppService } from '../notify/feishu/feishu-app.service';
import { ApprovalCards } from './approval-cards.service';
import { approvalCardState, buildApprovalCard } from './approval-card';

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
    private readonly feishu: FeishuAppService,
    private readonly cards: ApprovalCards,
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
      // 申请状态变了（网页审批、撤回、失效、开通完成）的审批卡片在这里回写
      await this.cards.sync();
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
      if (r.type === 'env' && (await c.query("SELECT 1 FROM environment WHERE id=$1 AND visibility='private'", [r.resource_id])).rowCount) {
        await c.query(`UPDATE approval_notification SET state='skipped' WHERE id=$1`, [event.id]);
        await c.query('COMMIT');
        return true;
      }
      const submitted = ['submitted', 'reminder'].includes(event.event);
      if (submitted && r.status !== 'pending') {
        await c.query(`UPDATE approval_notification SET state='skipped' WHERE id=$1`, [event.id]);
        await c.query('COMMIT');
        return true;
      }
      // 渠道是平台级单选（决策 92）：自建应用渠道只认绑定了当前应用的成员
      const feishu = await this.feishu.row();
      const app = feishu.channel === 'app' && feishu.appId ? this.feishu.client(feishu) : null;
      const appMode = feishu.channel === 'app';
      const { rows: subscribers } = await c.query(
        `SELECT u.id,n.webhook_url,n.webhook_secret_encrypted,n.verified_at,b.open_id FROM "user" u
        LEFT JOIN user_notification n ON n.user_id=u.id
        LEFT JOIN feishu_binding b ON b.user_id=u.id AND b.app_id=$4
        WHERE u.status='active' AND coalesce(n.${submitted ? 'notify_approval_request' : 'notify_approval_result'},true)
        AND $1::uuid IS NOT NULL AND ${submitted ? `(u.role='admin' OR u.id=CASE $2 WHEN 'env' THEN (SELECT owner_id FROM environment WHERE id=$3) WHEN 'mcp' THEN (SELECT owner_id FROM mcp_config WHERE id=$3) ELSE NULL END)` : `u.id=$1 AND $2::text IS NOT NULL AND $3::uuid IS NOT NULL`}`,
        [r.requester_id, r.type, r.resource_id, feishu.appId],
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
      const recipients = subscribers.filter((u) => (appMode ? app && u.open_id : u.webhook_url && u.verified_at));
      let error: string | null = recipients.length
        ? null
        : appMode
          ? '没有成员绑定飞书自建应用，请在页面查看处理结果'
          : '没有可用的已验证飞书通知渠道，请在页面查看处理结果';
      const sent: string[] = event.sent_to ?? [];
      for (const recipient of recipients) {
        if (sent.includes(recipient.id)) continue;
        if (app) {
          try {
            // 自建应用渠道：审批人收到可直接同意 / 驳回的卡片，并记下来供状态变化后回写
            const card = buildApprovalCard(r, {
              view: submitted ? 'pending' : 'result',
              audience: submitted ? 'approver' : 'requester',
              detailUrl: this.cards.detailUrl(r.id),
            });
            const messageId = await app.sendCard(recipient.open_id, card);
            if (submitted) {
              await c.query(
                'INSERT INTO feishu_card(app_id,message_id,user_id,request_id,state) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
                [app.appId, messageId, recipient.id, r.id, approvalCardState(r)],
              );
            }
            sent.push(recipient.id);
          } catch {
            error = '飞书通知投递失败，审批结果已保存，请在页面查看';
          }
          continue;
        }
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
