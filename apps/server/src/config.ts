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
   * MCP 网关等上游**响应头**的上限（毫秒，决策 58）。默认 10 分钟。
   * `tools/call` 跑几十秒到几分钟是常态（而多数 MCP 服务是等结果出来才一次性发响应头），
   * 网关的这个上限必须比客户端自己的超时更宽松，否则网关会先于客户端掐断——
   * 该由客户端决定「等多久算太久」，不是由代理替它决定。
   * 拿到响应头之后的流式传输不设限：SSE 本来就是长连接。
   */
  mcpGatewayUpstreamTimeoutMs: number;
}

/** 环境变量里的正整数；写歪了就用默认值，**绝不能把 NaN 交给 setTimeout**（那等于立刻超时） */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    mcpGatewayUpstreamTimeoutMs: positiveInt(process.env.EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS, 600_000),
  };
}
