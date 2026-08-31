import { CLI_VERSION, CLIENT_HEADER } from '@eat/shared';
import { loadCredentials } from './config.js';
import { recordServerVersions } from './update.js';

/** 请求里自报身份：服务端据此决定是否附带更新检测响应头（决策 26） */
let clientTag = `eat-cli/${CLI_VERSION}`;

/** MCP server 走同一个 Api，但身份标记不同，便于服务端侧区分来源 */
export function setClientTag(tag: string): void {
  clientTag = tag;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * 结构化错误细节的可读呈现：zod 校验用 path 定位字段，其余形状回退到紧凑 JSON。
 * 服务端的 details 此前被丢弃，导致 VALIDATION_FAILED 只剩一句「请求参数不合法」。
 */
export function formatErrorDetails(details: unknown): string | null {
  if (details === undefined || details === null) return null;
  const items = Array.isArray(details) ? details : [details];
  if (items.length === 0) return null;
  return items
    .map((item) => {
      if (item && typeof item === 'object') {
        const o = item as { path?: unknown; message?: unknown };
        if (Array.isArray(o.path) && typeof o.message === 'string') {
          return `  ${o.path.join('.') || '(根)'}: ${o.message}`;
        }
      }
      return `  ${JSON.stringify(item)}`;
    })
    .join('\n');
}

export class Api {
  constructor(
    public readonly serverUrl: string,
    private readonly token?: string,
  ) {}

  /** 需要已登录的客户端；未登录时给出明确指引 */
  static fromSaved(): Api {
    const cred = loadCredentials();
    if (!cred) {
      throw new ApiError(401, 'UNAUTHORIZED', '尚未登录。请先运行: eat login [--server <平台地址>]');
    }
    return new Api(cred.serverUrl, cred.token);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          [CLIENT_HEADER]: clientTag,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, 'NETWORK_ERROR', `无法连接平台 ${this.serverUrl}：${(err as Error).message}`);
    }
    // 更新检测搭车：响应头带回平台的 CLI 版本与该用户的 Skill 指纹，成功失败都记录
    recordServerVersions(this.serverUrl, res.headers);
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new ApiError(
        res.status,
        (json.error as string) ?? 'ERROR',
        (json.message as string) ?? `请求失败（HTTP ${res.status}）`,
        json.details,
      );
    }
    return json as T;
  }
}
