import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { webhookDeliveries } from '../db/schema';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 2000, 4000, 8000, 16000];

/**
 * 出站通知：飞书群自定义机器人 webhook（§10 决策 16）。
 * 消息体为飞书 msg_type=text；机器人开启「加签」时按飞书规范附 timestamp + sign
 * （HmacSHA256(key = `${timestamp}\n${secret}`, data = 空串) 后 base64，签名随每次尝试重算避免过期）。
 * 飞书的失败常以 HTTP 200 + 非零 code 返回，因此按响应体 code 判定成败。
 * 重试为进程内指数退避（最多 5 次），投递状态落 webhook_delivery 便于排查。
 * 注意：消息不携带密钥值等敏感内容，只带事件摘要与链接。
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** 触发即返回，投递在后台进行 */
  notify(eventType: string, targetUrl: string, secret: string | null, data: Record<string, unknown>, summary = ''): void {
    void this.deliver(eventType, targetUrl, secret, data, summary).catch((err) =>
      this.logger.warn(`webhook 投递异常: ${(err as Error).message}`),
    );
  }

  private async deliver(
    eventType: string,
    targetUrl: string,
    secret: string | null,
    data: Record<string, unknown>,
    summary: string,
  ): Promise<void> {
    const [row] = await this.db
      .insert(webhookDeliveries)
      .values({ eventType, targetUrl, summary })
      .returning({ id: webhookDeliveries.id });

    const lines = [summary];
    const from = data.requester ?? data.from;
    if (typeof from === 'string' && from) lines.push(`来自：${from}`);
    if (typeof data.url === 'string' && data.url) lines.push(data.url);
    const text = lines.filter(Boolean).join('\n');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_MS[attempt - 1]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: this.buildFeishuBody(secret, text),
          signal: AbortSignal.timeout(10_000),
        });
        const error = await this.feishuError(res);
        if (!error) {
          await this.db
            .update(webhookDeliveries)
            .set({ status: 'success', attempts: attempt, updatedAt: sql`now()` })
            .where(eq(webhookDeliveries.id, row.id));
          return;
        }
        await this.markAttempt(row.id, attempt, error);
      } catch (err) {
        await this.markAttempt(row.id, attempt, (err as Error).message);
      }
    }
  }

  private buildFeishuBody(secret: string | null, text: string): string {
    const msg: Record<string, unknown> = { msg_type: 'text', content: { text } };
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
    if (typeof code === 'number' && code !== 0) return `飞书返回 code=${code} ${parsed?.msg ?? ''}`.trim();
    return null;
  }

  private async markAttempt(id: string, attempt: number, error: string): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: attempt >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts: attempt, lastError: error, updatedAt: sql`now()` })
      .where(eq(webhookDeliveries.id, id));
  }
}
