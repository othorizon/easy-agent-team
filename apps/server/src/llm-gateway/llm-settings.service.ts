import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { LlmAccountInfo, LlmSettingsInfo, LlmSettingsRequest } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { DB, PG_POOL, type Db } from '../db/db.module';
import { llmGatewayKeys, llmGatewaySettings } from '../db/schema';
import { NewApiClient } from './newapi.client';

export const LLM_SETTINGS_LOCK = 1950536503;

@Injectable()
export class LlmSettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async row() {
    return (await this.db.select().from(llmGatewaySettings).where(eq(llmGatewaySettings.id, 1)))[0];
  }
  async configured() {
    const row = await this.row();
    if (!row)
      throw new ServiceUnavailableException({ error: 'LLM_NOT_CONFIGURED', message: '管理员尚未配置 LLM API 网关' });
    return { row, client: new NewApiClient(row.apiUrl, decryptSecret(row.accessTokenEncrypted)) };
  }
  async info(): Promise<LlmSettingsInfo> {
    const row = await this.row();
    const token = row ? decryptSecret(row.accessTokenEncrypted) : '';
    return {
      configured: !!row,
      apiUrl: row?.apiUrl ?? '',
      accessTokenMasked: token ? `${token.slice(0, 3)}****${token.slice(-3)}` : '',
      accountId: row?.accountId ?? null,
      accountName: row?.accountName ?? '',
      defaultQuota: row?.defaultQuota ?? 0,
      currency: row?.currency ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }
  private async candidate(dto: LlmSettingsRequest) {
    const old = await this.row();
    const token = dto.accessToken || (old ? decryptSecret(old.accessTokenEncrypted) : '');
    if (!token) throw new BadRequestException('请输入 New API 系统访问令牌');
    const apiUrl = dto.apiUrl.replace(/\/+$/, '');
    const client = new NewApiClient(apiUrl, token);
    const self = await client.self();
    if (!Number.isSafeInteger(self.id) || self.id <= 0) throw new BadRequestException('New API 未返回有效账户');
    await client.tokens();
    const currency = await client.currency();
    return { apiUrl, token, self, currency, client };
  }
  async test(dto: LlmSettingsRequest) {
    const start = Date.now();
    try {
      const c = await this.candidate(dto);
      return {
        ok: true,
        message: `连接成功，公共账户：${c.self.username}（${c.self.id}）`,
        latencyMs: Date.now() - start,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '连接失败', latencyMs: Date.now() - start };
    }
  }
  async save(dto: LlmSettingsRequest, actorId: string) {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query('select pg_try_advisory_lock($1) as ok', [LLM_SETTINGS_LOCK]);
      if (!acquired.rows[0].ok) throw new ConflictException('网关正在处理操作，请稍后保存设置');
      const c = await this.candidate(dto);
      const old = await this.row();
      const hasKeys = (await this.db.select({ id: llmGatewayKeys.id }).from(llmGatewayKeys).limit(1)).length > 0;
      if (hasKeys && old && (old.apiUrl !== c.apiUrl || old.accountId !== c.self.id)) {
        throw new ConflictException('已有 Key，不能直接更换 New API 实例或账户；请单独迁移。可以轮换同账户访问令牌');
      }
      await this.db
        .insert(llmGatewaySettings)
        .values({
          id: 1,
          apiUrl: c.apiUrl,
          accessTokenEncrypted: encryptSecret(c.token),
          accountId: c.self.id,
          accountName: c.self.username,
          defaultQuota: dto.defaultQuota,
          currency: c.currency,
        })
        .onConflictDoUpdate({
          target: llmGatewaySettings.id,
          set: {
            apiUrl: c.apiUrl,
            accessTokenEncrypted: encryptSecret(c.token),
            accountId: c.self.id,
            accountName: c.self.username,
            defaultQuota: dto.defaultQuota,
            currency: c.currency,
            updatedAt: sql`now()`,
          },
        });
      await this.audit.record({
        actorId,
        action: 'llm.settings.updated',
        targetType: 'llm_gateway',
        meta: { apiUrl: c.apiUrl, accountId: c.self.id, defaultQuota: dto.defaultQuota },
      });
      return this.info();
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [LLM_SETTINGS_LOCK]);
      lock.release();
    }
  }
  async account(): Promise<LlmAccountInfo> {
    const { client } = await this.configured();
    const self = await client.self();
    const currency = await client.currency();
    await this.db.update(llmGatewaySettings).set({ currency }).where(eq(llmGatewaySettings.id, 1));
    return { remainingQuota: self.quota, usedQuota: self.used_quota, currency, checkedAt: new Date().toISOString() };
  }
}
