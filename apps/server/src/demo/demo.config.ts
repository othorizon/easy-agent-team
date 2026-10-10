export interface DemoConfig {
  enabled: boolean;
  /** 一键登录端点的共享密钥；不设则端点不可用 */
  loginSecret: string;
  bootstrapAdminEmail: string;
  mcpUpstreamAllow: string[];
}

/** 每次现读环境变量：测试里要在同一进程内切换开关 */
export function demoConfig(): DemoConfig {
  return {
    enabled: process.env.EAT_DEMO_MODE === '1',
    loginSecret: process.env.EAT_DEMO_LOGIN_SECRET ?? '',
    bootstrapAdminEmail: process.env.EAT_ADMIN_EMAIL ?? 'admin@example.com',
    mcpUpstreamAllow: (process.env.EAT_DEMO_MCP_UPSTREAM_ALLOW ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
