import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { webhookDeliveries } from '../db/schema';
import { feishuWebhookSchema } from '@eat/shared';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 2000, 4000, 8000, 16000];

/**
 * 出站通知：飞书群自定义机器人 webhook（§10 决策 16/17）。
 * 消息体为飞书 msg_type=interactive 卡片（构建逻辑在 @eat/shared 的 buildHelpFeishuCard，测试脚本共用）；
 * 机器人开启「加签」时按飞书规范附 timestamp + sign
 * （HmacSHA256(key = `${timestamp}\n${secret}`, data = 空串) 后 base64，签名随每次尝试重算避免过期）。
 * 飞书的失败常以 HTTP 200 + 非零 code 返回，因此按响应体 code 判定成败。
 * 重试为进程内指数退避（最多 5 次），投递状态落 webhook_delivery 便于排查。
 * 注意：消息不携带密钥值等敏感内容，只带事件摘要与链接。
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** A tracked integration task owns retries and records the delivery outcome. */
  async sendCardOnce(url: string, secret: string | null, card: Record<string, unknown>): Promise<void> {
    feishuWebhookSchema.parse(url);
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: this.buildFeishuBody(secret, card),
      signal: AbortSignal.timeout(10000) });
    const error = await this.feishuError(response);
    if (error) throw new Error(error);
  }

  async sendVerification(url: string, secret: string | null, code: string): Promise<void> {
    feishuWebhookSchema.parse(url);
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: this.buildFeishuBody(secret, {
        header: { title: { tag: 'plain_text', content: 'EAT 通知配置验证码' } },
        elements: [{ tag: 'div', text: {
          tag: 'plain_text',
          content: `EAT 验证码：${code}\n10 分钟内有效，请返回用户中心填写。非本人操作请忽略。`,
        } }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const error = await this.feishuError(response);
    if (error) throw new Error(error);
  }

  /** 触发即返回，投递在后台进行。card 为飞书卡片 JSON（不含加签字段） */
  notify(eventType: string, targetUrl: string, secret: string | null, card: Record<string, unknown>, summary = ''): void {
    void this.deliver(eventType, targetUrl, secret, card, summary).catch((err) =>
      this.logger.warn(`webhook 投递异常: ${(err as Error).message}`),
    );
  }

  /** 通用通知同步返回一次投递结果，避免调用方重试整批通知导致重复发送。 */
  sendNotification(targetUrl: string, secret: string | null, card: Record<string, unknown>, summary: string): Promise<boolean> {
    return this.deliver('notification.message', targetUrl, secret, card, summary, 1, false);
  }

  private async deliver(
    eventType: string,
    targetUrl: string,
    secret: string | null,
    card: Record<string, unknown>,
    summary: string,
    maxAttempts = MAX_ATTEMPTS,
    includeBrand = true,
  ): Promise<boolean> {
    const [row] = await this.db
      .insert(webhookDeliveries)
      .values({ eventType, targetUrl, summary })
      .returning({ id: webhookDeliveries.id });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (BACKOFF_MS[attempt - 1]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: this.buildFeishuBody(secret, card, includeBrand),
          signal: AbortSignal.timeout(10_000),
        });
        const error = await this.feishuError(res);
        if (!error) {
          await this.db
            .update(webhookDeliveries)
            .set({ status: 'success', attempts: attempt, updatedAt: sql`now()` })
            .where(eq(webhookDeliveries.id, row.id));
          return true;
        }
        await this.markAttempt(row.id, attempt, error, maxAttempts);
      } catch (err) {
        await this.markAttempt(row.id, attempt, (err as Error).message, maxAttempts);
      }
    }
    return false;
  }

  private buildFeishuBody(secret: string | null, card: Record<string, unknown>, includeBrand = true): string {
    const msg: Record<string, unknown> = {
      msg_type: 'interactive',
      card: {
        ...card,
        elements: [
          ...(Array.isArray(card.elements) ? card.elements : []),
          ...(includeBrand ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: 'EAT 平台通知' }] }] : []),
        ],
      },
    };
    if (secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      msg.timestamp = timestamp;
      msg.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
    }
    return JSON.stringify(msg);
  }

  /** 成功返回 null，失败返回错误描述。飞书加签错误等以 HTTP 200 + 非零 code 表达 */
  private async feishuError(res: Response): Promise<string | null> {
    if (!res.ok) return `HTTP ${res.status}`;
    const parsed = (await res.json().catch(() => null)) as { code?: number; msg?: string; StatusCode?: number } | null;
    const code = parsed?.code ?? parsed?.StatusCode;
    if (typeof code !== 'number') return '飞书返回无效响应';
    if (typeof code === 'number' && code !== 0) return `飞书返回 code=${code} ${parsed?.msg ?? ''}`.trim();
    return null;
  }

  private async markAttempt(id: string, attempt: number, error: string, maxAttempts = MAX_ATTEMPTS): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: attempt >= maxAttempts ? 'failed' : 'pending', attempts: attempt, lastError: error, updatedAt: sql`now()` })
      .where(eq(webhookDeliveries.id, id));
  }
}
