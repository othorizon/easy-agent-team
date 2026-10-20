import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import type { UpdateAccountRequest } from '@eat/shared';
import { DB, type Db } from '../db/db.module';
import { users, apiTokens, registrationSettings, userNotifications } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { UserNotificationsService } from '../notify/user-notifications.service';
import type { AuthUser } from './auth.decorators';

@Injectable()
export class AccountService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: UserNotificationsService,
    private readonly audit: AuditService,
  ) {}

  async onboarding(user: Pick<AuthUser, 'id' | 'role'>) {
    const [settings] = await this.db.select().from(registrationSettings).limit(1);
    const [profile] = await this.db.select({
      bio: users.bio, webhookUrl: userNotifications.webhookUrl, verifiedAt: userNotifications.verifiedAt,
    }).from(users).leftJoin(userNotifications, eq(userNotifications.userId, users.id)).where(eq(users.id, user.id));
    const requireBio = user.role !== 'admin' && !!settings?.requireBio;
    const requireNotification = user.role !== 'admin' && !!settings?.requireNotification;
    const bioComplete = !!profile?.bio.trim();
    const notificationComplete = !!profile?.webhookUrl && !!profile.verifiedAt;
    return {
      requireBio, requireNotification, bioComplete, notificationComplete,
      required: (requireBio && !bioComplete) || (requireNotification && !notificationComplete),
    };
  }

  async get(user: AuthUser) {
    const [profile] = await this.db.select({
      id: users.id, name: users.name, email: users.email, role: users.role, bio: users.bio, allowHelp: users.allowHelp,
    }).from(users).where(eq(users.id, user.id));
    return { ...profile, notification: await this.notifications.settings(user.id), onboarding: await this.onboarding(user) };
  }

  async update(user: AuthUser, dto: UpdateAccountRequest) {
    if (Object.keys(dto).length) await this.db.update(users).set(dto).where(eq(users.id, user.id));
    await this.audit.record({ actorId: user.id, action: 'user.profile_updated', targetType: 'user', targetId: user.id });
    return this.get(user);
  }

  async changePassword(user: AuthUser, oldPassword: string, password: string) {
    const error = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.id, user.id)).for('update');
      if (!row || !(await bcrypt.compare(oldPassword, row.passwordHash))) return '原密码不正确';
      await tx.update(users).set({ passwordHash: await bcrypt.hash(password, 10) }).where(eq(users.id, user.id));
      // 沿用管理员重置密码的凭证失效规则。
      await tx.update(apiTokens).set({ revokedAt: sql`now()` })
        .where(and(eq(apiTokens.userId, user.id), isNull(apiTokens.revokedAt)));
      return null;
    });
    if (error) throw new BadRequestException({ error: 'INVALID_PASSWORD', message: error });
    await this.audit.record({ actorId: user.id, action: 'user.password_changed', targetType: 'user', targetId: user.id });
    return { ok: true };
  }
}
