import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { userNotifications, users, webhookDeliveries } from '../db/schema';
import { decryptSecret } from '../common/crypto';
import { WebhookService } from './webhook.service';
import { FeishuAppService } from './feishu/feishu-app.service';

export type NotifyKind = 'help' | 'reply' | 'mention' | 'approvalRequest' | 'approvalResult';

export type NotifyTarget =
  | { channel: 'webhook'; url: string; secret: string | null }
  | { channel: 'app'; appId: string; openId: string };

const PREFERENCE = {
  help: 'notifyHelp',
  reply: 'notifyReply',
  mention: 'notifyMention',
  approvalRequest: 'notifyApprovalRequest',
  approvalResult: 'notifyApprovalResult',
} as const;
const BACKOFF_MS = [0, 2000, 4000, 8000, 16000];

/** 机器人卡片统一带上平台落款，与 Webhook 渠道的卡片一致 */
export function withFooter(card: Record<string, unknown>): Record<string, unknown> {
  return {
    ...card,
    elements: [
      ...(Array.isArray(card.elements) ? card.elements : []),
      { tag: 'note', elements: [{ tag: 'plain_text', content: 'EAT 平台通知' }] },
    ],
  };
}

/**
 * 个人通知的统一出口（决策 92）：按平台当前渠道把同一张卡片发到
 * 「个人飞书群 Webhook」或「自建应用机器人私聊」。调用方只关心发给谁、发什么。
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly webhook: WebhookService,
    private readonly feishu: FeishuAppService,
  ) {}

  /** 当前渠道下该用户的投递目标；没配置、没绑定或关了这类通知时为 null */
  async target(userId: string, kind?: NotifyKind): Promise<NotifyTarget | null> {
    const settings = await this.feishu.row();
    const [row] = await this.db
      .select({ status: users.status, n: userNotifications })
      .from(users)
      .leftJoin(userNotifications, eq(userNotifications.userId, users.id))
      .where(eq(users.id, userId));
    if (!row || row.status !== 'active') return null;
    if (kind && row.n && !row.n[PREFERENCE[kind]]) return null;
    if (settings.channel === 'app') {
      if (!settings.appId) return null;
      const openId = await this.feishu.openIdOf(userId, settings.appId);
      return openId ? { channel: 'app', appId: settings.appId, openId } : null;
    }
    if (!row.n?.webhookUrl || !row.n.verifiedAt) return null;
    return {
      channel: 'webhook',
      url: row.n.webhookUrl,
      secret: row.n.webhookSecretEncrypted ? decryptSecret(row.n.webhookSecretEncrypted) : null,
    };
  }

  /** 触发即返回，后台投递并重试；card 为飞书卡片 JSON（1.0 结构，两种渠道通用） */
  notify(userId: string, kind: NotifyKind, eventType: string, card: Record<string, unknown>, summary = ''): void {
    void (async () => {
      const target = await this.target(userId, kind);
      if (!target) return;
      if (target.channel === 'webhook') {
        this.webhook.notify(eventType, target.url, target.secret, card, summary);
        return;
      }
      await this.deliverToApp(eventType, target, card, summary);
    })().catch((e) => this.logger.warn(`通知投递异常: ${(e as Error).message}`));
  }

  /** 同步发一次，失败抛错；用于需要即时知道结果的场景（测试消息、管理员告警） */
  async sendOnce(target: NotifyTarget, card: Record<string, unknown>): Promise<void> {
    if (target.channel === 'webhook') {
      await this.webhook.sendCardOnce(target.url, target.secret, card);
      return;
    }
    const api = this.feishu.client(await this.feishu.row());
    if (!api || api.appId !== target.appId) throw new Error('飞书自建应用已更换或未配置');
    await api.sendCard(target.openId, withFooter(card));
  }

  private async deliverToApp(
    eventType: string,
    target: Extract<NotifyTarget, { channel: 'app' }>,
    card: Record<string, unknown>,
    summary: string,
  ): Promise<void> {
    const [log] = await this.db
      .insert(webhookDeliveries)
      .values({ eventType, targetUrl: `feishu-app:${target.appId}:${target.openId}`, summary })
      .returning({ id: webhookDeliveries.id });
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt - 1]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      try {
        await this.sendOnce(target, card);
        await this.db
          .update(webhookDeliveries)
          .set({ status: 'success', attempts: attempt, updatedAt: sql`now()` })
          .where(eq(webhookDeliveries.id, log.id));
        return;
      } catch (e) {
        await this.db
          .update(webhookDeliveries)
          .set({
            status: attempt >= BACKOFF_MS.length ? 'failed' : 'pending',
            attempts: attempt,
            lastError: (e as Error).message,
            updatedAt: sql`now()`,
          })
          .where(eq(webhookDeliveries.id, log.id));
      }
    }
  }
}
