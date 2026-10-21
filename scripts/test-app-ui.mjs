import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

// Built UI with local API fixtures; never writes to a real EAT or GitHub instance.
const dist = resolve('apps/web/dist'), shots = process.env.EAT_UI_SHOTS || join(tmpdir(), 'eat-app-pages');
mkdirSync(shots, { recursive: true });
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = pathname.startsWith('/assets/') ? join(dist, pathname) : join(dist, 'index.html');
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
  res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const errors = [];
async function fixture(width, role = 'admin') {
  const user = { id: role === 'admin' ? 'owner' : 'reader', name: '林小满', email: 'owner@example.test', role, status: 'active', bio: '', allowHelp: true };
  const app = { id: 'app-id', slug: 'demo', name: '团队知识库', description: '汇总团队经验与常用资料，让知识在协作中持续积累。', repoUrl: 'git@github.com:eat-org/team-knowledge.git', branch: 'main', buildType: 'dockerfile', dockerfile: 'Dockerfile', dockerContextPath: '', publishDirectory: '.', staticSpa: false, port: 3000, domain: 'knowledge.example.test', url: 'https://knowledge.example.test', dokployApplicationId: 'demo', ownerId: 'owner', ownerName: '林小满', members: [{ userId: 'member', name: '陈予安' }], isMember: true, canDeploy: true, managed: true, deployApproved: true, approvedByName: '管理员', approvedAt: '2026-10-21T08:00:00Z', approvalRequestedAt: null, createdAt: '2026-10-20T10:30:00Z' };
  const candidates = [{ id: 'yan', name: '颜悦', email: 'yanyue@example.test' }, { id: 'pan', name: '潘彦琳', email: 'panyanlin@example.test' }, { id: 'zhang', name: '张静远', email: 'zhangjingyuan@example.test' }, { id: 'long', name: '用于检查完整姓名展示的测试成员', email: 'long-address-for-responsive-layout@example.test' }];
  const state = { extraApps: [], repoStates: {}, addError: false, usersError: false, appsError: false, deploymentsError: false, enabled: true, env: { runtime: 'NODE_ENV=production\nPORT=3000', build: 'PUBLIC_APP_NAME=Knowledge' } };
  const writes = [], context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(user => { localStorage.setItem('eat.token', 'fixture-token'); localStorage.setItem('eat.user', JSON.stringify(user)); }, user);
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    if (method !== 'GET') writes.push({ path, method, body });
    let result = {}, status = 200;
    if (path === '/api/account/onboarding') result = { required: false, requireBio: false, requireNotification: false };
    else if (path === '/api/requests') result = { items: [], total: 0, page: 1, pageSize: 20, pendingCount: 0 };
    else if (path === '/api/apps') { result = [app, ...state.extraApps]; if (state.appsError) { status = 500; result = { message: '加载失败' }; } }
    else if (path === '/api/users') { result = [user, { id: 'member', name: '陈予安', email: 'chen@example.test' }, ...candidates]; if (state.usersError) { status = 500; result = { message: '用户加载失败' }; } }
    else if (path === '/api/apps/demo/github') result = { enabled: state.enabled, organization: 'eat-org', repository: 'eat-org/team-knowledge', repositoryId: '100', scope: 'organization', checkedAt: '2026-10-21T08:00:00Z', error: '', ownerLogin: 'xiaoman', ownerRole: 'admin', ownerIsOrgOwner: false,
      members: [{ userId: 'owner', name: app.ownerName, login: 'xiaoman', isOwner: true, orgState: 'active', role: 'admin', state: 'succeeded', error: '', notification: '', canGrant: role === 'admin', canChangeRole: role === 'admin' },
      ...app.members.map(m => ({ ...m, login: m.userId === 'member' ? 'yuchen' : null, orgState: m.userId === 'member' ? 'active' : 'unknown', role: m.userId === 'member' ? 'write' : 'unknown', state: m.userId === 'member' ? 'succeeded' : 'unlinked', error: '', notification: '', canGrant: role === 'admin', canChangeRole: role === 'admin' }))] };
    else if (path === '/api/apps/demo/github/collaborators') result = { repository: 'eat-org/team-knowledge', repositoryId: '100', repoVersion: 1, checkedAt: new Date().toISOString(), canManage: role === 'admin', collaborators: [
      { githubId: '101', login: 'xiaoman', role: 'admin', roleError: '', direct: true, userId: 'owner', name: app.ownerName, relation: 'owner' },
      { githubId: '102', login: 'yuchen', role: 'write', roleError: '', direct: true, userId: 'member', name: '陈予安', relation: app.members.some(m => m.userId === 'member') ? 'member' : 'eat' },
    ] };
    else if (path === '/api/apps/demo/members' && method === 'POST') {
      if (state.addError) { status = 403; result = { message: '当前仓库尚未批准，请刷新后重试' }; }
      else { const u = candidates.find(u => u.id === body.userId); app.members.push({ userId: u.id, name: u.name }); }
    }
    else if (path.startsWith('/api/apps/demo/members/') && method === 'DELETE') app.members = app.members.filter(m => m.userId !== path.split('/').at(-1));
    else if (path === '/api/apps/demo/env') { if (method === 'PUT') { state.env[body.target] = body.content; result = { added: [], changed: ['PORT'], removed: [] }; } else result = state.env; }
    else if (path === '/api/apps/demo' && method === 'PATCH') Object.assign(app, body);
    else if (path === '/api/apps/demo' && method === 'DELETE') result = { dokployDeleted: true };
    else if (path === '/api/apps/demo/approve') { app.deployApproved = method === 'POST'; app.canDeploy = app.deployApproved; }
    else if (path === '/api/apps/demo/deploy') result = { deploymentId: 'd1', status: 'queued' };
    else if (path === '/api/apps/demo/deployments') { result = [{ deploymentId: 'd1', createdAt: '2026-10-21T09:10:00Z', status: 'done', error: null, platform: { id: 'p1', triggeredByName: app.ownerName, source: 'console', claim: 'exact' } }]; if (state.deploymentsError) { status = 500; result = { message: '部署后台暂不可用' }; } }
    else if (path.endsWith('/build-logs')) result = { logs: 'Step 1/3: Installing dependencies\nStep 2/3: Building application\nStep 3/3: Application ready', deployment: { deploymentId: 'd1', status: 'done' } };
    else if (path.endsWith('/run-logs')) result = { logs: 'Listening on port 3000\nGET /health 200', container: { name: 'knowledge', state: 'running' } };
    else if (path.endsWith('/github/refresh')) result = { ok: true };
    else if (/^\/api\/apps\/[^/]+\/github$/.test(path)) {
      const repo = state.repoStates[path.split('/')[3]];
      if (repo === 'error') { status = 503; result = { message: 'GitHub 暂不可用' }; }
      else result = { enabled: true, scope: 'unknown', checkedAt: null, error: '', ...repo };
    }
    else { status = 404; result = { message: `未覆盖的请求 ${method} ${path}` }; errors.push(result.message); }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  return { page, context, app, state, writes };
}
async function shot(page, name) {
  await page.locator('[data-sonner-toast]').last().waitFor({ state: 'hidden' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true, animations: 'disabled' });
}
async function verifyAppList(width) {
  const f = await fixture(width), p = f.page;
  const extra = (slug, name, fields = {}) => ({ ...f.app, id: slug, slug, name, members: [], repoUrl: `git@github.com:eat-org/${slug}.git`, ...fields });
  f.state.extraApps = [
    extra('feedback', '客户反馈收集', { ownerId: 'other', ownerName: '陈予安', members: [{ userId: 'owner', name: '林小满' }], repoUrl: 'https://github.com/partner-team/feedback.git' }),
    extra('operations', '内部运营工具', { deployApproved: false, canDeploy: false }),
    extra('event', '活动报名页', { buildType: 'static', port: 80, ownerId: 'other', ownerName: '颜悦', members: [{ userId: 'owner', name: '林小满' }] }),
    extra('report', '数据周报', { managed: false, buildType: null, branch: 'main' }),
    extra('preview', '产品演示站', { buildType: 'static', deployApproved: false, canDeploy: false, branch: 'preview' }),
    extra('other', '其他团队应用', { ownerId: 'other', ownerName: '颜悦' }),
  ];
  f.state.repoStates = { feedback: { scope: 'outside' }, event: { scope: 'organization' }, report: { scope: 'organization' }, preview: { scope: 'organization' }, other: { scope: 'organization' } };
  await p.goto(`${base}/apps`);
  const list = p.getByRole('list', { name: '应用列表' });
  const row = slug => list.getByRole('link', { name: new RegExp(`^${slug} `) });
  await p.getByRole('tab', { name: '我的 6', selected: true }).waitFor();
  await row('feedback').getByText('非 EAT 组织仓库', { exact: true }).waitFor();
  await row('operations').getByText('仓库归属待核验').waitFor();
  await row('event').getByText('静态站点').waitFor();
  await row('report').getByText('挂载应用').waitFor();
  await row('report').getByText('构建由部署后台管理').waitFor();
  await row('report').getByText('分支由部署后台管理').waitFor();
  assert.equal(await row('report').getByText('main', { exact: true }).count(), 0, 'mounted apps must not present a database default as a verified branch');
  assert.equal(await row('other').count(), 0, 'admin global privileges must not put unrelated apps in My apps');
  assert.equal(await list.getByRole('listitem').count(), 6);
  await shot(p, `list-mine-${width}`);
  await p.getByRole('tab', { name: '全部 7' }).click();
  await row('other').getByText('管理员访问').waitFor();
  await row('other').getByText('所有者 颜悦').waitFor();
  await shot(p, `list-all-${width}`);
  await p.reload();
  await p.getByRole('tab', { name: '全部 7', selected: true }).waitFor();
  await p.getByRole('searchbox').fill('feedback');
  await row('feedback').waitFor();
  assert.equal(await list.getByRole('listitem').count(), 1);
  await p.getByRole('tab', { name: '我的 6' }).click();
  assert.equal(await p.getByRole('searchbox').inputValue(), 'feedback');
  await p.getByRole('searchbox').fill('');
  await p.getByRole('combobox', { name: '部署权限筛选' }).click();
  await p.getByRole('option', { name: '待授权', exact: true }).click();
  await row('operations').waitFor();
  assert.equal(await list.getByRole('listitem').count(), 2);
  await row('preview').getByText('待授权', { exact: true }).waitFor();
  await p.getByRole('combobox', { name: '部署权限筛选' }).click();
  await p.getByRole('option', { name: '可部署', exact: true }).click();
  await row('demo').click();
  await p.getByRole('link', { name: '返回应用列表' }).click();
  await p.waitForURL('**/apps?filter=ready');
  assert.equal(await list.getByRole('listitem').count(), 4);
  // Failed, disabled, non-GitHub and empty repositories must not masquerade as verified org repositories.
  f.state.repoStates.feedback = 'error';
  f.state.repoStates.preview = { enabled: false };
  f.state.extraApps.find(a => a.slug === 'event').repoUrl = 'https://fixture-user:fixture-password@git.example.test/team/site.git?fixture-secret=1';
  f.state.extraApps.find(a => a.slug === 'report').repoUrl = '';
  await p.goto(`${base}/apps`);
  await row('feedback').getByText('归属暂不可用').waitFor();
  await row('preview').getByText('归属待核验 · GitHub 未启用').waitFor();
  await row('event').getByText('git.example.test/team/site', { exact: true }).waitFor();
  assert(!(await list.textContent()).includes('fixture-password'));
  assert(!(await list.textContent()).includes('fixture-secret'));
  await row('report').getByText('未配置仓库').waitFor();
  await shot(p, `list-query-states-${width}`);
  // Page-size/scope changes reset pagination, while permission comes from the API rather than UI role guesses.
  f.state.extraApps.push(...Array.from({ length: 22 }, (_, i) => extra(`many-${i}`, `附加应用 ${i}`, { ownerId: 'other', repoUrl: '' })));
  await p.goto(`${base}/apps?scope=all&page=2`);
  await p.getByRole('tab', { name: '全部 29', selected: true }).waitFor();
  assert.equal(await list.getByRole('listitem').count(), 9);
  await p.getByRole('tab', { name: '我的 6' }).click();
  assert.equal(new URL(p.url()).searchParams.get('page'), null);
  assert.equal(await list.getByRole('listitem').count(), 6);
  await f.context.close();
  const member = await fixture(width, 'member');
  member.app.isMember = false; member.app.canDeploy = false;
  await member.page.goto(`${base}/apps`);
  await member.page.getByText('暂无我创建或加入的应用').waitFor();
  await member.page.getByRole('button', { name: '查看全部应用' }).click();
  const outsider = member.page.getByRole('list', { name: '应用列表' });
  await outsider.getByText('未加入', { exact: true }).first().waitFor();
  assert.equal(await outsider.getByText('可部署', { exact: true }).count(), 0);
  await member.context.close();
  console.log(`Application list verified at ${width}px`);
}
try {
  for (const width of [1280, 390]) {
    await verifyAppList(width);
    const f = await fixture(width), p = f.page;
    await p.goto(`${base}/apps?q=demo`);
    await p.getByRole('link', { name: /demo.*团队知识库/ }).click();
    await p.waitForURL('**/apps/demo');
    assert.equal(await p.getByRole('dialog').count(), 0, 'detail is a page');
    await p.getByText('仓库与 GitHub', { exact: true }).waitFor();
    await shot(p, `overview-${width}`);
    await p.getByRole('button', { name: '编辑配置' }).click();
    await p.getByRole('dialog', { name: '编辑应用 demo' }).waitFor();
    await shot(p, `edit-config-${width}`);
    await p.locator('#app-edit-name').fill('团队知识库（新版）');
    await p.getByRole('button', { name: '保存', exact: true }).click();
    await p.getByRole('heading', { name: /团队知识库（新版）/ }).waitFor();
    await p.getByRole('tab', { name: '成员', exact: true }).click();
    await p.reload();
    await p.getByRole('tab', { name: '成员', exact: true, selected: true }).waitFor();
    await p.goBack();
    await p.getByRole('tab', { name: '概览', exact: true, selected: true }).waitFor();
    await p.goForward();
    await p.getByRole('tab', { name: '成员', exact: true, selected: true }).waitFor();
    await p.getByRole('region', { name: '@yuchen 的仓库权限' }).waitFor();
    await shot(p, `members-${width}`);
    await p.getByRole('button', { name: '添加成员', exact: true }).click();
    const dialog = p.getByRole('dialog', { name: '添加应用成员' });
    const add = dialog.getByRole('button', { name: '添加成员', exact: true });
    assert(await add.isDisabled());
    await dialog.getByRole('searchbox').fill('yan');
    assert.equal(await dialog.getByRole('radio').count(), 2);
    await dialog.getByRole('radio', { name: '潘彦琳 panyanlin@example.test' }).check();
    assert(!f.writes.some(w => w.path.endsWith('/members')), 'selecting must not submit');
    await shot(p, `add-member-${width}`);
    await dialog.getByRole('searchbox').fill('no-match');
    await dialog.getByText('没有匹配的用户，试试其他姓名或邮箱').waitFor();
    await dialog.getByRole('searchbox').fill('潘彦琳');
    assert.equal(await dialog.getByRole('radio').count(), 1);
    f.state.addError = true;
    await add.click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(f.app.members.length, 1);
    await shot(p, `add-error-${width}`);
    f.state.addError = false;
    await add.click();
    await dialog.waitFor({ state: 'hidden' });
    await p.getByRole('button', { name: '移除 潘彦琳', exact: true }).waitFor();
    assert(f.writes.some(w => w.path === '/api/apps/demo/members' && w.body.userId === 'pan'));
    await p.getByRole('button', { name: '移除 潘彦琳' }).click();
    await p.getByRole('alertdialog').getByRole('button', { name: '取消' }).click();
    assert.equal(f.app.members.length, 2);
    await p.getByRole('button', { name: '移除 潘彦琳' }).click();
    await p.getByRole('alertdialog').getByRole('button', { name: '移除成员' }).click();
    await p.getByRole('button', { name: '移除 潘彦琳' }).waitFor({ state: 'hidden' });
    await p.getByRole('tab', { name: '环境变量', exact: true }).click();
    await p.getByText('NODE_ENV=production', { exact: false }).waitFor();
    await shot(p, `environment-${width}`);
    await p.getByRole('button', { name: '编辑', exact: true }).first().click();
    const env = p.getByRole('dialog', { name: '编辑环境变量' });
    await env.getByRole('textbox', { name: '环境变量内容' }).fill('NODE_ENV=production\nPORT=4000');
    await shot(p, `edit-environment-${width}`);
    await env.getByRole('button', { name: '保存', exact: true }).click();
    await env.waitFor({ state: 'hidden' });
    assert.equal(f.state.env.runtime, 'NODE_ENV=production\nPORT=4000');
    assert.equal(f.state.env.build, 'PUBLIC_APP_NAME=Knowledge');
    await p.getByRole('button', { name: '部署', exact: true }).click();
    await p.getByRole('alertdialog').getByRole('button', { name: '部署', exact: true }).click();
    await p.getByRole('tab', { name: '部署记录', selected: true }).waitFor();
    await p.getByText('成功', { exact: true }).filter({ visible: true }).waitFor();
    await shot(p, `deployments-${width}`);
    await p.getByRole('button', { name: '构建日志', exact: true }).click();
    await p.getByText('Step 1/3: Installing dependencies', { exact: false }).waitFor();
    await shot(p, `build-logs-${width}`);
    await p.getByRole('button', { name: '关闭', exact: true }).click();
    await p.getByRole('tab', { name: '概览', exact: true }).click();
    await p.getByRole('button', { name: '撤销授权' }).click();
    await p.getByRole('alertdialog').getByRole('button', { name: '撤销授权' }).click();
    await p.getByRole('link', { name: '前往审批' }).waitFor();
    assert(await p.getByRole('button', { name: '部署', exact: true }).isDisabled());
    await p.getByRole('tab', { name: '成员', exact: true }).click();
    assert(await p.getByRole('button', { name: '添加成员', exact: true }).isDisabled());
    assert(await p.getByRole('button', { name: '移除 陈予安' }).isEnabled());
    await shot(p, `members-pending-${width}`);
    // Back navigation, list filter restoration and direct links work independently of the list view.
    await p.getByRole('link', { name: '返回应用列表' }).click();
    await p.waitForURL('**/apps?q=demo');
    assert.equal(new URL(p.url()).search, '?q=demo');
    await p.goto(`${base}/apps/missing?tab=members`);
    await p.getByText('应用不存在或你无权查看').waitFor();
    f.state.deploymentsError = true;
    await p.goto(`${base}/apps/demo?tab=deployments`);
    await p.getByText('部署记录加载失败').waitFor();
    f.state.deploymentsError = false;
    await p.getByRole('button', { name: '重试', exact: true }).click();
    await p.getByText('成功', { exact: true }).filter({ visible: true }).waitFor();
    await f.context.close();
    const reader = await fixture(width, 'member');
    await reader.page.goto(`${base}/apps/demo?tab=members`);
    await reader.page.getByRole('region', { name: '@yuchen 的仓库权限' }).waitFor();
    assert.equal(await reader.page.getByRole('button', { name: '添加成员', exact: true }).count(), 0);
    assert.equal(await reader.page.getByRole('button', { name: '编辑配置' }).count(), 0);
    assert.equal(await reader.page.getByRole('button', { name: /移除/ }).count(), 0);
    reader.state.enabled = false;
    await reader.page.reload();
    await reader.page.getByText('GitHub 集成未启用，EAT 应用成员权限独立生效。').waitFor();
    reader.app.isMember = false; reader.app.canDeploy = false;
    await reader.page.goto(`${base}/apps/demo?tab=env`);
    await reader.page.getByText('仅应用成员可查看与修改环境变量').waitFor();
    assert.equal(await reader.page.getByRole('button', { name: '部署', exact: true }).count(), 0);
    await reader.context.close();
    console.log(`Application pages verified at ${width}px`);
  }
  assert.deepEqual(errors, []);
  console.log(`Application pages desktop/mobile passed; screenshots: ${shots}`);
} finally { await browser.close(); await new Promise(r => server.close(r)); }
