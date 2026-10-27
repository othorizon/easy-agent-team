import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { HelperInfo, HelpTargets, UpsertHelperProfileRequest } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { feishuBindings, skills, users, userNotifications } from '../db/schema';
import { UserNotificationsService } from '../notify/user-notifications.service';
import { FeishuAppService } from '../notify/feishu/feishu-app.service';

@Injectable()
export class HelpersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: UserNotificationsService,
    private readonly feishu: FeishuAppService,
  ) {}

  /** 旧客户端兼容入口：简介只保存在用户资料，不能绕过 Webhook 验证。 */
  async upsertMine(user: AuthUser, dto: UpsertHelperProfileRequest) {
    if (dto.webhookUrl !== undefined || dto.webhookSecret !== undefined ||
        dto.notifyHelp !== undefined || dto.notifyReply !== undefined) {
      throw new BadRequestException({ error: 'NOTIFICATION_MOVED', message: '请在用户中心配置并验证飞书 Webhook' });
    }
    await this.db.update(users).set({ bio: dto.description.trim(), allowHelp: dto.available }).where(eq(users.id, user.id));
    await this.audit.record({ actorId: user.id, action: 'user.profile_updated', targetType: 'user', targetId: user.id });
    return this.getMine(user);
  }

  async getMine(user: AuthUser) {
    const [row] = await this.db.select().from(users).where(eq(users.id, user.id));
    return { registered: !!row?.bio.trim(), description: row?.bio ?? '', available: row?.allowHelp ?? true };
  }

  async removeMine(user: AuthUser) {
    await this.db.update(users).set({ allowHelp: false }).where(eq(users.id, user.id));
    await this.audit.record({ actorId: user.id, action: 'user.help_disabled', targetType: 'user', targetId: user.id });
    return { ok: true };
  }

  /** AI 读取用户个人简介；正常且允许求助的用户自动进入候选名单。 */
  async targets(): Promise<HelpTargets> {
    const feishu = await this.feishu.row();
    const helpers = await this.db.select({
      userId: users.id, name: users.name, email: users.email, description: users.bio,
      available: users.allowHelp, webhookUrl: userNotifications.webhookUrl, verifiedAt: userNotifications.verifiedAt,
      feishuAppId: feishuBindings.appId,
    }).from(users).leftJoin(userNotifications, eq(userNotifications.userId, users.id))
      .leftJoin(feishuBindings, eq(feishuBindings.userId, users.id))
      .where(and(eq(users.allowHelp, true), eq(users.status, 'active'), sql`length(trim(${users.bio})) > 0`))
      .orderBy(asc(users.name));
    const skillAuthors = await this.db.select({
      skillSlug: skills.slug, skillName: skills.name, skillDescription: skills.description,
      authorId: skills.ownerId, authorName: users.name,
    }).from(skills).innerJoin(users, eq(skills.ownerId, users.id))
      .where(and(eq(skills.allowHelp, true), eq(users.allowHelp, true), eq(users.status, 'active')))
      .orderBy(asc(skills.slug));
    return {
      helpers: helpers.map((h): HelperInfo => ({
        userId: h.userId, name: h.name, email: h.email, description: h.description,
        available: h.available,
        // 字段名沿用旧称：含义是「当前通知渠道下能收到通知」（决策 92）
        hasWebhook: feishu.channel === 'app' ? !!feishu.appId && h.feishuAppId === feishu.appId : !!h.webhookUrl && !!h.verifiedAt,
      })),
      skillAuthors: skillAuthors.filter((s) => s.skillSlug),
    };
  }

  webhookOf(userId: string, kind: 'help' | 'reply') {
    return this.notifications.webhookOf(userId, kind);
  }
}
