import { CLI_VERSION, CLIENT_HEADER } from '@eat/shared';
import {
  loadCredentials,
  normalizeServerUrl,
  rememberServerUrl,
  rememberedServerUrl,
  saveCredentials,
} from './config.js';
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

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export type RedirectVerdict = 'follow' | 'upgrade' | 'stop';

/**
 * 跳转目标还能不能带着访问令牌继续请求（决策 59）。
 *
 * fetch 规范在**跨源**跳转时会丢掉 Authorization 头，而「只换了 scheme」也算跨源。
 * 平台前面挂个把 http 301 到 https 的反代（Traefik / nginx 的标准做法），
 * 用 http 地址登录过的客户端就会次次收到一个不带令牌的请求 → 服务端回「缺少访问令牌，请先登录」，
 * 而重新登录并不能修好：设备码接口是公开的，跳转照样成功，存下来的还是那个会跳转的旧地址。
 *
 * 所以跳转必须自己处理：
 *  - 同源：照跟，令牌本来就是发给这台机器的；
 *  - 同主机的 http → https：跟，并把地址修正记下来（令牌仍只发给同一台主机，且从明文升级到 TLS）；
 *  - 换了主机：停下来报错。绝不把令牌转发给另一台主机。
 */
export function classifyRedirect(from: URL, to: URL): RedirectVerdict {
  if (from.protocol === to.protocol && from.host === to.host) return 'follow';
  if (from.protocol === 'http:' && to.protocol === 'https:' && from.hostname === to.hostname) return 'upgrade';
  return 'stop';
}

/** 从跳转后的最终地址反推平台根地址：`https://x/api/whoami` + `/api/whoami` → `https://x` */
export function baseFromFinalUrl(finalUrl: string, path: string): string | null {
  if (!path || !finalUrl.endsWith(path)) return null;
  return normalizeServerUrl(finalUrl.slice(0, finalUrl.length - path.length));
}

let correctionNoticed = false;

/**
 * 地址被跳转修正后的自愈：把最终地址写回凭证与记住的平台地址，并提示一次。
 * 只在本地存的正是那个会跳转的旧地址时才改——`--server` 临时指到别处不该动用户的配置。
 */
function persistCorrectedServerUrl(from: string, to: string): void {
  try {
    const cred = loadCredentials();
    if (cred && normalizeServerUrl(cred.serverUrl) === from) {
      saveCredentials({ ...cred, serverUrl: to });
    }
    const remembered = rememberedServerUrl();
    if (remembered === null || remembered === from) rememberServerUrl(to);
  } catch {
    // 落盘失败不该影响命令本身：大不了下次请求再跳转一次
  }
  if (correctionNoticed) return;
  correctionNoticed = true;
  console.error(`[eat] 平台地址 ${from} 会跳转到 ${to}，已按最终地址更新本地配置（访问令牌不会跟着跨源跳转）。`);
}

export class Api {
  public readonly serverUrl: string;
  /** 跳转修正后实际使用的平台地址：登录时要存它，存旧地址等于把坑原样留着 */
  public resolvedUrl: string;
  private readonly token?: string;

  constructor(serverUrl: string, token?: string) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.resolvedUrl = this.serverUrl;
    this.token = token;
  }

  /** 需要已登录的客户端；未登录时给出明确指引 */
  static fromSaved(): Api {
    const cred = loadCredentials();
    // 没有 token 的凭证文件等同于没登录：带着它发请求只会换来服务端一句「缺少访问令牌」
    if (!cred?.token) {
      throw new ApiError(401, 'UNAUTHORIZED', '尚未登录。请先运行: eat login [--server <平台地址>]');
    }
    return new Api(cred.serverUrl, cred.token);
  }

  private async send(method: string, url: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          [CLIENT_HEADER]: clientTag,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // 跳转自己处理：交给 fetch 会静默丢掉 Authorization（跨源）、还会把 301/302 的 POST 降级成 GET
        redirect: 'manual',
      });
    } catch (err) {
      // 跳转之后失败的是新地址，报它才对得上排查；地址本身不合法时回落到用户给的原串
      let target = this.serverUrl;
      try {
        target = new URL(url).origin;
      } catch {
        // ignore
      }
      throw new ApiError(0, 'NETWORK_ERROR', `无法连接平台 ${target}：${(err as Error).message}`);
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let url = `${this.serverUrl}${path}`;
    let upgraded = false;
    let res = await this.send(method, url, body);

    for (let hop = 0; REDIRECT_STATUS.has(res.status); hop++) {
      const location = res.headers.get('location');
      if (!location) break; // 没有 Location 的 3xx 交给下面按普通响应处理
      if (hop >= MAX_REDIRECTS) {
        throw new ApiError(res.status, 'PLATFORM_REDIRECT', `平台地址 ${this.serverUrl} 的跳转超过 ${MAX_REDIRECTS} 次，已放弃`);
      }
      const from = new URL(url);
      const to = new URL(location, url);
      const verdict = classifyRedirect(from, to);
      if (verdict === 'stop') {
        throw new ApiError(
          res.status,
          'PLATFORM_REDIRECT',
          `平台地址 ${this.serverUrl} 跳转到了 ${to.origin}（HTTP ${res.status}）。` +
            `访问令牌不会跟着跨站跳转，继续用旧地址只会一直报「缺少访问令牌」。` +
            `请改用最终地址重新登录：eat login --server ${to.origin}`,
        );
      }
      upgraded = upgraded || verdict === 'upgrade';
      url = to.toString();
      // 方法与 body 原样重发：这里跟的只是同主机的基础设施跳转，
      // 按 fetch 规范把 301/302 的 POST 降级成 GET，只会得到一句 Cannot GET /api/...
      res = await this.send(method, url, body);
    }

    if (upgraded) {
      const corrected = baseFromFinalUrl(url, path);
      if (corrected && corrected !== this.serverUrl) {
        this.resolvedUrl = corrected;
        persistCorrectedServerUrl(this.serverUrl, corrected);
      }
    }

    // 更新检测搭车：响应头带回平台的 CLI 版本与该用户的 Skill 指纹，成功失败都记录
    recordServerVersions(this.resolvedUrl, res.headers);
    const text = await res.text();
    // 平台永远回 JSON；回来的是别的东西，说明答话的是路上的某个中间件（代理的错误页、登录门户、
    // WAF 拦截页）。直接 JSON.parse 会抛一句 Unexpected token <，把真正的线索盖掉。
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new ApiError(
        res.status,
        'NOT_JSON',
        `${this.resolvedUrl} 返回的不是平台响应（HTTP ${res.status}，${res.headers.get('content-type') ?? '未标注类型'}）：` +
          `请确认这个地址指向的是 eat 平台本身，而不是它前面的代理 / 门户页面。`,
      );
    }
    if (!res.ok) {
      const message = (json.message as string) ?? `请求失败（HTTP ${res.status}）`;
      throw new ApiError(res.status, (json.error as string) ?? 'ERROR', this.explain(res.status, message), json.details);
    }
    return json as T;
  }

  /**
   * 「带了令牌却被告知没带」只可能是令牌在路上被丢了——多半是前置代理没有转发 Authorization 头。
   * 不补这句的话，用户看到的是一句让他反复重新登录、而重新登录永远修不好的提示。
   */
  private explain(status: number, message: string): string {
    if (status === 401 && this.token && message.includes('缺少访问令牌')) {
      return `${message}（本次请求确实带了访问令牌，是平台没收到：请检查 ${this.resolvedUrl} 前面的反向代理是否转发了 Authorization 头）`;
    }
    return message;
  }
}
