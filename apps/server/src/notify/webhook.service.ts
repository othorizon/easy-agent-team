import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { webhookDeliveries } from '../db/schema';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 2000, 4000, 8000, 16000];

/**
 * 出站 webhook：通用 JSON + HMAC-SHA256 签名（X-Eat-Signature）。
 * 重试为进程内指数退避（最多 5 次），投递状态落 webhook_delivery 便于排查。
 * 注意：payload 不携带密钥值等敏感内容，只带事件与链接。
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

    const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), data });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) {
      headers['x-eat-signature'] = createHmac('sha256', secret).update(body).digest('hex');
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (BACKOFF_MS[attempt - 1]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      try {
        const res = await fetch(targetUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          await this.db
            .update(webhookDeliveries)
            .set({ status: 'success', attempts: attempt, updatedAt: sql`now()` })
            .where(eq(webhookDeliveries.id, row.id));
          return;
        }
        await this.markAttempt(row.id, attempt, `HTTP ${res.status}`);
      } catch (err) {
        await this.markAttempt(row.id, attempt, (err as Error).message);
      }
    }
  }

  private async markAttempt(id: string, attempt: number, error: string): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: attempt >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts: attempt, lastError: error, updatedAt: sql`now()` })
      .where(eq(webhookDeliveries.id, id));
  }
}
