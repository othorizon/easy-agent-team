import { BadGatewayException } from '@nestjs/common';
import type { LlmCurrency, LlmUsagePage } from '@eat/shared';

export interface NewApiToken {
  id: number;
  name: string;
  key: string;
  status: number;
  remain_quota: number;
  used_quota: number;
  unlimited_quota: boolean;
  expired_time: number;
  [key: string]: unknown;
}
export class NewApiError extends BadGatewayException {
  constructor(
    message: string,
    readonly uncertain = false,
    readonly missing = false,
  ) {
    super({ error: 'NEWAPI_ERROR', message });
  }
}

/** All upstream responses and errors pass through this adapter; never log raw responses. */
export class NewApiClient {
  constructor(
    readonly apiUrl: string,
    private readonly accessToken: string,
    private readonly timeoutMs = 12_000,
  ) {}

  private safeMessage(value: unknown): string {
    const message = typeof value === 'string' ? value : 'New API 请求失败';
    return message
      .split(this.accessToken)
      .join('[REDACTED]')
      .replace(/sk-[\w-]+/g, '[REDACTED]')
      .slice(0, 240);
  }

  async request<T>(method: string, path: string, body?: unknown, auth = this.accessToken): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.apiUrl + path, {
        method,
        signal,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${auth}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NewApiError('无法连接 New API 或请求超时，请检查地址和连接状态', method !== 'GET');
    }
    // New API's rate limiter may return an empty body. Inspect HTTP status before parsing JSON.
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')?.trim();
      const seconds = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter)
        : retryAfter ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) : NaN;
      const retryHint = Number.isSafeInteger(seconds) && seconds > 0
        ? `请在 ${seconds} 秒后重试。`
        : '请稍后重试，避免连续操作。';
      await response.body?.cancel().catch(() => undefined);
      throw new NewApiError(`New API 请求过于频繁，已触发限流（HTTP 429），${retryHint}`);
    }
    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new NewApiError('New API 返回了无效响应', method !== 'GET');
    }
    if (!response.ok || json.success === false || json.error) {
      const message =
        response.status === 401 || response.status === 403
          ? 'New API 访问被拒绝，请检查系统访问令牌及公共账户状态'
          : this.safeMessage(json.message ?? json.error?.message);
      throw new NewApiError(
        message,
        method !== 'GET' && response.status >= 500,
        response.status === 404 || /not found|record not found|不存在/i.test(String(json.message)),
      );
    }
    return (json.data ?? json) as T;
  }

  self() {
    return this.request<{ id: number; username: string; quota: number; used_quota: number }>('GET', '/api/user/self');
  }
  async currency(): Promise<LlmCurrency> {
    const data = await this.request<Record<string, unknown>>('GET', '/api/status');
    const quotaPerUnit = Number(data.quota_per_unit);
    if (!(quotaPerUnit > 0) || !Number.isFinite(quotaPerUnit))
      throw new NewApiError('New API 未返回有效的额度换算比例');
    const kind = String(data.quota_display_type ?? (data.display_in_currency ? 'USD' : 'QUOTA'));
    const currency = kind === 'TOKEN' || kind === 'TOKENS' ? 'QUOTA' : kind;
    const exchangeRate =
      currency === 'CNY'
        ? Number(data.usd_exchange_rate)
        : currency === 'CUSTOM'
          ? Number(data.custom_currency_exchange_rate)
          : 1;
    if (!(exchangeRate > 0) || !Number.isFinite(exchangeRate))
      throw new NewApiError('New API 未返回有效的货币换算比例');
    return {
      quotaPerUnit,
      currency: currency === 'CUSTOM' ? String(data.custom_currency_symbol || 'CUSTOM') : currency,
      exchangeRate,
    };
  }
  async tokens(page = 1) {
    return this.request<{ items: NewApiToken[]; total: number }>('GET', `/api/token/?p=${page}&page_size=100`);
  }
  async findToken(name: string): Promise<NewApiToken | undefined> {
    const result = await this.request<{ items: NewApiToken[] }>(
      'GET',
      `/api/token/search?keyword=${encodeURIComponent(name)}&p=1&page_size=100`,
    );
    return result.items.find((item) => item.name === name);
  }
  token(id: number) {
    return this.request<NewApiToken>('GET', `/api/token/${id}`);
  }
  async createToken(name: string, quota: number) {
    await this.request('POST', '/api/token/', {
      name,
      remain_quota: quota,
      unlimited_quota: false,
      expired_time: -1,
      model_limits_enabled: false,
      model_limits: '',
      allow_ips: '',
      group: '',
      allow_user_quota_query: false,
    });
  }
  async setQuota(token: NewApiToken, quota: number) {
    // Native API replaces the configuration. Preserve every existing field, but never forward a masked key.
    const { key, user_id, used_quota, ...config } = token;
    await this.request('PUT', '/api/token/', {
      ...config,
      remain_quota: quota,
      unlimited_quota: false,
      allow_user_quota_query: false,
    });
  }
  async status(id: number, enabled: boolean) {
    await this.request('PUT', '/api/token/?status_only=true', { id, status: enabled ? 1 : 2 });
  }
  async key(id: number): Promise<string> {
    const result = await this.request<{ key: string }>('POST', `/api/token/${id}/key`, {});
    if (!result.key || result.key.includes('*')) throw new NewApiError('New API 未返回可用的密钥');
    return result.key.startsWith('sk-') ? result.key : `sk-${result.key}`;
  }
  async models(id?: number) {
    if (!id) {
      const names = await this.request<string[]>('GET', '/api/user/models');
      return names.map((name) => ({ id: name }));
    }
    const key = await this.key(id);
    return this.request<Array<{ id: string }>>('GET', '/v1/models', undefined, key);
  }
  async logs(name: string, page: number, pageSize: number): Promise<LlmUsagePage> {
    const end = Math.floor(Date.now() / 1000);
    const query = new URLSearchParams({
      token_name: name,
      p: String(page),
      page_size: String(pageSize),
      start_timestamp: String(end - 30 * 24 * 60 * 60),
      end_timestamp: String(end),
    });
    const data = await this.request<{ items: any[]; total: number }>('GET', `/api/log/self?${query}`);
    return {
      items: data.items.map((r) => ({
        id: String(r.id),
        createdAt: Number(r.created_at),
        model: String(r.model_name ?? ''),
        quota: Number(r.quota ?? 0),
        promptTokens: Number(r.prompt_tokens ?? 0),
        completionTokens: Number(r.completion_tokens ?? 0),
        type: Number(r.type),
      })),
      page,
      pageSize,
      total: data.total,
    };
  }
}
