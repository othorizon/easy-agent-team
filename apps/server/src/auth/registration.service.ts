import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import type { LoginResponse, RegisterRequest, RegistrationSettings } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { DB, type Db } from '../db/db.module';
import { registrationSettings, users } from '../db/schema';
import { AuthService } from './auth.service';

/** 开放注册：管理员可开关并限制邮箱后缀（空 = 任意邮箱）；注册产生 member 账号并直接登录 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  async getSettings(): Promise<RegistrationSettings> {
    const row = (await this.db.select().from(registrationSettings).limit(1))[0];
    return { enabled: row?.enabled ?? false, allowedEmailSuffixes: row?.allowedEmailSuffixes ?? [] };
  }

  async updateSettings(actor: { id: string }, dto: RegistrationSettings): Promise<RegistrationSettings> {
    const row = (await this.db.select().from(registrationSettings).limit(1))[0];
    if (row) {
      await this.db
        .update(registrationSettings)
        .set({ enabled: dto.enabled, allowedEmailSuffixes: dto.allowedEmailSuffixes, updatedAt: sql`now()` })
        .where(eq(registrationSettings.id, row.id));
    } else {
      await this.db
        .insert(registrationSettings)
        .values({ enabled: dto.enabled, allowedEmailSuffixes: dto.allowedEmailSuffixes });
    }
    await this.audit.record({
      actorId: actor.id,
      action: 'registration.settings_updated',
      meta: { enabled: dto.enabled, allowedEmailSuffixes: dto.allowedEmailSuffixes },
    });
    return this.getSettings();
  }

  async register(dto: RegisterRequest, ip?: string): Promise<LoginResponse> {
    const settings = await this.getSettings();
    if (!settings.enabled) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '平台未开放注册，请联系管理员开通账号' });
    }
    const email = dto.email.trim().toLowerCase();
    if (settings.allowedEmailSuffixes.length > 0 && !settings.allowedEmailSuffixes.some((s) => email.endsWith(s))) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: `仅允许 ${settings.allowedEmailSuffixes.join(' / ')} 后缀的邮箱注册`,
      });
    }
    const exists = (await this.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
    if (exists) throw new ConflictException({ error: 'CONFLICT', message: '该邮箱已注册，请直接登录' });

    const [row] = await this.db
      .insert(users)
      .values({ name: dto.name, email, role: 'member', passwordHash: await bcrypt.hash(dto.password, 10) })
      .returning({ id: users.id });
    await this.audit.record({ actorId: row.id, action: 'user.registered', targetType: 'user', targetId: row.id, ip });
    // 注册即登录
    return this.auth.login(email, dto.password, ip);
  }
}
