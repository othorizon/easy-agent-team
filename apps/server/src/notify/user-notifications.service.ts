import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import { feishuWebhookSchema, type NotificationPreferences } from '@eat/shared';
import { DB, type Db } from '../db/db.module';
import { userNotifications } from '../db/schema';
import { decryptSecret, encryptSecret, sha256Hex } from '../common/crypto';
import { AuditService } from '../audit/audit.service';
import { WebhookService } from './webhook.service';

const CLEAR_CHALLENGE = {
  pendingUrl: null, pendingSecretEncrypted: null, challengeId: null,
  codeHash: null, expiresAt: null, attempts: 0,
};

@Injectable()
export class UserNotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly webhook: WebhookService,
    private readonly audit: AuditService,
  ) {}

  async settings(userId: string) {
    const [row] = await this.db.select().from(userNotifications).where(eq(userNotifications.userId, userId));
    return {
      webhookUrl: row?.webhookUrl ?? '',
      hasWebhookSecret: !!row?.webhookSecretEncrypted,
      verified: !!row?.webhookUrl && !!row.verifiedAt,
      notifyHelp: row?.notifyHelp ?? true,
      notifyReply: row?.notifyReply ?? true,
      notifyMention: row?.notifyMention ?? true,
      notifyApprovalRequest: row?.notifyApprovalRequest ?? true,
      notifyApprovalResult: row?.notifyApprovalResult ?? true,
    };
  }

  async preferences(userId: string, dto: Partial<NotificationPreferences>) {
    await this.db.insert(userNotifications).values({ userId, ...dto })
      .onConflictDoUpdate({ target: userNotifications.userId, set: dto });
    return this.settings(userId);
  }

  async sendCode(userId: string, dto: { webhookUrl: string; webhookSecret?: string }) {
    const url = feishuWebhookSchema.parse(dto.webhookUrl);
    const result = await this.db.transaction(async (tx) => {
      await tx.insert(userNotifications).values({ userId }).onConflictDoNothing();
      // 串行化同一用户的发送、验证和移除，适用于多实例部署。
      const [row] = await tx.select().from(userNotifications)
        .where(eq(userNotifications.userId, userId)).for('update');
      if (row.sentAt && Date.now() - row.sentAt.getTime() < 60_000) {
        return { error: '请等待 60 秒后再发送验证码' };
      }
      const secret = dto.webhookSecret === undefined
        ? (row.webhookUrl === url && row.webhookSecretEncrypted ? decryptSecret(row.webhookSecretEncrypted) : null)
        : dto.webhookSecret || null;
      const code = String(randomInt(100000, 1000000));
      const challengeId = randomUUID();
      await tx.update(userNotifications).set({
        ...CLEAR_CHALLENGE, sentAt: new Date(),
      }).where(eq(userNotifications.userId, userId));
      try {
        // 不使用后台重试：旧验证码不得在新验证码之后延迟投递。
        await this.webhook.sendVerification(url, secret, code);
      } catch {
        return { error: '验证码发送失败，请检查机器人地址、加签密钥及机器人的安全设置后重试' };
      }
      await tx.update(userNotifications).set({
        pendingUrl: url,
        pendingSecretEncrypted: secret ? encryptSecret(secret) : null,
        challengeId, codeHash: sha256Hex(`${challengeId}:${code}`),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      }).where(eq(userNotifications.userId, userId));
      return { challengeId, expiresIn: 600, retryAfter: 60 };
    });
    if ('error' in result) throw new BadRequestException({ error: 'VERIFICATION_FAILED', message: result.error });
    return result;
  }

  async verify(userId: string, challengeId: string, code: string) {
    const error = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(userNotifications)
        .where(eq(userNotifications.userId, userId)).for('update');
      if (!row || row.challengeId !== challengeId || !row.expiresAt ||
          row.expiresAt.getTime() <= Date.now() || !row.pendingUrl || row.attempts >= 5) {
        return '验证码已失效，请重新发送';
      }
      if (row.codeHash !== sha256Hex(`${challengeId}:${code}`)) {
        await tx.update(userNotifications).set({ attempts: row.attempts + 1 })
          .where(eq(userNotifications.userId, userId));
        return row.attempts >= 4 ? '验证码错误次数过多，请重新发送' : '验证码不正确';
      }
      await tx.update(userNotifications).set({
        webhookUrl: row.pendingUrl,
        webhookSecretEncrypted: row.pendingSecretEncrypted,
        verifiedAt: new Date(),
        ...CLEAR_CHALLENGE,
      }).where(eq(userNotifications.userId, userId));
      return null;
    });
    // 在事务提交后抛出，保留错误次数。
    if (error) throw new BadRequestException({ error: 'VERIFICATION_FAILED', message: error });
    await this.audit.record({ actorId: userId, action: 'notification.verified', targetType: 'user', targetId: userId });
    return this.settings(userId);
  }

  async remove(userId: string) {
    await this.db.update(userNotifications).set({
      webhookUrl: null, webhookSecretEncrypted: null, verifiedAt: null, ...CLEAR_CHALLENGE,
    }).where(eq(userNotifications.userId, userId));
    await this.audit.record({ actorId: userId, action: 'notification.removed', targetType: 'user', targetId: userId });
    return this.settings(userId);
  }

  async webhookOf(userId: string, kind: 'help' | 'reply' | 'mention') {
    const [row] = await this.db.select().from(userNotifications).where(eq(userNotifications.userId, userId));
    if (!row?.webhookUrl || !row.verifiedAt ||
      !(kind === 'help' ? row.notifyHelp : kind === 'reply' ? row.notifyReply : row.notifyMention)) return null;
    return {
      url: row.webhookUrl,
      secret: row.webhookSecretEncrypted ? decryptSecret(row.webhookSecretEncrypted) : null,
    };
  }
}
