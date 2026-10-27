import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import {
  FEISHU_APP_SCOPES,
  FEISHU_BIND_CODE_ALPHABET,
  FEISHU_BIND_CODE_LENGTH,
  FEISHU_BIND_CODE_PREFIX,
  FEISHU_BIND_CODE_TTL_SECONDS,
  feishuBotOpenUrl,
  feishuScopeApplyUrl,
  feishuScopesImportJson,
  type FeishuAppBindingInfo,
  type FeishuAppCheck,
  type FeishuAppCredentials,
  type FeishuBindCode,
  type FeishuScopeApplyResult,
  type FeishuSettingsInfo,
  type NotificationChannel,
} from '@eat/shared';
import { DB, type Db } from '../../db/db.module';
import { feishuBindCodes, feishuBindings, feishuSettings, users } from '../../db/schema';
import { decryptSecret, encryptSecret, sha256Hex } from '../../common/crypto';
import { AuditService } from '../../audit/audit.service';
import { loadConfig } from '../../config';
import { FeishuApi, FeishuApiError } from './feishu-api';

type SettingsRow = typeof feishuSettings.$inferSelect;

export interface FeishuSecrets {
  appId: string;
  verificationToken: string;
  encryptKey: string;
}

export type BindResult =
  | { ok: true; name: string; email: string; replaced: boolean }
  | { ok: false; reason: 'invalid' | 'disabled' };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 权限两个接口文档里列出的错误码（「向管理员申请授权」「查询租户授权状态」，均为公开接口、无需额外权限），
 * 翻成管理员能照着做的话；其余错误照飞书原文显示。
 */
const SCOPE_ERRORS: Record<number, string> = {
  212001: '剩余未授权的都是高敏权限，不能通过接口申请，请在开发者后台提交，或请企业管理员在管理后台审批',
  212002: '没有需要申请的权限，可能刚刚已全部授权，请点「检查状态」刷新',
  212003: '这个版本向管理员申请授权的次数已达上限（每个版本 10 次），请直接联系企业管理员审批，或发布新版本后再申请',
  212004: '已经申请过，正在等待企业管理员审批',
  212100: '应用还没有在企业内安装：请在开发者后台「版本管理与发布」发布版本，并等待企业管理员审核通过',
};
const scopeError = (e: unknown) => (e instanceof FeishuApiError && SCOPE_ERRORS[e.code]) || message(e);
const bindHash = (code: string) => sha256Hex(`feishu-bind:${code}`);

/**
 * 飞书自建应用渠道（决策 92）：管理员侧的接入配置 / 状态检查 / 权限申请 / 渠道切换，
 * 以及成员侧的绑定码与绑定关系。消息收发、回调处理在 FeishuCallbackService / NotifierService。
 */
@Injectable()
export class FeishuAppService {
  private api: FeishuApi | null = null;
  private apiKey = '';

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async row(): Promise<SettingsRow> {
    const [row] = await this.db.select().from(feishuSettings).where(eq(feishuSettings.id, 1));
    if (row) return row;
    await this.db.insert(feishuSettings).values({ id: 1 }).onConflictDoNothing();
    return (await this.db.select().from(feishuSettings).where(eq(feishuSettings.id, 1)))[0];
  }

  async channel(): Promise<NotificationChannel> {
    return (await this.row()).channel;
  }

  /** 当前凭据对应的客户端（凭据没变就复用，tenant token 跟着缓存）；没配置时为 null */
  client(row: SettingsRow): FeishuApi | null {
    if (!row.appId || !row.appSecretEncrypted) return null;
    const key = `${row.appId}:${sha256Hex(row.appSecretEncrypted)}`;
    if (this.apiKey !== key) {
      this.api = new FeishuApi(row.appId, decryptSecret(row.appSecretEncrypted));
      this.apiKey = key;
    }
    return this.api;
  }

  /** 回调验签与解密所需的值；任一缺失说明回调还没法接 */
  secrets(row: SettingsRow): FeishuSecrets | null {
    if (!row.appId || !row.verificationTokenEncrypted || !row.encryptKeyEncrypted) return null;
    return {
      appId: row.appId,
      verificationToken: decryptSecret(row.verificationTokenEncrypted),
      encryptKey: decryptSecret(row.encryptKeyEncrypted),
    };
  }

  callbackUrl(): string {
    return `${loadConfig().publicUrl.replace(/\/$/, '')}/api/feishu/callback`;
  }

  blockers(row: SettingsRow): string[] {
    if (!row.appId || !row.appSecretEncrypted) return ['尚未填写 App ID 与 App Secret'];
    const out: string[] = [];
    if (!row.verificationTokenEncrypted || !row.encryptKeyEncrypted) out.push('尚未填写 Verification Token 与 Encrypt Key');
    const check = row.lastCheck;
    if (!check) out.push('尚未检查应用状态');
    else if (!check.credentialsOk) out.push('App ID 或 App Secret 无法通过校验');
    else {
      if (!check.botActive) out.push('应用未开启机器人能力，或开启后还没有发布版本');
      const missing = check.scopes.filter((s) => s.status !== 'granted');
      if (missing.length) out.push(`权限未开通：${missing.map((s) => s.name).join('、')}`);
    }
    if (!row.callbackVerifiedAt) out.push('开发者后台的请求地址还没有通过验证');
    return out;
  }

  async info(): Promise<FeishuSettingsInfo> {
    const row = await this.row();
    const [{ bound }] = await this.db
      .select({ bound: sql<number>`count(*)::int` })
      .from(feishuBindings)
      .innerJoin(users, eq(users.id, feishuBindings.userId))
      .where(and(eq(feishuBindings.appId, row.appId), eq(users.status, 'active')));
    const [{ active }] = await this.db
      .select({ active: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.status, 'active'));
    const blockers = this.blockers(row);
    return {
      channel: row.channel,
      appId: row.appId,
      hasAppSecret: !!row.appSecretEncrypted,
      hasVerificationToken: !!row.verificationTokenEncrypted,
      hasEncryptKey: !!row.encryptKeyEncrypted,
      callbackUrl: this.callbackUrl(),
      botName: row.botName,
      botAvatarUrl: row.botAvatarUrl,
      check: row.lastCheck ?? null,
      callbackVerifiedAt: row.callbackVerifiedAt?.toISOString() ?? null,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      ready: blockers.length === 0,
      blockers,
      boundUsers: row.appId ? bound : 0,
      activeUsers: active,
      scopesImportJson: feishuScopesImportJson(),
    };
  }

  async saveCredentials(actorId: string, dto: FeishuAppCredentials): Promise<FeishuSettingsInfo> {
    const row = await this.row();
    const changedApp = row.appId !== dto.appId;
    if (changedApp && row.channel === 'app') {
      throw new ConflictException({
        error: 'FEISHU_APP_IN_USE',
        message: '正在使用自建应用渠道，换应用会让所有成员的绑定失效。请先切回 Webhook 渠道再更换应用',
      });
    }
    // 换了应用时旧的 Secret 等一律作废，必须重新填，避免把 A 应用的密钥配到 B 应用上
    const keep = (value: string | undefined, stored: string | null) =>
      value ? encryptSecret(value) : changedApp ? null : stored;
    const next = {
      appId: dto.appId,
      appSecretEncrypted: keep(dto.appSecret, row.appSecretEncrypted),
      verificationTokenEncrypted: keep(dto.verificationToken, row.verificationTokenEncrypted),
      encryptKeyEncrypted: keep(dto.encryptKey, row.encryptKeyEncrypted),
    };
    if (!next.appSecretEncrypted || !next.verificationTokenEncrypted || !next.encryptKeyEncrypted) {
      throw new BadRequestException({
        error: 'FEISHU_APP_INCOMPLETE',
        message:
          changedApp && row.appId
            ? '更换应用后需要重新填写 App Secret、Verification Token 与 Encrypt Key'
            : '请填写 App Secret、Verification Token 与 Encrypt Key',
      });
    }
    // 验签用的值真的变了，之前那次地址验证就不能再算数（原样重填不算）
    const differs = (value: string | undefined, stored: string | null) =>
      !!value && (!stored || decryptSecret(stored) !== value);
    const callbackChanged =
      changedApp || differs(dto.verificationToken, row.verificationTokenEncrypted) || differs(dto.encryptKey, row.encryptKeyEncrypted);
    await this.db
      .update(feishuSettings)
      .set({
        ...next,
        ...(changedApp ? { botName: null, botAvatarUrl: null, lastCheck: null, lastEventAt: null } : {}),
        ...(callbackChanged ? { callbackVerifiedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(feishuSettings.id, 1));
    await this.audit.record({
      actorId,
      action: 'settings.feishu_app_saved',
      targetType: 'feishu_setting',
      targetId: dto.appId,
      meta: { changedApp, rotated: Object.entries(dto).filter(([k, v]) => k !== 'appId' && v).map(([k]) => k) },
    });
    await this.check();
    return this.info();
  }

  /** 检查凭据、机器人能力与权限授权状态，结果落库供页面展示与切换渠道时判定 */
  async check(): Promise<FeishuAppCheck> {
    const row = await this.row();
    const api = this.client(row);
    if (!api) throw new BadRequestException({ error: 'FEISHU_APP_UNCONFIGURED', message: '请先填写 App ID 与 App Secret' });
    const result: FeishuAppCheck = {
      checkedAt: new Date().toISOString(),
      credentialsOk: false,
      botActive: false,
      scopes: [],
      scopesError: '',
      error: '',
    };
    let botName = row.botName;
    let botAvatarUrl = row.botAvatarUrl;
    try {
      await api.tenantToken();
      result.credentialsOk = true;
    } catch (e) {
      result.error = message(e);
    }
    if (result.credentialsOk) {
      try {
        const bot = await api.botInfo();
        // 2 = 已启用；字段缺失时按接口调通即可用处理
        result.botActive = bot.activate_status === undefined || bot.activate_status === 2;
        if (!result.botActive) result.error = `机器人尚未启用（activate_status=${bot.activate_status}），请在开发者后台发布版本并等待审核通过`;
        botName = bot.app_name || botName;
        botAvatarUrl = bot.avatar_url || botAvatarUrl;
      } catch (e) {
        result.error = `机器人能力不可用，请在开发者后台「添加应用能力」里开启机器人并发布版本（${message(e)}）`;
      }
      try {
        const grants = await api.scopes();
        result.scopes = FEISHU_APP_SCOPES.map((s) => {
          const grant = grants.find((g) => g.scope_name === s.scope && (g.scope_type ?? 'tenant') === 'tenant');
          return { ...s, status: !grant ? 'missing' : grant.grant_status === 1 ? 'granted' : 'pending' };
        });
      } catch (e) {
        result.scopesError = scopeError(e);
      }
    }
    await this.db
      .update(feishuSettings)
      .set({ lastCheck: result, botName, botAvatarUrl })
      .where(eq(feishuSettings.id, 1));
    return result;
  }

  async applyScopes(actorId: string): Promise<FeishuScopeApplyResult> {
    const check = await this.check();
    if (!check.credentialsOk) throw new BadRequestException({ error: 'FEISHU_APP_INVALID', message: check.error });
    if (check.scopesError) {
      return {
        applied: false,
        message: `无法查询权限状态（${check.scopesError}），请在开发者后台核对`,
        consoleUrl: feishuScopeApplyUrl((await this.row()).appId, FEISHU_APP_SCOPES.map((s) => s.scope)),
      };
    }
    const row = await this.row();
    const pending = check.scopes.filter((s) => s.status === 'pending');
    const missing = check.scopes.filter((s) => s.status === 'missing');
    const consoleUrl = missing.length ? feishuScopeApplyUrl(row.appId, missing.map((s) => s.scope)) : null;
    if (!pending.length) {
      return {
        applied: false,
        consoleUrl,
        message: missing.length
          ? '这些权限还没有添加到应用：在打开的开发者后台页面里开通，再「创建版本并发布」后生效'
          : '所需权限都已开通',
      };
    }
    try {
      await this.client(row)!.applyScopes();
    } catch (e) {
      const known = e instanceof FeishuApiError && SCOPE_ERRORS[e.code];
      return { applied: false, consoleUrl, message: known || `向管理员申请授权失败：${message(e)}` };
    }
    await this.audit.record({
      actorId,
      action: 'settings.feishu_scopes_applied',
      targetType: 'feishu_setting',
      targetId: row.appId,
      meta: { scopes: pending.map((s) => s.scope) },
    });
    return {
      applied: true,
      consoleUrl,
      message: missing.length
        ? '已向企业管理员申请已添加的权限；其余权限还需在开发者后台添加并发布版本'
        : '已向企业管理员发起授权申请，审核通过后点「检查状态」确认',
    };
  }

  async setChannel(actorId: string, channel: NotificationChannel): Promise<FeishuSettingsInfo> {
    if (channel === 'app') {
      const row = await this.row();
      if (row.appId && row.appSecretEncrypted) await this.check();
      const blockers = this.blockers(await this.row());
      if (blockers.length) {
        throw new BadRequestException({ error: 'FEISHU_APP_NOT_READY', message: `还不能切换：${blockers.join('；')}` });
      }
    }
    await this.db.update(feishuSettings).set({ channel, updatedAt: new Date() }).where(eq(feishuSettings.id, 1));
    await this.audit.record({ actorId, action: 'settings.notification_channel', targetType: 'feishu_setting', meta: { channel } });
    return this.info();
  }

  /** 收到一条通过验签的推送：说明请求地址已配好。按分钟节流写库 */
  async touchCallback(kind: 'verification' | 'event'): Promise<void> {
    const now = new Date();
    const stale = sql`now() - interval '1 minute'`;
    await this.db
      .update(feishuSettings)
      .set(kind === 'event' ? { callbackVerifiedAt: now, lastEventAt: now } : { callbackVerifiedAt: now })
      .where(
        and(
          eq(feishuSettings.id, 1),
          kind === 'event'
            ? sql`(${feishuSettings.lastEventAt} IS NULL OR ${feishuSettings.lastEventAt} < ${stale} OR ${feishuSettings.callbackVerifiedAt} IS NULL)`
            : sql`true`,
        ),
      );
  }

  // ---------------------------------------------------------------- 成员侧

  async binding(userId: string, row?: SettingsRow): Promise<FeishuAppBindingInfo | null> {
    row ??= await this.row();
    if (!row.appId || !row.appSecretEncrypted) return null;
    const [binding] = await this.db.select().from(feishuBindings).where(eq(feishuBindings.userId, userId));
    const bound = !!binding && binding.appId === row.appId;
    return {
      appId: row.appId,
      botName: row.botName,
      botAvatarUrl: row.botAvatarUrl,
      openBotUrl: feishuBotOpenUrl(row.appId),
      bound,
      boundAt: bound ? binding.boundAt.toISOString() : null,
      stale: !!binding && !bound,
    };
  }

  async createBindCode(userId: string): Promise<FeishuBindCode> {
    const row = await this.row();
    if (!row.appId || !row.appSecretEncrypted) {
      throw new BadRequestException({ error: 'FEISHU_APP_UNCONFIGURED', message: '管理员还没有配置飞书自建应用' });
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      let code = FEISHU_BIND_CODE_PREFIX;
      for (let i = 0; i < FEISHU_BIND_CODE_LENGTH; i++) code += FEISHU_BIND_CODE_ALPHABET[randomInt(FEISHU_BIND_CODE_ALPHABET.length)];
      const expiresAt = new Date(Date.now() + FEISHU_BIND_CODE_TTL_SECONDS * 1000);
      try {
        await this.db
          .insert(feishuBindCodes)
          .values({ userId, codeHash: bindHash(code), expiresAt })
          .onConflictDoUpdate({
            target: feishuBindCodes.userId,
            set: { codeHash: bindHash(code), expiresAt, createdAt: new Date() },
          });
        return { code, expiresAt: expiresAt.toISOString(), ttlSeconds: FEISHU_BIND_CODE_TTL_SECONDS };
      } catch (e) {
        // 与别人仍有效的绑定码撞了哈希（概率约十亿分之一），换一个
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
    throw new ConflictException('绑定码生成失败，请重试');
  }

  /**
   * 用私聊收到的绑定码完成绑定。一个飞书账号只对应一个 EAT 账号：
   * 同一个飞书账号用另一个 EAT 账号生成的码再绑一次，视为本人把通知转到新账号，旧绑定解除。
   */
  async bindByCode(code: string, appId: string, openId: string, unionId: string | null): Promise<BindResult> {
    const result = await this.db.transaction(async (tx): Promise<BindResult & { userId?: string; previous?: string }> => {
      const [pending] = await tx
        .select()
        .from(feishuBindCodes)
        .where(and(eq(feishuBindCodes.codeHash, bindHash(code)), gt(feishuBindCodes.expiresAt, new Date())))
        .for('update');
      if (!pending) return { ok: false, reason: 'invalid' };
      await tx.delete(feishuBindCodes).where(eq(feishuBindCodes.userId, pending.userId));
      const [user] = await tx.select().from(users).where(eq(users.id, pending.userId));
      if (!user || user.status !== 'active') return { ok: false, reason: 'disabled' };
      const [previous] = await tx
        .select({ userId: feishuBindings.userId })
        .from(feishuBindings)
        .where(and(eq(feishuBindings.appId, appId), eq(feishuBindings.openId, openId)));
      if (previous && previous.userId !== user.id) {
        await tx.delete(feishuBindings).where(eq(feishuBindings.userId, previous.userId));
      }
      await tx
        .insert(feishuBindings)
        .values({ userId: user.id, appId, openId, unionId })
        .onConflictDoUpdate({
          target: feishuBindings.userId,
          set: { appId, openId, unionId, boundAt: new Date() },
        });
      return {
        ok: true,
        name: user.name,
        email: user.email,
        replaced: !!previous && previous.userId !== user.id,
        userId: user.id,
        previous: previous && previous.userId !== user.id ? previous.userId : undefined,
      };
    });
    if (result.ok) {
      await this.audit.record({
        actorId: result.userId,
        action: 'notification.feishu_bound',
        targetType: 'user',
        targetId: result.userId,
        meta: { appId, ...(result.previous ? { movedFrom: result.previous } : {}) },
      });
      return { ok: true, name: result.name, email: result.email, replaced: result.replaced };
    }
    return { ok: false, reason: result.reason };
  }

  async unbind(userId: string): Promise<void> {
    await this.db.delete(feishuBindings).where(eq(feishuBindings.userId, userId));
    await this.db.delete(feishuBindCodes).where(eq(feishuBindCodes.userId, userId));
    await this.audit.record({ actorId: userId, action: 'notification.feishu_unbound', targetType: 'user', targetId: userId });
  }

  /** 卡片回调里的操作人 → 已绑定当前应用的启用中 EAT 用户 */
  async userByOpenId(appId: string, openId: string) {
    const [row] = await this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status })
      .from(feishuBindings)
      .innerJoin(users, eq(users.id, feishuBindings.userId))
      .where(and(eq(feishuBindings.appId, appId), eq(feishuBindings.openId, openId)));
    return row?.status === 'active' ? row : null;
  }

  async openIdOf(userId: string, appId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ openId: feishuBindings.openId })
      .from(feishuBindings)
      .innerJoin(users, eq(users.id, feishuBindings.userId))
      .where(and(eq(feishuBindings.userId, userId), eq(feishuBindings.appId, appId), eq(users.status, 'active')));
    return row?.openId ?? null;
  }
}
