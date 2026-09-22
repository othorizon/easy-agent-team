import * as path from 'node:path';

/** 平台配置：全部来自环境变量，开发期有安全的默认值 */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** 值加密主密钥（base64，32 字节）。生产必须显式配置 */
  kek: string;
  /** 对外访问地址，用于设备码授权页等链接拼接 */
  publicUrl: string;
  /** CLI 单文件产物路径（平台自托管下载）。默认按 monorepo/镜像布局从 server dist 相对定位 */
  cliDistPath: string;
  /**
   * 允许 MCP 网关转发到内网 / 回环 / 保留地址（决策 51）。**默认关闭。**
   * 关着是因为任何成员都能建 MCP 配置，开着等于把平台变成可被成员驱动的 SSRF 跳板
   * （云 metadata、平台自己的内网服务都在射程内）。
   * 只有在「所有能建 MCP 配置的人都可信」且确实要连内网 MCP 服务时才打开。
   */
  mcpGatewayAllowPrivateUpstream: boolean;
  /** 网关调用记录保留天数（决策 51），到期由模块内的每日清扫删掉 */
  mcpGatewayCallRetentionDays: number;
  /**
   * MCP 网关等上游**响应头**的上限（毫秒，决策 58）。默认 3 分钟。
   * `tools/call` 跑几十秒到几分钟是常态（而多数 MCP 服务是等结果出来才一次性发响应头），
   * 网关的这个上限必须比客户端自己的超时更宽松，否则网关会先于客户端掐断——
   * 该由客户端决定「等多久算太久」，不是由代理替它决定。
   * 拿到响应头之后的流式传输不设限：SSE 本来就是长连接。
   */
  mcpGatewayUpstreamTimeoutMs: number;
  /**
   * 网关到上游那条 TCP 连接的 keepalive 空闲探测间隔（毫秒，决策 62）。**0 = 关闭。**
   *
   * 一次 `tools/call` 动辄几十秒，期间连接上一个字节都不动。路上的 NAT / 防火墙 /
   * 云网关会按自己的空闲表项超时把这种连接**静默丢掉**——不发 RST 也不发 FIN，
   * 于是平台这端既不知道断了也等不到数据，最后以 `read ETIMEDOUT` 收场，对外是一个 502。
   * 开了 keepalive 之后，空闲期每隔这么久就有一个探测包在这条连接上来回，
   * 中间设备的空闲计时器被不断刷新，连接活到上游真正回话为止。
   *
   * 取值要明显小于路上最短的那个空闲回收时间（线上实测约 40 秒就被丢，故默认 15 秒）。
   * 注意它只保得住**连接层**：如果掐连接的是应用层（某些边缘网关对「一直没有响应体」的流有独立上限），
   * 那得靠上游在流上发心跳，keepalive 帮不上忙。
   */
  mcpGatewayUpstreamKeepAliveMs: number;
  /**
   * 空闲 keep-alive 连接的保持时长（毫秒，决策 61）。**必须比前置反向代理的空闲连接回收时间更长。**
   *
   * Fastify 的默认值是 72 秒，而 Traefik（Dokploy 用的就是它）默认把到后端的空闲连接留 90 秒。
   * 两者一错位就出现一个 72–90 秒的窗口：代理以为连接还活着、后端其实已经关了，
   * 复用时撞上 FIN——而 Go 的 http.Transport **不会重试带 body 的 POST**，客户端直接拿到 502。
   * 平台这边连请求都没收到，所以调用记录里连一行都不会有。
   *
   * 这条只影响「两次请求之间隔得比较久」的调用方：AI Agent 想一会儿再调一次工具，正好落在窗口里；
   * 而连着点的测试工具永远撞不上——「同一个地址，别人用没事、我这边就 502」的典型成因。
   */
  keepAliveTimeoutMs: number;
}

/** 环境变量里的正整数；写歪了就用默认值，**绝不能把 NaN 交给 setTimeout**（那等于立刻超时） */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 同上，但允许 0——给「这个开关能关掉」的配置项用（写歪了仍然回落默认值，不会变成 0） */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(): AppConfig {
  const kek = process.env.EAT_KEK ?? '';
  if (!kek && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 EAT_KEK（base64 编码的 32 字节主密钥）');
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_dev',
    // 开发缺省密钥：仅为本地跑通，不用于任何真实数据
    kek: kek || Buffer.from('eat-dev-insecure-kek-32-bytes!!!').toString('base64'),
    publicUrl: process.env.EAT_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
    // 与 web dist 同一套相对布局约定：apps/server/dist → apps/cli/dist（镜像内 /app/server/dist → /app/cli/dist）
    cliDistPath: process.env.EAT_CLI_DIST ?? path.resolve(__dirname, '../../cli/dist/index.js'),
    mcpGatewayAllowPrivateUpstream: process.env.EAT_MCP_GATEWAY_ALLOW_PRIVATE === '1',
    mcpGatewayCallRetentionDays: positiveInt(process.env.EAT_MCP_GATEWAY_CALL_RETENTION_DAYS, 90),
    mcpGatewayUpstreamTimeoutMs: positiveInt(process.env.EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS, 180_000),
    // 默认 15 秒：低于常见 NAT / 云网关的空闲回收时间（30~60 秒），也低于线上实测的那条约 40 秒的上限
    mcpGatewayUpstreamKeepAliveMs: nonNegativeInt(process.env.EAT_MCP_GATEWAY_UPSTREAM_KEEPALIVE_MS, 15_000),
    // 默认 120 秒：高于 Traefik / Go 默认的 90 秒空闲回收，也高于 nginx、云厂商 LB 常见的 60 秒
    keepAliveTimeoutMs: positiveInt(process.env.EAT_KEEP_ALIVE_TIMEOUT_MS, 120_000),
  };
}
