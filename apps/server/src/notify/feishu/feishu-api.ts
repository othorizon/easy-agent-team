import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

/** 只对接飞书（open.feishu.cn），与 Webhook 渠道的地址校验口径一致 */
export const FEISHU_OPEN_API = 'https://open.feishu.cn/open-apis';

/** 这些错误码说明 tenant_access_token 已失效，丢掉缓存下次重取 */
const TOKEN_INVALID = new Set([99991661, 99991663, 99991664, 99991668]);

export class FeishuApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FeishuBotInfo {
  activate_status?: number;
  app_name?: string;
  avatar_url?: string;
  open_id?: string;
}
export interface FeishuScopeGrant {
  scope_name: string;
  grant_status: number;
  scope_type?: 'tenant' | 'user';
}

/**
 * 飞书开放平台的最小客户端：只覆盖通知渠道用到的几个接口，不引官方 SDK。
 * 每个实例绑定一组 App ID / App Secret，tenant_access_token 缓存在实例上（有效期 2 小时，提前 5 分钟换）。
 */
export class FeishuApi {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async tenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const res = await fetch(`${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
      | null;
    if (!body || body.code !== 0 || !body.tenant_access_token) {
      throw new FeishuApiError(body?.code ?? -1, describe(body, res.status, 'App ID 或 App Secret 不正确'));
    }
    const ttl = Math.max(60, (body.expire ?? 7200) - 300);
    this.token = { value: body.tenant_access_token, expiresAt: Date.now() + ttl * 1000 };
    return this.token.value;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown): Promise<T> {
    const res = await fetch(`${FEISHU_OPEN_API}${path}`, {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${await this.tenantToken()}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as ({ code?: number; msg?: string } & T) | null;
    if (!body || typeof body.code !== 'number') throw new FeishuApiError(-1, `飞书返回无效响应（HTTP ${res.status}）`);
    if (body.code !== 0) {
      if (TOKEN_INVALID.has(body.code)) this.token = null;
      throw new FeishuApiError(body.code, describe(body, res.status));
    }
    return body;
  }

  /** 机器人信息；应用没开机器人能力时飞书直接报错 */
  async botInfo(): Promise<FeishuBotInfo> {
    return (await this.call<{ bot?: FeishuBotInfo }>('GET', '/bot/v3/info')).bot ?? {};
  }

  /** 应用在开发者后台添加过的权限及其在本企业的授权状态（grant_status=1 为已授权） */
  async scopes(): Promise<FeishuScopeGrant[]> {
    return (await this.call<{ data?: { scopes?: FeishuScopeGrant[] } }>('GET', '/application/v6/scopes')).data?.scopes ?? [];
  }

  /** 以应用身份向企业管理员申请开通「已添加但未授权」的权限 */
  async applyScopes(): Promise<void> {
    await this.call('POST', '/application/v6/scopes/apply', {});
  }

  async sendCard(openId: string, card: Record<string, unknown>): Promise<string> {
    const body = await this.call<{ data?: { message_id?: string } }>('POST', '/im/v1/messages?receive_id_type=open_id', {
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    if (!body.data?.message_id) throw new FeishuApiError(-1, '飞书没有返回消息 ID');
    return body.data.message_id;
  }

  /** 更新机器人发出的卡片（卡片需声明 update_multi，JSON 2.0 卡片默认如此） */
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.call('PATCH', `/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) });
  }

  async replyText(messageId: string, text: string): Promise<void> {
    await this.call('POST', `/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    });
  }
}

function describe(body: { code?: number; msg?: string } | null, status: number, fallback = ''): string {
  if (!body) return `飞书返回无效响应（HTTP ${status}）`;
  const detail = `code=${body.code}${body.msg ? ` ${body.msg}` : ''}`;
  return fallback ? `${fallback}（${detail}）` : `飞书返回 ${detail}`;
}

/**
 * 解密「事件与回调」的加密推送：key = sha256(Encrypt Key)，AES-256-CBC，
 * 密文 base64 解出后前 16 字节是 IV。
 */
export function decryptFeishuPayload(encryptKey: string, encrypt: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const buf = Buffer.from(encrypt, 'base64');
  if (buf.length < 32) throw new Error('密文长度不对');
  const decipher = createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
}

/** 配了 Encrypt Key 时飞书给每个推送签名：sha256(timestamp + nonce + Encrypt Key + 原始请求体) */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, rawBody: string): string {
  return createHash('sha256').update(timestamp + nonce + encryptKey + rawBody).digest('hex');
}

export function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
