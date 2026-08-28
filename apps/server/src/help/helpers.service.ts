import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { HelperInfo, HelpTargets, UpsertHelperProfileRequest } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { helperProfiles, skills, users } from '../db/schema';

@Injectable()
export class HelpersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async upsertMine(user: AuthUser, dto: UpsertHelperProfileRequest) {
    const webhookUrl = dto.webhookUrl || null;
    const existing = (
      await this.db.select().from(helperProfiles).where(eq(helperProfiles.userId, user.id)).limit(1)
    )[0];
    // 飞书机器人「加签」密钥（决策 16）：由用户从飞书粘贴；留空保持已有值，清空 webhookUrl 时一并清除
    let secretEncrypted = webhookUrl ? (existing?.webhookSecretEncrypted ?? null) : null;
    if (webhookUrl && dto.webhookSecret) {
      secretEncrypted = encryptSecret(dto.webhookSecret);
    }
    if (existing) {
      await this.db
        .update(helperProfiles)
        .set({
          description: dto.description,
          webhookUrl,
          webhookSecretEncrypted: secretEncrypted,
          available: dto.available,
          updatedAt: sql`now()`,
        })
        .where(eq(helperProfiles.userId, user.id));
    } else {
      await this.db.insert(helperProfiles).values({
        userId: user.id,
        description: dto.description,
        webhookUrl,
        webhookSecretEncrypted: secretEncrypted,
        available: dto.available,
      });
    }
    await this.audit.record({ actorId: user.id, action: 'helper.registered', targetType: 'helper_profile', targetId: user.id });
    return this.getMine(user);
  }

  async getMine(user: AuthUser) {
    const row = (
      await this.db.select().from(helperProfiles).where(eq(helperProfiles.userId, user.id)).limit(1)
    )[0];
    if (!row) return { registered: false as const };
    return {
      registered: true as const,
      description: row.description,
      webhookUrl: row.webhookUrl ?? '',
      hasWebhookSecret: !!row.webhookSecretEncrypted,
      available: row.available,
    };
  }

  async removeMine(user: AuthUser) {
    await this.db.delete(helperProfiles).where(eq(helperProfiles.userId, user.id));
    await this.audit.record({ actorId: user.id, action: 'helper.unregistered', targetType: 'helper_profile', targetId: user.id });
    return { ok: true };
  }

  /** 求助对象候选：可接单的登记 helper + 允许求助的 skill 作者。AI 会读取 description 来选人 */
  async targets(): Promise<HelpTargets> {
    const helpers = await this.db
      .select({
        userId: helperProfiles.userId,
        name: users.name,
        email: users.email,
        description: helperProfiles.description,
        available: helperProfiles.available,
        webhookUrl: helperProfiles.webhookUrl,
      })
      .from(helperProfiles)
      .innerJoin(users, eq(helperProfiles.userId, users.id))
      .where(and(eq(helperProfiles.available, true), eq(users.status, 'active')))
      .orderBy(asc(users.name));
    const skillAuthors = await this.db
      .select({
        skillSlug: skills.slug,
        skillName: skills.name,
        skillDescription: skills.description,
        authorId: skills.ownerId,
        authorName: users.name,
      })
      .from(skills)
      .innerJoin(users, eq(skills.ownerId, users.id))
      .where(and(eq(skills.allowHelp, true), eq(users.status, 'active')))
      .orderBy(asc(skills.slug));
    return {
      helpers: helpers.map(
        (h): HelperInfo => ({
          userId: h.userId,
          name: h.name,
          email: h.email,
          description: h.description,
          available: h.available,
          hasWebhook: !!h.webhookUrl,
        }),
      ),
      skillAuthors: skillAuthors.filter((s) => s.skillSlug),
    };
  }

  /** 内部用：取某用户的 webhook 配置（解密 secret） */
  async webhookOf(userId: string): Promise<{ url: string; secret: string | null } | null> {
    const row = (
      await this.db.select().from(helperProfiles).where(eq(helperProfiles.userId, userId)).limit(1)
    )[0];
    if (!row?.webhookUrl) return null;
    return {
      url: row.webhookUrl,
      secret: row.webhookSecretEncrypted ? decryptSecret(row.webhookSecretEncrypted) : null,
    };
  }
}
