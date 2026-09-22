import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { loadConfig } from '../config';

/**
 * 网关的上游侧：地址安全校验、请求/响应头白名单（决策 51）与上游请求的发起（决策 58）。
 * 单独一个文件是为了前三者能直接单测——这里每一条判断错了都是一个安全洞。
 */

/** 网关拒绝转发时对外的统一说法：不提上游、不提 Dokploy 式细节（照决策 33） */
export class UpstreamRejected extends Error {}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  // 解析不出来就当不安全：宁可拒一个合法地址，不可放过一个内网地址
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 「本网络」
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 回环
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 运营商级 NAT
  if (a === 169 && b === 254) return true; // 链路本地，含云 metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF 协议专用
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a >= 224) return true; // 组播与保留
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fe80')) return true; // 链路本地
  if (/^f[cd]/.test(s)) return true; // fc00::/7 唯一本地地址
  // IPv4 映射地址（::ffff:10.0.0.1）绕不过去：拆出 v4 再判一遍
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice('::ffff:'.length);
    return isIP(v4) === 4 ? isPrivateIpv4(v4) : true;
  }
  if (s.startsWith('64:ff9b')) return true; // NAT64，同样能落到 v4 私网
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[/, '').replace(/\]$/, ''));
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true; // 不是 IP 字面量，调用方应该先解析
}

/**
 * 校验上游地址可转发，返回解析后的 URL。
 *
 * 已知局限（决策 51 记在案）：这里是「解析后校验、再按主机名发起请求」，
 * 理论上存在 DNS rebinding 的 TOCTOU 窗口。彻底堵住要把请求钉在已解析的 IP 上
 * （连 IP、另给 Host 头与 TLS servername），对一个团队内部平台不成比例，先不做。
 */
export async function assertSafeUpstream(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamRejected('这个服务的接入地址配置有误，请联系配置负责人');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamRejected('这个服务的接入地址配置有误，请联系配置负责人');
  }
  if (loadConfig().mcpGatewayAllowPrivateUpstream) return url;

  const host = url.hostname;
  const literal = isIP(host.replace(/^\[/, '').replace(/\]$/, ''));
  if (literal) {
    if (isPrivateAddress(host)) {
      throw new UpstreamRejected('这个服务指向内网或保留地址，平台不允许代理，请联系配置负责人');
    }
    return url;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UpstreamRejected('这个服务的域名解析不到，请联系配置负责人');
  }
  // 任意一条解析结果落在私网就整体拒绝：轮询 DNS 里混一条内网地址是常见绕过手法
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UpstreamRejected('这个服务指向内网或保留地址，平台不允许代理，请联系配置负责人');
  }
  return url;
}

/**
 * 从客户端转发给上游的请求头白名单。
 * **刻意不含 authorization / cookie**：客户端送来的凭证一律丢掉，
 * 上游凭证由网关在服务端注入。其余一概不透传，避免把客户端环境信息带出去。
 */
const FORWARD_REQUEST_HEADERS = new Set([
  'accept',
  'content-type',
  'mcp-session-id',
  'last-event-id',
  'mcp-protocol-version',
]);

export function filterRequestHeaders(incoming: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const k = key.toLowerCase();
    if (!FORWARD_REQUEST_HEADERS.has(k) || value === undefined) continue;
    out[k] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * 回给客户端的响应头白名单。
 *
 * `www-authenticate` 必须挡掉：MCP 的鉴权规范会在 401 里带上游的 resource metadata 地址，
 * 原样透传等于把要藏的上游身份端点直接漏回去。`location` 同理（我们也不跟随重定向）。
 */
const FORWARD_RESPONSE_HEADERS = new Set(['content-type', 'mcp-session-id', 'cache-control']);

export function filterResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (!FORWARD_RESPONSE_HEADERS.has(k) || value === undefined) continue;
    out[k] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * 发起上游请求，拿到响应头就返回，响应体交给调用方自己流式转发。
 *
 * **刻意不用 `fetch`**（决策 58）：Node 内置的 fetch 底下是 undici，自带
 * `headersTimeout` / `bodyTimeout` 两个 5 分钟的硬上限，而它们既不能按请求配、
 * 也没法关掉。对一个代理，这两条意味着「跑超过 5 分钟的 tools/call 必挂」和
 * 「闲置超过 5 分钟的 SSE 通知流会被悄悄掐掉」，而且外面还配着一个看起来管用、
 * 实际被它们盖住的超时参数——参数写了不生效，比没有参数更糟。
 * `node:http` 默认没有任何超时，等多久完全由调用方的 AbortSignal 说了算。
 */
export function requestUpstream(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<http.IncomingMessage> {
  const transport = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { ...init.headers };
  // 有 body 就显式给长度：默认的 chunked 编码有些上游不认
  if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      { method: init.method, headers, signal: init.signal },
      // 不跟随重定向是 node:http 的默认行为，正合此处所需：3xx 原样交回调用方去判
      (res) => resolve(res),
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
