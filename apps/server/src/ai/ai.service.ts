import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { AiSettingsInfo, UpdateAiSettingsRequest } from '@eat/shared';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { aiCallLogs, aiSettings } from '../db/schema';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 平台 AI 调用：OpenAI 接口范式（Chat Completions 兼容），
 * api_base_url / api_key / model 由管理员配置，可对接任意兼容网关。
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  private async getRow() {
    return (await this.db.select().from(aiSettings).limit(1))[0];
  }

  async getSettings(): Promise<AiSettingsInfo> {
    const row = await this.getRow();
    if (!row) return { apiBaseUrl: '', apiKeyMasked: '', model: '', enabled: false, configured: false };
    const key = decryptSecret(row.apiKeyEncrypted);
    return {
      apiBaseUrl: row.apiBaseUrl,
      apiKeyMasked: key.length > 8 ? `${key.slice(0, 4)}****${key.slice(-4)}` : '****',
      model: row.model,
      enabled: row.enabled,
      configured: true,
    };
  }

  async updateSettings(dto: UpdateAiSettingsRequest): Promise<AiSettingsInfo> {
    const row = await this.getRow();
    // 传空 key 表示保持现有 key
    const apiKeyEncrypted = dto.apiKey
      ? encryptSecret(dto.apiKey)
      : (row?.apiKeyEncrypted ?? encryptSecret(''));
    if (row) {
      await this.db
        .update(aiSettings)
        .set({ apiBaseUrl: dto.apiBaseUrl, apiKeyEncrypted, model: dto.model, enabled: dto.enabled, updatedAt: sql`now()` })
        .where(eq(aiSettings.id, row.id));
    } else {
      await this.db.insert(aiSettings).values({ apiBaseUrl: dto.apiBaseUrl, apiKeyEncrypted, model: dto.model, enabled: dto.enabled });
    }
    return this.getSettings();
  }

  async isAvailable(): Promise<boolean> {
    const row = await this.getRow();
    return !!row && row.enabled;
  }

  /** 调用配置的模型；未配置/失败抛错（调用方决定回退），用量落 ai_call_log */
  async chatComplete(purpose: string, messages: ChatMessage[]): Promise<string> {
    const row = await this.getRow();
    if (!row || !row.enabled) {
      throw new ServiceUnavailableException({ error: 'AI_UNAVAILABLE', message: '平台 AI 未配置或已停用' });
    }
    const baseUrl = row.apiBaseUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${decryptSecret(row.apiKeyEncrypted)}`,
        },
        body: JSON.stringify({ model: row.model, messages }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`模型服务返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型响应中没有内容');
      await this.db.insert(aiCallLogs).values({
        purpose,
        model: row.model,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        status: 'success',
      });
      return content;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`AI 调用失败(${purpose}): ${message}`);
      await this.db.insert(aiCallLogs).values({ purpose, model: row.model, status: 'failed', error: message.slice(0, 500) });
      throw new ServiceUnavailableException({ error: 'AI_CALL_FAILED', message: `AI 调用失败: ${message}` });
    }
  }
}
