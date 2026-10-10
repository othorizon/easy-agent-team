/**
 * 公网演示模式（`EAT_DEMO_MODE=1`）下封禁的操作清单。
 *
 * 为什么需要：演示环境把「研发兼管理员」这个身份直接交给匿名访客。平台管理员按设计能改
 * 任何人的口令、改部署后台与平台 AI 的接入、登记数据库实例——这些要么会把同一环境里的
 * 其他身份踢下线，要么能让平台替访客向任意地址发请求（连通性测试会带着库里已存的密钥去
 * 请求表单里填的地址）。演示要展示的是审批、授权、分发这些日常动作，不是平台运维，
 * 所以把运维面整个关掉，其余照常。
 *
 * 引导管理员（`EAT_ADMIN_EMAIL`）不受限：灌演示数据要靠它建成员、登记实例。
 * 它的口令只有演示环境的管理面知道，不发给访客。
 */
export interface DemoRequest {
  method: string;
  /** 不带查询串的路径 */
  path: string;
  body: unknown;
}

interface Rule {
  methods: string[];
  path: RegExp;
  what: string;
}

const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'];

const RULES: Rule[] = [
  { methods: WRITE, path: /^\/api\/users(\/|$)/, what: '成员管理（建号、改角色、重置口令）' },
  { methods: ['POST'], path: /^\/api\/auth\/register$/, what: '自助注册' },
  { methods: WRITE, path: /^\/api\/admin\/(dokploy-settings|ai-settings|registration-settings)(\/|$)/, what: '平台接入设置' },
  { methods: WRITE, path: /^\/api\/db\/instances(\/|$)/, what: '数据库实例管理' },
];

const field = (body: unknown, key: string): unknown =>
  body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;

/**
 * 返回被封禁的原因；放行返回 null。
 * `mcpUpstreamAllow` 是允许作为 MCP 上游的地址前缀——网关会替订阅者去请求这个地址，
 * 演示环境里它只该指向内置的 anytocontext。
 */
export function demoDenyReason(req: DemoRequest, mcpUpstreamAllow: string[]): string | null {
  const method = req.method.toUpperCase();
  for (const rule of RULES) {
    if (rule.methods.includes(method) && rule.path.test(req.path)) return rule.what;
  }

  // 求助通知的 webhook：服务端会向这个地址盲发 POST
  if (method === 'PUT' && req.path === '/api/helpers/me') {
    const url = field(req.body, 'webhookUrl');
    if (typeof url === 'string' && url.trim()) return '求助通知的 webhook 地址';
  }

  // MCP 配置的上游地址（http / sse 传输才有）
  if (WRITE.includes(method) && /^\/api\/mcp-configs(\/[^/]+)?$/.test(req.path)) {
    const url = field(req.body, 'url');
    if (typeof url === 'string' && url.trim() && !mcpUpstreamAllow.some((p) => url.trim().startsWith(p))) {
      return '指向演示环境以外的 MCP 上游地址';
    }
  }
  return null;
}
