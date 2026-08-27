import { loadCredentials } from './config.js';

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
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, 'NETWORK_ERROR', `无法连接平台 ${this.serverUrl}：${(err as Error).message}`);
    }
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
