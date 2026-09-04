#!/usr/bin/env node
/**
 * 演示数据：为「产品截图 / CLI 录屏」造一份看得懂的团队现场数据。
 *
 * 全部通过平台自己的 HTTP API 写入（不碰数据库），所以造出来的是真实业务状态：
 * 版本号、审计日志、授权关系、真实建库都由服务端逻辑产生，不是手塞的假数据。
 *
 * 用法（先起库 + 迁移 + seed + server）：
 *   EAT_SERVER=http://localhost:3001 node scripts/demo/seed-demo.mjs
 *
 * 幂等性：为空库设计。重复执行不会崩，但已存在的对象会被跳过（打印 skip）。
 */
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER = (process.env.EAT_SERVER ?? 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.EAT_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.EAT_ADMIN_PASSWORD ?? 'admin12345';
/** 演示账号统一密码——仅用于本地演示环境 */
export const DEMO_PASSWORD = 'demo12345';

let failures = 0;

async function api(method, path, { body, token, quiet } = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (!quiet) {
      failures += 1;
      console.warn(`  ! ${method} ${path} → ${res.status} ${data?.message ?? text}`);
    }
    return null;
  }
  return data;
}

const login = async (email, password) =>
  (await api('POST', '/api/auth/login', { body: { email, password } }))?.token;

function step(title) {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------- 用户
const MEMBERS = [
  { key: 'liwei', name: '李维', email: 'liwei@example.com', role: 'admin' },
  { key: 'zhouqi', name: '周琪', email: 'zhouqi@example.com', role: 'member' },
  { key: 'sunhao', name: '孙浩', email: 'sunhao@example.com', role: 'member' },
  { key: 'wumin', name: '吴敏', email: 'wumin@example.com', role: 'member' },
  { key: 'zhengnan', name: '郑楠', email: 'zhengnan@example.com', role: 'member' },
];

async function main() {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) throw new Error(`管理员登录失败，确认 ${SERVER} 已启动且已执行 pnpm db:seed`);

  step('用户');
  const T = { admin };
  const U = {};
  for (const m of MEMBERS) {
    const created = await api('POST', '/api/users', {
      token: admin,
      quiet: true,
      body: { name: m.name, email: m.email, password: DEMO_PASSWORD, role: m.role },
    });
    T[m.key] = await login(m.email, DEMO_PASSWORD);
    if (!T[m.key]) throw new Error(`${m.name} 登录失败`);
    U[m.key] = created?.id ?? (await api('GET', '/api/users', { token: admin })).find((u) => u.email === m.email).id;
    console.log(`  ${created ? '+' : '=' } ${m.name} <${m.email}> ${m.role}`);
  }
  const users = await api('GET', '/api/users', { token: admin });
  U.admin = users.find((u) => u.email === ADMIN_EMAIL).id;

  // -------------------------------------------------------------- 环境变量
  step('环境与变量');
  const ENVS = [
    {
      slug: 'internal-api',
      name: '内部 API 网关',
      owner: 'liwei',
      description: '内部服务的统一入口。调用方需要 base 地址 + 调用凭证；签名密钥仅签名服务需要。',
      vars: [
        { key: 'INTERNAL_API_BASE', value: 'https://api.internal.example.com/v2', secret: false, description: '网关地址，按环境区分；灰度走 /v2-canary' },
        { key: 'INTERNAL_API_TOKEN', value: 'iat_7f3c91ba24e8d6f05c1b9a4e7d2f8c60', secret: true, description: '服务间调用凭证，90 天轮换一次' },
        { key: 'SIGN_SECRET', value: 'sk_sign_5d8e2a71c94f0b63ae15', secret: true, description: '请求签名密钥；HMAC-SHA256(ts + path + body)' },
      ],
    },
    {
      slug: 'wecom-app',
      name: '企业微信自建应用',
      owner: 'liwei',
      description: '运营活动通知、审批推送都走这个自建应用。CorpID 与 AgentID 非敏感，Secret 需申请。',
      vars: [
        { key: 'WECOM_CORP_ID', value: 'ww8f2a1c3d4e5f6a7b', secret: false, description: '企业 ID，全公司唯一' },
        { key: 'WECOM_AGENT_ID', value: '1000042', secret: false, description: '自建应用 AgentID' },
        { key: 'WECOM_APP_SECRET', value: 'Xq2mB9vK7pL4nR6tY1uW3sZ8dF5gH0jC', secret: true, description: '应用 Secret，泄露等于可代发全员消息' },
      ],
    },
    {
      slug: 'oss-storage',
      name: '对象存储（图片 / 附件）',
      owner: 'liwei',
      description: '活动页素材、导出报表都放这里。读地址非敏感，上传凭证需申请。',
      vars: [
        { key: 'OSS_ENDPOINT', value: 'https://oss-cn-hangzhou.example.com', secret: false, description: '内网走 -internal 域名可免流量费' },
        { key: 'OSS_BUCKET', value: 'team-assets-prod', secret: false, description: '生产桶；测试用 team-assets-dev' },
        { key: 'OSS_ACCESS_KEY_ID', value: 'LTAI5tDemoAccessKeyId0001', secret: true, description: '上传用子账号 AK' },
        { key: 'OSS_ACCESS_KEY_SECRET', value: 'wJalrXUtnFEMIK7MDENGbPxRfiCYDEMOKEY', secret: true, description: '上传用子账号 SK，仅授权到 team-assets-* 前缀' },
      ],
    },
    {
      slug: 'crm-readonly',
      name: 'CRM 只读库',
      owner: 'zhengnan',
      description: '客户、订单、跟进记录的只读副本，延迟约 5 分钟。做报表与数据核对用。',
      vars: [
        { key: 'CRM_DB_URL', value: 'postgres://ro_analytics:9f4Ae2Kd@crm-replica.internal:5432/crm', secret: true, description: '只读账号连接串，禁止写入' },
      ],
    },
  ];
  const envIds = {};
  const varIds = {};
  for (const e of ENVS) {
    const token = T[e.owner];
    const created = await api('POST', '/api/envs', {
      token,
      quiet: true,
      body: { slug: e.slug, name: e.name, description: e.description },
    });
    console.log(`  ${created ? '+' : '='} ${e.slug} ${e.name}`);
    for (const v of e.vars) {
      await api('POST', `/api/envs/${e.slug}/variables`, {
        token,
        body: { key: v.key, value: v.value, description: v.description, secret: v.secret, visibleWithoutPermission: true },
      });
    }
    const list = await api('GET', `/api/envs/${e.slug}/variables`, { token });
    envIds[e.slug] = (await api('GET', '/api/envs', { token })).find((x) => x.slug === e.slug).id;
    for (const v of list ?? []) varIds[`${e.slug}/${v.key}`] = v.id;
  }

  step('授权');
  const in30Days = new Date(Date.now() + 30 * 864e5).toISOString();
  await api('POST', '/api/envs/wecom-app/grants', {
    token: T.liwei,
    body: { userId: U.zhouqi, environmentId: envIds['wecom-app'] },
  });
  await api('POST', '/api/envs/internal-api/grants', {
    token: T.liwei,
    body: { userId: U.sunhao, environmentId: envIds['internal-api'], expiresAt: in30Days },
  });
  await api('POST', '/api/envs/oss-storage/grants', {
    token: T.liwei,
    body: { userId: U.zhouqi, variableId: varIds['oss-storage/OSS_ACCESS_KEY_ID'] },
  });
  console.log('  + 3 条授权（环境级 / 环境级带有效期 / 变量级）');

  step('权限申请');
  await api('POST', '/api/access-requests', {
    token: T.wumin,
    body: {
      environmentSlug: 'internal-api',
      keys: ['INTERNAL_API_TOKEN'],
      reason: '活动看板要调网关的 /campaign/stats 拉实时数据；internal-gateway 这个 MCP 现在也因为没权限渲染不出凭证。',
    },
  });
  const reqApproved = await api('POST', '/api/access-requests', {
    token: T.zhouqi,
    body: {
      environmentSlug: 'internal-api',
      keys: ['INTERNAL_API_TOKEN'],
      reason: '活动数据看板要调网关的 /campaign/stats 接口拉实时数据，需要服务间调用凭证。',
    },
  });
  if (reqApproved) {
    await api('POST', `/api/access-requests/${reqApproved.id}/decision`, {
      token: T.liwei,
      body: { decision: 'approved', grantExpiresAt: in30Days },
    });
  }
  await api('POST', '/api/access-requests', {
    token: T.zhengnan,
    body: {
      environmentSlug: 'wecom-app',
      keys: ['WECOM_APP_SECRET'],
      reason: '要给数据日报加一个企业微信推送，本地脚本需要应用 Secret 换 access_token。',
    },
  });
  const reqRejected = await api('POST', '/api/access-requests', {
    token: T.sunhao,
    body: {
      environmentSlug: 'internal-api',
      keys: ['SIGN_SECRET'],
      reason: '前端想直接算签名调网关，省一层 BFF。',
    },
  });
  if (reqRejected) {
    await api('POST', `/api/access-requests/${reqRejected.id}/decision`, {
      token: T.liwei,
      body: { decision: 'rejected' },
    });
  }
  console.log('  + 待审批 2 条 / 已批准 1 条 / 已驳回 1 条');

  // -------------------------------------------------------------- Skill
  step('Skill');
  const SKILLS = [
    {
      owner: 'zhengnan',
      slug: 'crm-data-query',
      name: 'CRM 数据查询',
      visibility: 'team',
      allowHelp: true,
      description: '查客户、订单、跟进记录：连哪个库、有哪些表、口径怎么算、哪些字段不能直接用。',
      content: `---
name: CRM 数据查询
description: 查客户、订单、跟进记录时先读这个：连接方式、表结构、统计口径与常见坑。
---

# CRM 数据查询

## 连接

只读副本，连接串在平台环境变量 \`crm-readonly/CRM_DB_URL\`（需申请）：

\`\`\`bash
eat env pull crm-readonly --keys CRM_DB_URL
\`\`\`

副本有约 5 分钟延迟，**不要**用它做实时校验。

## 常用表

| 表 | 说明 | 注意 |
|---|---|---|
| \`customer\` | 客户主表 | \`status='merged'\` 的是被合并掉的重复客户，统计时必须排除 |
| \`orders\` | 订单 | 金额单位是**分**；\`is_test=true\` 是压测数据 |
| \`follow_up\` | 跟进记录 | 一个客户多条，取最新一条用 \`row_number()\` |

## 统计口径（与财务对齐过）

- **有效订单**：\`status IN ('paid','shipped','done') AND is_test = false\`
- **客单价**：有效订单金额 / 有效订单数，**不是** / 客户数
- **新客**：首个有效订单落在统计区间内

## 不要这样做

- 不要 \`SELECT *\` 拉 \`orders\` 全表（约 4000 万行），先按 \`created_at\` 收敛区间。
- 不要用 \`customer.name\` 做 join key，重名很多，用 \`customer_id\`。
`,
    },
    {
      owner: 'zhouqi',
      slug: 'weekly-report',
      name: '周报生成规范',
      visibility: 'team',
      allowHelp: true,
      description: '按团队约定的结构生成周报：数据从哪来、写几段、哪些话不要写。',
      content: `---
name: 周报生成规范
description: 生成团队周报时遵循的结构与口径，附数据来源与反面例子。
---

# 周报生成规范

## 结构（固定四段，别加段）

1. **本周结论**：3 条以内，每条一句话，必须带数字。
2. **数据**：核心指标表格 + 环比。
3. **问题与卡点**：写清「卡在谁那里 / 需要什么决策」。
4. **下周计划**：可验收的动作，不写「持续跟进」。

## 数据来源

- 业务指标：CRM 只读库，口径见 \`crm-data-query\` Skill。
- 活动数据：内部网关 \`/campaign/stats\`。

## 反面例子

> 本周持续推进活动页优化，效果良好。

没有数字、没有结论、不可验收。改成：

> 活动页转化率从 2.1% 提到 3.4%（+62%），主要来自首屏加载从 4.2s 降到 1.6s。
`,
    },
    {
      owner: 'liwei',
      slug: 'release-checklist',
      name: '上线前检查清单',
      visibility: 'team',
      allowHelp: true,
      description: '上线前必须逐条确认的检查项：配置、回滚、灰度、监控与密钥。',
      content: `---
name: 上线前检查清单
description: 上线前逐条确认，任何一条没过就不要触发部署。
---

# 上线前检查清单

## 配置

- [ ] 新增的环境变量已在平台登记，且线上环境已授权到部署账号
- [ ] 没有把 \`.env\` 提交进仓库（\`eat scan\` 会拦，但先自己看一眼）

## 部署

- [ ] \`eat deploy\` 的本地检查全绿（密钥扫描 + 预检命令）
- [ ] 回滚方式确认过：上一版镜像还在，或代码可 revert
- [ ] 数据库变更是向后兼容的（先加列、后改代码，不要同时）

## 上线后

- [ ] 构建日志无 warning 级别的异常
- [ ] 打开一次线上地址，确认首页与一个写操作正常
`,
    },
    {
      owner: 'sunhao',
      slug: 'wecom-bot-notify',
      name: '企业微信机器人推送',
      visibility: 'team',
      allowHelp: false,
      description: '往企业微信群推消息：文本 / Markdown / 图文卡片的正确写法与限流。',
      content: `---
name: 企业微信机器人推送
description: 企业微信群机器人推送的消息体写法、限流与常见错误码。
---

# 企业微信机器人推送

## 基本用法

\`\`\`bash
curl "$WECOM_WEBHOOK" -H 'content-type: application/json' \\
  -d '{"msgtype":"markdown","markdown":{"content":"**发布完成**\\n<font color=\\"info\\">crm-dashboard</font> 已上线"}}'
\`\`\`

## 限流

每个机器人 **20 条 / 分钟**，超了返回 45009。批量通知要合并成一条，不要循环发。

## 常见错误码

| 错误码 | 含义 | 处理 |
|---|---|---|
| 93000 | webhook 无效 | key 被重置了，去群里重新获取 |
| 40008 | 消息类型不支持 | 图片必须用 base64 + md5，不能传 URL |
| 45009 | 触发限流 | 合并消息，或加 1 分钟退避 |
`,
    },
    {
      owner: 'sunhao',
      slug: 'design-tokens',
      name: '设计规范落地',
      visibility: 'private',
      allowHelp: false,
      description: '把设计稿的颜色、间距、字号映射到项目里的 Tailwind token（个人草稿，还没定稿）。',
      content: `---
name: 设计规范落地
description: 设计稿 token 到 Tailwind 变量的映射表（草稿）。
---

# 设计规范落地（草稿）

设计稿里的一套值还没和设计师对齐，先记在这里，定稿后再改成团队可见。

| 设计稿 | 项目变量 |
|---|---|
| Gray/900 | \`--foreground\` |
| Brand/600 | \`--primary\` |
| Spacing/4 | \`gap-4\` |
`,
    },
  ];
  for (const s of SKILLS) {
    const r = await api('POST', '/api/skills/push', {
      token: T[s.owner],
      body: {
        slug: s.slug,
        name: s.name,
        description: s.description,
        content: s.content,
        visibility: s.visibility,
        changelog: '首次纳管',
      },
    });
    if (s.allowHelp) await api('PATCH', `/api/skills/${s.slug}`, { token: T[s.owner], body: { allowHelp: true } });
    console.log(`  + ${s.slug}（${s.visibility}${s.allowHelp ? '，可求助' : ''}）`);
  }
  // 再推一版，让版本历史不只有一条
  await api('POST', '/api/skills/push', {
    token: T.zhengnan,
    body: {
      slug: 'crm-data-query',
      name: 'CRM 数据查询',
      description: SKILLS[0].description,
      content: `${SKILLS[0].content}\n## 变更\n\n- 补充「有效订单」口径与财务对齐结论。\n`,
      visibility: 'team',
      changelog: '补充有效订单口径，排除 is_test 压测数据',
    },
  });

  step('订阅');
  const SUBS = [
    ['wumin', 'weekly-report'],
    ['wumin', 'crm-data-query'],
    ['wumin', 'release-checklist'],
    ['zhouqi', 'crm-data-query'],
    ['zhouqi', 'release-checklist'],
    ['sunhao', 'release-checklist'],
    ['zhengnan', 'weekly-report'],
  ];
  for (const [who, slug] of SUBS) await api('POST', `/api/skills/${slug}/subscribe`, { token: T[who] });
  console.log(`  + ${SUBS.length} 条订阅`);

  // -------------------------------------------------------------- MCP
  step('MCP 配置');
  const MCPS = [
    {
      owner: 'admin',
      body: {
        slug: 'crm-db',
        name: 'CRM 只读数据库',
        description: '直接查 CRM 只读副本。连接串按调用者权限渲染，无权限不下发。',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
        env: { DATABASE_URL: '${env:crm-readonly/CRM_DB_URL}' },
        visibility: 'team',
      },
    },
    {
      owner: 'admin',
      body: {
        slug: 'internal-gateway',
        name: '内部 API 网关',
        description: '调用内部服务：客户、订单、活动数据。凭证从平台渲染。',
        transport: 'http',
        url: 'https://mcp.internal.example.com/gateway',
        headers: { Authorization: 'Bearer ${env:internal-api/INTERNAL_API_TOKEN}' },
        visibility: 'team',
      },
    },
    {
      owner: 'admin',
      body: {
        slug: 'oss-upload',
        name: '对象存储上传',
        description: '把本地文件传到 team-assets-* 桶并返回可访问地址。',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@team/oss-mcp'],
        env: {
          OSS_ENDPOINT: '${env:oss-storage/OSS_ENDPOINT}',
          OSS_BUCKET: '${env:oss-storage/OSS_BUCKET}',
          OSS_ACCESS_KEY_ID: '${env:oss-storage/OSS_ACCESS_KEY_ID}',
          OSS_ACCESS_KEY_SECRET: '${env:oss-storage/OSS_ACCESS_KEY_SECRET}',
        },
        visibility: 'team',
      },
    },
  ];
  for (const m of MCPS) {
    await api('POST', '/api/mcp-configs', { token: T[m.owner], body: m.body });
    console.log(`  + ${m.body.slug}（${m.body.transport}）`);
  }
  for (const [who, slug] of [['zhengnan', 'crm-db'], ['zhouqi', 'internal-gateway'], ['zhouqi', 'oss-upload'], ['wumin', 'internal-gateway']]) {
    await api('POST', `/api/mcp-configs/${slug}/subscribe`, { token: T[who] });
  }

  // -------------------------------------------------------------- 角色模板
  step('角色模板');
  const TEMPLATES = [
    {
      name: '运营同学',
      description: '活动运营、周报、企业微信通知。入职当天套用即可开始干活。',
      items: [
        ['skill', 'weekly-report'],
        ['skill', 'wecom-bot-notify'],
        ['skill', 'crm-data-query'],
        ['mcp_config', 'internal-gateway'],
        ['mcp_config', 'oss-upload'],
        ['environment', 'wecom-app'],
      ],
    },
    {
      name: '数据分析',
      description: 'CRM 口径、报表与看板。含只读库的 MCP 与环境引用。',
      items: [
        ['skill', 'crm-data-query'],
        ['skill', 'weekly-report'],
        ['mcp_config', 'crm-db'],
        ['environment', 'crm-readonly'],
      ],
    },
    {
      name: '应用开发',
      description: '自助建应用、上线检查、网关调用。',
      items: [
        ['skill', 'release-checklist'],
        ['skill', 'crm-data-query'],
        ['mcp_config', 'internal-gateway'],
        ['environment', 'internal-api'],
      ],
    },
  ];
  const allSkills = await api('GET', '/api/skills', { token: admin });
  const allMcps = await api('GET', '/api/mcp-configs', { token: admin });
  const idOf = (type, slug) =>
    type === 'skill'
      ? allSkills.find((s) => s.slug === slug)?.id
      : type === 'mcp_config'
        ? allMcps.find((m) => m.slug === slug)?.id
        : envIds[slug];
  for (const t of TEMPLATES) {
    const created = await api('POST', '/api/templates', { token: admin, body: { name: t.name, description: t.description } });
    if (!created) continue;
    await api('PUT', `/api/templates/${created.id}/items`, {
      token: admin,
      body: { items: t.items.map(([itemType, slug]) => ({ itemType, itemId: idOf(itemType, slug) })) },
    });
    console.log(`  + ${t.name}（${t.items.length} 项）`);
    if (t.name === '运营同学') await api('POST', `/api/templates/${created.id}/select`, { token: T.wumin });
  }

  // -------------------------------------------------------------- 求助
  step('可求助登记');
  const HELPERS = [
    ['liwei', '内部 API 网关（签名、限流、错误码）、线上部署流程、数据库变更评审。网关相关的问题找我最快。'],
    ['zhengnan', 'CRM 数据口径、报表指标定义、只读库的表结构与坑。指标对不上先问我，不要自己改口径。'],
    ['zhouqi', '运营活动流程、企业微信应用配置与审批、活动页素材规范。'],
    ['sunhao', '前端工程、活动页性能、企业微信机器人推送（消息体 / 限流 / 错误码）。'],
  ];
  for (const [who, description] of HELPERS) {
    await api('PUT', '/api/helpers/me', {
      token: T[who],
      body: { description, available: true, notifyHelp: true, notifyReply: true },
    });
    console.log(`  + ${who}`);
  }

  step('求助会话');
  // 1) 待回复
  await api('POST', '/api/help-requests', {
    token: T.wumin,
    body: {
      title: '活动页的「新客数」和运营后台差了 300 多，口径是哪里不一样？',
      description:
        '我按 crm-data-query 里的口径算 8 月新客：首个有效订单在 8 月的客户，得到 2841。运营后台的活动看板显示 3157。差了 316，不知道是我漏了条件还是两边口径本来就不同。',
      tried:
        '1) 排除了 is_test=true；2) 排除了 status=merged 的客户；3) 按 created_at 和首单时间分别算过，结果差不多；4) 翻了 CRM 的表注释没找到别的标记位。',
      helperUserId: U.zhengnan,
    },
  });
  // 2) 已回复（多轮）
  const answered = await api('POST', '/api/help-requests', {
    token: T.sunhao,
    body: {
      title: '拿到 SIGN_SECRET 了，但调网关一直 401，签名怎么算？',
      description:
        '按文档 HMAC-SHA256(ts + path + body) 算出来的签名，网关一直回 401 invalid signature。ts 用的是毫秒时间戳，body 用的是 JSON.stringify 的结果。',
      tried:
        '换过秒级时间戳、试过 body 为空串、确认过 SIGN_SECRET 是从平台刚拉的最新值（version 3）。用 curl 直接打也是 401。',
      skillSlug: 'release-checklist',
    },
  });
  if (answered) {
    await api('POST', `/api/help-requests/${answered.id}/reply`, {
      token: T.liwei,
      body: {
        content:
          '两个坑：\n1. path 要用**不含 query** 的路径，你如果带了 ?page=1 就会对不上；\n2. body 参与签名的是**压缩后无空格**的 JSON，JSON.stringify 默认就是无空格的，但你如果用了 prettier 格式化过的字符串就会多空格。\n\nts 用毫秒是对的，允许 ±300s 偏移。先把 path 去掉 query 试一次。',
      },
    });
    await api('POST', `/api/help-requests/${answered.id}/reply`, {
      token: T.sunhao,
      body: { content: '去掉 query 之后过了，谢谢。顺问一下：签名失败网关能不能返回具体是哪一段对不上？现在只回 invalid signature，排查很慢。' },
    });
  }
  // 3) 已解决 + 沉淀经验
  const resolved = await api('POST', '/api/help-requests', {
    token: T.zhouqi,
    body: {
      title: '企业微信机器人发图片一直报 40008，文本消息是正常的',
      description:
        '活动海报要推到运营群。文本和 markdown 都能发出去，换成图片就返回 {"errcode":40008,"errmsg":"invalid message type"}。图片是 PNG，480KB。',
      tried: '换过 jpg、压到 200KB、把 image.url 换成公网可访问地址，都还是 40008。',
      helperUserId: U.sunhao,
    },
  });
  if (resolved) {
    await api('POST', `/api/help-requests/${resolved.id}/reply`, {
      token: T.sunhao,
      body: {
        content:
          '群机器人的图片消息**不支持 URL**，必须传 base64 和图片的 md5（是原图字节的 md5，不是 base64 字符串的 md5），而且限制 2MB、只支持 jpg/png：\n\n```json\n{"msgtype":"image","image":{"base64":"<base64>","md5":"<原图 md5>"}}\n```\n\n40008 在这里的真实含义是「这个 msgtype 的消息体不合法」，文案有误导。',
      },
    });
    await api('POST', `/api/help-requests/${resolved.id}/reply`, {
      token: T.zhouqi,
      body: { content: '按 base64 + 原图 md5 发出去了，成了。md5 一开始算错成 base64 的 md5，也是回 40008。' },
    });
    await api('POST', `/api/help-requests/${resolved.id}/resolve`, { token: T.zhouqi });
    await api('POST', `/api/help-requests/${resolved.id}/distill`, {
      token: T.sunhao,
      body: {
        slug: 'exp-wecom-image-40008',
        name: '经验：企业微信机器人发图片报 40008',
        public: true,
        grantedToRequester: true,
        grantedToHelper: true,
        useAi: false,
        content: `# 企业微信机器人发图片报 40008

## 问题

群机器人推送图片消息返回 \`{"errcode":40008,"errmsg":"invalid message type"}\`，同一个 webhook 发文本 / markdown 正常。

## 原因

群机器人的图片消息**不接受 URL**，只接受 base64。40008 的字面意思是「消息类型不支持」，实际含义是「这个 msgtype 的消息体不合法」——文案有误导，容易让人去怀疑 msgtype 本身。

## 正确写法

\`\`\`json
{ "msgtype": "image", "image": { "base64": "<图片 base64>", "md5": "<原图字节的 md5>" } }
\`\`\`

两个容易踩的点：

- \`md5\` 是**原图字节**的 md5，不是 base64 字符串的 md5。算错同样返回 40008。
- 限制：≤ 2MB，仅 jpg / png。

## 验证

\`\`\`bash
python3 -c "import base64,hashlib,json,sys;d=open('poster.png','rb').read();print(json.dumps({'msgtype':'image','image':{'base64':base64.b64encode(d).decode(),'md5':hashlib.md5(d).hexdigest()}}))" > msg.json
curl "$WECOM_WEBHOOK" -H 'content-type: application/json' -d @msg.json
\`\`\`
`,
      },
    });
  }
  console.log('  + 待回复 / 已回复 / 已解决（含沉淀经验）各一条');

  // 登记完求助再补通知配置：避免上面的求助真去投递一个演示用的 webhook 地址
  await api('PUT', '/api/helpers/me', {
    token: T.liwei,
    body: {
      description: HELPERS[0][1],
      available: true,
      notifyHelp: true,
      notifyReply: true,
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/00000000-demo-0000-0000-000000000000',
      webhookSecret: 'demo-sign-secret',
    },
  });

  // -------------------------------------------------------------- 数据库
  step('数据库实例与分配');
  const instance = await api('POST', '/api/db/instances', {
    token: admin,
    body: {
      name: '测试 PostgreSQL（研发共用）',
      engine: 'postgres',
      host: process.env.EAT_DEMO_PG_HOST ?? '127.0.0.1',
      port: Number(process.env.EAT_DEMO_PG_PORT ?? 5433),
      adminUser: process.env.EAT_DEMO_PG_USER ?? 'dev',
      adminPassword: process.env.EAT_DEMO_PG_PASSWORD ?? '',
      note: '仅测试数据，每周日 03:00 全量重置。生产库不在平台纳管范围内。',
    },
  });
  await api('POST', '/api/db/instances', {
    token: admin,
    body: {
      name: '测试 MySQL（活动业务）',
      engine: 'mysql',
      host: 'mysql-test.internal',
      port: 3306,
      adminUser: 'root',
      adminPassword: 'demo-admin-password',
      note: '活动相关业务库；MySQL 自动建库暂未开放，先登记占位。',
    },
  });
  if (instance) {
    const a1 = await api('POST', '/api/db/assignments', {
      token: T.sunhao,
      body: { instanceId: instance.id, dbName: 'crm_dashboard', purpose: '客户看板的后端存本地缓存表与导出任务记录，只需要一个独立库。' },
    });
    if (a1) {
      await api('POST', `/api/db/assignments/${a1.id}/approve`, { token: admin });
      console.log('  + 已批准并真实建库：crm_dashboard');
    }
    const a2 = await api('POST', '/api/db/assignments', {
      token: T.wumin,
      body: { instanceId: instance.id, dbName: 'campaign_1111', purpose: '双十一活动页要存报名信息与抽奖记录，活动结束后可回收。' },
    });
    if (a2) console.log('  + 待审批：campaign_1111');
  }

  // -------------------------------------------------------------- 平台设置
  step('平台设置');
  await api('PUT', '/api/admin/registration-settings', {
    token: admin,
    body: { enabled: true, allowedEmailSuffixes: ['@example.com'] },
  });
  await api('PUT', '/api/admin/ai-settings', {
    token: admin,
    body: {
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.EAT_DEMO_AI_KEY ?? 'sk-demo-not-a-real-key-0000000000',
      model: 'gpt-4o-mini',
      enabled: true,
    },
  });
  console.log('  + 开放注册（限 @example.com）/ AI 接入');

  await sleep(200);
  console.log(`\n完成${failures ? `（${failures} 个请求失败，见上方 ! 行）` : ''}。演示账号密码统一为 ${DEMO_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
