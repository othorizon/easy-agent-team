import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { DevicePollResponse, DeviceStartResponse, LoginResponse, UserPublic } from '@eat/shared';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../common/crypto';
import { loadConfig } from '../config';
import { DB, type Db } from '../db/db.module';
import { apiTokens, deviceAuths, users } from '../db/schema';

const WEB_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const DEVICE_FLOW_TTL_MS = 10 * 60 * 1000;
/** 去掉易混淆字符的用户码字母表 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function toPublic(u: { id: string; name: string; email: string; role: 'admin' | 'member' }): UserPublic {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string, ip?: string): Promise<LoginResponse> {
    const user = (
      await this.db.select().from(users).where(eq(users.email, email)).limit(1)
    )[0];
    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: '邮箱或密码不正确' });
    }
    const { token } = await this.issueToken(user.id, 'Web 登录', 'web', new Date(Date.now() + WEB_TOKEN_TTL_MS));
    await this.audit.record({ actorId: user.id, action: 'auth.login', ip });
    return { token, user: toPublic(user) };
  }

  async issueToken(
    userId: string,
    name: string,
    kind: 'web' | 'cli',
    expiresAt?: Date,
  ): Promise<{ token: string; tokenId: string }> {
    const token = randomToken();
    const [row] = await this.db
      .insert(apiTokens)
      .values({ userId, name, kind, tokenHash: sha256Hex(token), expiresAt })
      .returning({ id: apiTokens.id });
    await this.audit.record({
      actorId: userId,
      action: 'token.created',
      targetType: 'api_token',
      targetId: row.id,
      meta: { name, kind },
    });
    return { token, tokenId: row.id };
  }

  async listTokens(userId: string) {
    return this.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        kind: apiTokens.kind,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
        expiresAt: apiTokens.expiresAt,
        revokedAt: apiTokens.revokedAt,
      })
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .orderBy(desc(apiTokens.createdAt));
  }

  async revokeToken(actor: { id: string; role: string }, tokenId: string) {
    const row = (
      await this.db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).limit(1)
    )[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Token 不存在' });
    if (row.userId !== actor.id && actor.role !== 'admin') {
      throw new UnauthorizedException({ error: 'FORBIDDEN', message: '只能吊销自己的 Token' });
    }
    await this.db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
    await this.audit.record({ actorId: actor.id, action: 'token.revoked', targetType: 'api_token', targetId: tokenId });
    return { ok: true };
  }

  // ---------- 设备码授权（CLI 登录） ----------

  async deviceStart(): Promise<DeviceStartResponse> {
    const deviceCode = randomBytes(32).toString('hex');
    const chars = Array.from(randomBytes(8)).map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]);
    const userCode = `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
    await this.db.insert(deviceAuths).values({
      deviceCodeHash: sha256Hex(deviceCode),
      userCode,
      expiresAt: new Date(Date.now() + DEVICE_FLOW_TTL_MS),
    });
    return {
      deviceCode,
      userCode,
      verificationUri: `${loadConfig().publicUrl}/device`,
      interval: 3,
      expiresIn: DEVICE_FLOW_TTL_MS / 1000,
    };
  }

  async deviceApprove(user: { id: string }, userCode: string, tokenName?: string) {
    const row = (
      await this.db
        .select()
        .from(deviceAuths)
        .where(and(eq(deviceAuths.userCode, userCode.toUpperCase().trim()), eq(deviceAuths.status, 'pending')))
        .limit(1)
    )[0];
    if (!row || row.expiresAt < new Date()) {
      throw new BadRequestException({ error: 'NOT_FOUND', message: '设备码不存在或已过期，请在 CLI 重新发起登录' });
    }
    const name = tokenName?.trim() || `CLI（${new Date().toISOString().slice(0, 10)} 授权）`;
    const { token } = await this.issueToken(user.id, name, 'cli');
    await this.db
      .update(deviceAuths)
      .set({ status: 'approved', userId: user.id, issuedTokenEncrypted: encryptSecret(token) })
      .where(eq(deviceAuths.id, row.id));
    await this.audit.record({ actorId: user.id, action: 'auth.device_approve', targetType: 'device_auth', targetId: row.id });
    return { ok: true };
  }

  async devicePoll(deviceCode: string): Promise<DevicePollResponse> {
    const row = (
      await this.db
        .select()
        .from(deviceAuths)
        .where(eq(deviceAuths.deviceCodeHash, sha256Hex(deviceCode)))
        .limit(1)
    )[0];
    if (!row || row.status === 'expired' || row.status === 'delivered' || row.expiresAt < new Date()) {
      return { status: 'expired' };
    }
    if (row.status === 'pending') return { status: 'pending' };
    // approved：交付 Token 后立即清空暂存密文
    const token = decryptSecret(row.issuedTokenEncrypted!);
    await this.db
      .update(deviceAuths)
      .set({ status: 'delivered', issuedTokenEncrypted: null })
      .where(eq(deviceAuths.id, row.id));
    const user = (
      await this.db.select().from(users).where(eq(users.id, row.userId!)).limit(1)
    )[0];
    return { status: 'approved', token, user: toPublic(user) };
  }
}
