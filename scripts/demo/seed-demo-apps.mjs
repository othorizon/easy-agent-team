#!/usr/bin/env node
/**
 * 演示数据（部署托管部分）：配好部署后台接入，并以成员身份自助创建两个应用。
 *
 * 需要一台可用的 Dokploy。云端会话里用 `scripts/dev-dokploy.sh start` 自建一台即可：
 *
 *   scripts/dev-dokploy.sh start                       # Dokploy 占 3000
 *   PORT=3001 node apps/server/dist/main.js            # 平台换 3001
 *   EAT_SERVER=http://localhost:3001 \
 *   DOKPLOY_API=http://127.0.0.1:3000/api \
 *   DOKPLOY_TOKEN=$(scripts/dev-dokploy.sh key) \
 *   node scripts/demo/seed-demo-apps.mjs
 *
 * 仓库地址默认指向 `scripts/demo/serve-demo-repos.mjs` 起的本地 Git 服务，
 * 这样容器内 clone 得到、构建也真的能成功。
 */
const SERVER = (process.env.EAT_SERVER ?? 'http://localhost:3000').replace(/\/+$/, '');
const DOKPLOY_API = (process.env.DOKPLOY_API ?? 'http://127.0.0.1:3000/api').replace(/\/+$/, '');
const DOKPLOY_TOKEN = process.env.DOKPLOY_TOKEN ?? '';
const GIT_BASE = process.env.EAT_DEMO_GIT_BASE ?? 'http://git.internal.example.com:8088';
const DOMAIN_SUFFIX = process.env.EAT_DEMO_DOMAIN_SUFFIX ?? 'apps.internal.example.com';
const DEMO_PASSWORD = 'demo12345';

async function req(base, method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    console.warn(`  ! ${method} ${path} → ${res.status} ${data?.message ?? text}`);
    return null;
  }
  return data;
}
const api = (m, p, o) => req(SERVER, m, p, o);
const dokploy = (m, p, o) =>
  req(DOKPLOY_API, m, p, { ...o, headers: { 'x-api-key': DOKPLOY_TOKEN } });
const login = async (email, password = DEMO_PASSWORD) =>
  (await api('POST', '/api/auth/login', { body: { email, password } }))?.token;

async function main() {
  if (!DOKPLOY_TOKEN) throw new Error('缺少 DOKPLOY_TOKEN');
  const admin = await login(process.env.EAT_ADMIN_EMAIL ?? 'admin@example.com', process.env.EAT_ADMIN_PASSWORD ?? 'admin12345');
  const sunhao = await login('sunhao@example.com');
  const zhouqi = await login('zhouqi@example.com');
  if (!admin || !sunhao || !zhouqi) throw new Error('登录失败，先跑 scripts/demo/seed-demo.mjs');

  console.log('\n== 部署后台：项目与落点');
  // 先把接入信息写进去（落点留空），否则平台的项目清单接口会以「未配置」拒绝
  await api('PUT', '/api/admin/dokploy-settings', {
    token: admin,
    body: {
      apiUrl: DOKPLOY_API,
      apiToken: DOKPLOY_TOKEN,
      enabled: true,
      projectId: '',
      environmentId: '',
      sshKeyId: '',
      domainSuffix: DOMAIN_SUFFIX,
      domainHttps: false,
    },
  });
  const projects = (await dokploy('GET', '/project.all')) ?? [];
  let project = projects.find((p) => p.name === '团队应用');
  if (!project) {
    await dokploy('POST', '/project.create', { body: { name: '团队应用', description: '平台自助创建的应用都落在这里' } });
    project = ((await dokploy('GET', '/project.all')) ?? []).find((p) => p.name === '团队应用');
  }
  if (!project) throw new Error('无法在部署后台创建项目');
  const platformProjects = (await api('GET', '/api/admin/dokploy/projects', { token: admin })) ?? [];
  const target = platformProjects.find((p) => p.projectId === project.projectId);
  const env = target?.environments.find((e) => e.isDefault) ?? target?.environments[0];
  if (!env) throw new Error('项目下没有环境');
  await api('PUT', '/api/admin/dokploy-settings', {
    token: admin,
    body: {
      apiUrl: DOKPLOY_API,
      apiToken: DOKPLOY_TOKEN,
      enabled: true,
      projectId: project.projectId,
      environmentId: env.environmentId,
      sshKeyId: '',
      domainSuffix: DOMAIN_SUFFIX,
      domainHttps: false,
    },
  });
  console.log(`  + 落点：项目「${project.name}」/ 环境「${env.name}」，域名后缀 ${DOMAIN_SUFFIX}`);

  console.log('\n== 成员自助创建应用');
  const created = [];
  const APPS = [
    {
      token: sunhao,
      body: {
        slug: 'crm-dashboard',
        name: '客户看板',
        repoUrl: `${GIT_BASE}/crm-dashboard.git`,
        branch: 'main',
        buildType: 'dockerfile',
        dockerfile: 'Dockerfile',
        dockerContextPath: '',
        port: 3000,
        description: '销售同学看的客户与订单看板。数据来自 CRM 只读副本，口径见 crm-data-query。',
      },
    },
    {
      token: zhouqi,
      body: {
        slug: 'ops-docs',
        name: '运维手册',
        repoUrl: `${GIT_BASE}/ops-docs.git`,
        branch: 'main',
        buildType: 'static',
        publishDirectory: 'public',
        staticSpa: false,
        description: '值班流程与常用命令，改完提交即可上线。',
      },
    },
  ];
  for (const a of APPS) {
    const r = await api('POST', '/api/apps', { token: a.token, body: a.body });
    if (r) {
      created.push(r);
      console.log(`  + ${r.slug}（${a.body.buildType}）→ ${r.url ?? '未分配域名'}`);
    }
  }

  console.log('\n== 部署授权与成员');
  // 客户看板：管理员授权一次，之后成员可自行部署。运维手册故意留在「待授权」，用来展示门禁。
  await api('POST', '/api/apps/crm-dashboard/approve', { token: admin });
  const users = (await api('GET', '/api/users', { token: admin })) ?? [];
  const liwei = users.find((u) => u.email === 'liwei@example.com');
  if (liwei) await api('POST', '/api/apps/crm-dashboard/members', { token: sunhao, body: { userId: liwei.id } });
  console.log('  + crm-dashboard 已授权部署，并加入成员 李维');

  console.log('\n== 应用 env');
  await api('PUT', '/api/apps/crm-dashboard/env', {
    token: sunhao,
    body: {
      target: 'runtime',
      content: [
        '# 运行时环境变量（推送为整体覆盖）',
        'PORT=3000',
        'NODE_ENV=production',
        'CRM_REFRESH_SECONDS=300',
      ].join('\n'),
    },
  });
  await api('PUT', '/api/apps/crm-dashboard/env', {
    token: sunhao,
    body: { target: 'build', content: 'BUILD_CHANNEL=stable\n' },
  });
  console.log('  + crm-dashboard 运行时 3 项 / 构建时 1 项');
  console.log('\n完成。触发一次真实部署：eat deploy crm-dashboard（或控制台应用详情页的「部署」按钮）');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
