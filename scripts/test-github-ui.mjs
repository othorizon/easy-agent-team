import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const dist = resolve('apps/web/dist'), shots = join(tmpdir(), 'eat-github-ui');
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
const memberId = '00000000-0000-4000-8000-000000000002';
const user = { id: '00000000-0000-4000-8000-000000000001', name: '应用管理员', email: 'admin@example.test', role: 'admin', status: 'active', bio: '维护平台', allowHelp: true };
const appInfo = { id: '00000000-0000-4000-8000-000000000003', slug: 'demo', name: '组织演示应用', repoUrl: 'git@github.com:eat-org/demo.git', branch: 'main', buildType: 'dockerfile', dockerfile: 'Dockerfile', dockerContextPath: '', publishDirectory: '.', staticSpa: false, port: 3000, domain: null, url: null, dokployApplicationId: 'demo', description: '', ownerId: user.id, ownerName: user.name, members: [{ userId: memberId, name: '应用成员' }], isMember: true, canDeploy: true, managed: true, deployApproved: true, approvedByName: user.name, approvedAt: new Date().toISOString(), approvalRequestedAt: null, createdAt: new Date().toISOString() };
const onboarding = { requireBio: false, requireNotification: false, bioComplete: true, notificationComplete: false, required: false };
async function fixture(width) {
  const context = await browser.newContext({ viewport: { width, height: 980 } });
  await context.addInitScript(user => { localStorage.setItem('eat.token', 'fixture-token'); localStorage.setItem('eat.user', JSON.stringify(user)); }, user);
  const writes = [], account = { enabled: true, organization: 'eat-org', linked: true, login: 'demo-user', needsAuthorization: false, orgState: 'pending', orgRole: null, checkedAt: new Date().toISOString(), error: '', task: { state: 'failed', error: '自动接受未完成，请手动重试', attempts: 1, notification: '已通知管理员' } };
  const settings = { enabled: true, organization: 'eat-org', appId: '1', clientId: 'client', installationId: '2',
    hasClientSecret: true, hasPrivateKey: true, callbackUrl: `${base}/api/github/callback`, setupCallbackUrl: `${base}/api/github/setup/installation`,
    manifestCallbackUrl: `${base}/api/github/setup/manifest`, appSlug: 'eat-demo', connectionState: 'connected', connectionError: '', checkedAt: new Date().toISOString() };
  let created = 9;
  await context.route('https://github.com/**', async route => {
    const request = route.request(); writes.push({ path: new URL(request.url()).pathname, method: request.method(), external: true });
    assert(!request.headers().authorization, 'EAT bearer token must not be sent to GitHub');
    assert(new URL(request.url()).searchParams.get('state'), 'setup needs a state');
    let result;
    if (request.method() === 'POST') {
      const manifest = JSON.parse(new URLSearchParams(request.postData()).get('manifest'));
      assert.equal(manifest.default_permissions.members, 'write');
      assert.equal(manifest.default_permissions.administration, 'write');
      account.needsAuthorization = !!settings.appId;
      Object.assign(settings, { enabled: false, appId: String(++created), clientId: 'created-client', installationId: '', appSlug: 'eat-demo',
        hasClientSecret: true, hasPrivateKey: true, connectionState: 'app_ready', connectionError: '' }); result = 'created';
    } else {
      Object.assign(settings, { installationId: '99', connectionState: 'connected', enabled: true, connectionError: '' }); result = 'installed';
    }
    await route.fulfill({ status: 302, headers: { location: `${base}/settings?section=github&github_setup=${result}` }, body: '' });
  });
  const githubApp = { enabled: true, organization: 'eat-org', repository: 'eat-org/demo', repositoryId: '100', scope: 'organization', checkedAt: new Date().toISOString(), error: '', ownerLogin: 'demo-owner', ownerRole: 'maintain', ownerIsOrgOwner: false,
    members: [{ userId: user.id, name: user.name, login: 'demo-owner', isOwner: true, orgState: 'active', role: 'maintain', state: 'succeeded', error: '', notification: '', canGrant: true, canChangeRole: true },
      { userId: memberId, name: '应用成员', login: 'demo-member', orgState: 'active', role: 'none', state: 'not_requested', error: '', notification: '', canGrant: true, canChangeRole: true }] };
  const extraCollaborators = [{ githubId: '99', login: 'guest-dev', role: 'write', roleError: '', direct: true, userId: null, name: null, relation: 'external' }, { githubId: '98', login: 'other-eat', role: 'read', roleError: '', direct: true, userId: 'other-eat-id', name: '其他用户', relation: 'eat' }, { githubId: '97', login: 'reviewer', role: 'read', roleError: '', direct: false, userId: null, name: null, relation: 'external' }];
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    if (method !== 'GET') writes.push({ path, method, body });
    let result = {}, status = 200;
    if (path === '/api/account/onboarding') result = onboarding;
    else if (path === '/api/account') result = { ...user, onboarding, notification: { webhookUrl: '', hasWebhookSecret: false, verified: false, notifyHelp: true, notifyReply: true, notifyMention: true } };
    else if (path === '/api/account/github') result = account;
    else if (path === '/api/account/github/accept') { account.orgState = 'active'; account.task = null; result = { ok: true }; }
    else if (path === '/api/account/github/refresh') result = { ok: true };
    else if (path === '/api/requests') result = { items: [], total: 0, pendingCount: 0, page: 1, pageSize: 20 };
    else if (path === '/api/users') result = [user, { ...user, id: memberId, name: '应用成员', role: 'member' }];
    else if (/^\/api\/users\/[^/]+\/github$/.test(path)) result = method === 'GET' ? account : { ok: true };
    else if (path === '/api/apps') result = [appInfo];
    else if (path === '/api/apps/demo/github') result = githubApp;
    else if (path === '/api/apps/demo/github/collaborators') result = { repository: 'eat-org/demo', repositoryId: '100', repoVersion: 1, checkedAt: new Date().toISOString(), canManage: githubApp.members[0].canChangeRole,
      collaborators: [...githubApp.members.filter(m => m.login && !['none','unknown'].includes(m.role)).map(m => ({ githubId: m.isOwner ? '11' : '12', login: m.login, role: m.role, roleError: m.roleError ?? '', direct: true, userId: m.userId, name: m.name, relation: m.isOwner ? 'owner' : 'member' })), ...extraCollaborators] };
    else if (path.startsWith('/api/apps/demo/github/collaborators/') && method === 'PUT') {
      const id = path.split('/').at(-1), member = githubApp.members.find(m => (m.isOwner ? '11' : '12') === id);
      if (member) Object.assign(member, { role: body.role ?? 'none', state: 'succeeded', error: '', roleError: '', roleCheckedAt: new Date().toISOString() });
      else { const index = extraCollaborators.findIndex(m => m.githubId === id); assert(index >= 0); if (body.role === null) extraCollaborators.splice(index, 1); else extraCollaborators[index].role = body.role; }
      result = { ok: true, role: body.role ?? 'none', direct: body.role !== null };
    }
    else if (path.endsWith('/add') || path.endsWith('/role')) {
      const member = githubApp.members.find(m => path.includes(`/members/${m.userId}/`));
      Object.assign(member, { role: body.role, state: 'succeeded', error: '', notification: '', operation: path.endsWith('/add') ? 'grant' : 'role' });
      result = { ok: true };
    }
    else if (path === '/api/apps/demo/github/refresh' || path.endsWith('/retry')) result = { ok: true };
    else if (path === '/api/settings/github') result = settings;
    else if (path === '/api/settings/github/initialize') {
      settings.organization = body.organization;
      result = { url: 'https://github.com/organizations/eat-org/settings/apps/new?state=setup-state',
        manifest: { name: body.name, default_permissions: { members: 'write', administration: 'write' } } };
    }
    else if (path === '/api/settings/github/install') result = { url: 'https://github.com/apps/eat-demo/installations/new?state=install-state' };
    else if (path === '/api/settings/github/enabled') { settings.enabled = body.enabled; result = settings; }
    else if (path === '/api/settings/github/check') {
      if (['uninstalled', 'app_unavailable'].includes(settings.connectionState)) { status = 400; result = { message: settings.connectionError }; }
      else result = { message: '组织、App 权限及仓库覆盖范围检查通过' };
    }
    else if (path === '/api/settings/github/cleanup') result = { grants: [], task: null };
    else { status = 404; result = { message: `未覆盖的请求 ${method} ${path}` }; errors.push(result.message); }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  return { page, context, writes, account, settings, githubApp };
}
async function shot(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true, animations: 'disabled' });
}
try {
  for (const width of [1280, 390]) {
    const f = await fixture(width);
    await f.page.goto(`${base}/account?section=github`);
    await f.page.getByText('邀请待接受', { exact: true }).waitFor();
    await shot(f.page, `account-pending-${width}`);
    await f.page.getByRole('button', { name: '同意邀请', exact: true }).click();
    await f.page.getByText('已加入组织', { exact: true }).waitFor();
    assert(f.writes.some(w => w.path === '/api/account/github/accept'));
    f.account.orgState = 'pending';
    await f.page.goto(`${base}/users`);
    await f.page.getByRole('button', { name: '发送／重新发送邀请', exact: true }).first().click();
    assert(f.writes.some(w => w.path.endsWith('/github') && w.body?.action === 'join'));
    await shot(f.page, `users-${width}`);
    await f.page.goto(`${base}/apps`);
    await f.page.getByText('EAT 组织仓库', { exact: true }).waitFor();
    await f.page.getByRole('link', { name: /demo.*组织演示应用/ }).click();
    await f.page.getByRole('tab', { name: '成员', exact: true }).click();
    await f.page.getByRole('heading', { name: /GitHub 仓库权限/ }).waitFor();
    const owner = f.page.getByRole('region', { name: '@demo-owner 的仓库权限', exact: true });
    const member = f.page.getByRole('region', { name: '应用成员 的应用成员信息', exact: true });
    const repositoryMember = f.page.getByRole('region', { name: '@demo-member 的仓库权限', exact: true });
    const guest = f.page.getByRole('region', { name: '@guest-dev 的仓库权限', exact: true });
    await guest.getByText('非 EAT 成员', { exact: true }).waitFor();
    assert.equal(await owner.locator('select').count(), 0);
    assert.equal(await f.page.getByRole('button', { name: '重试撤权', exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('region', { name: '@reviewer 的仓库权限' }).getByRole('button').count(), 0);
    await shot(f.page, `members-before-${width}`);
    if(width >= 1024) {
      const positions = await f.page.locator('[data-member-status]').evaluateAll(els => els.map(e => e.getBoundingClientRect().left));
      assert(positions.every(x => Math.abs(x - positions[0]) < 1), 'member columns must align');
    }
    await f.page.getByRole('searchbox', { name: '搜索仓库用户' }).fill('guest-dev');
    assert.equal(await owner.count(), 0); await guest.waitFor();
    await f.page.getByRole('searchbox', { name: '搜索仓库用户' }).fill('');
    await f.page.getByRole('button', { name: /^其他 EAT 用户/ }).click();
    await f.page.getByRole('region', { name: '@other-eat 的仓库权限' }).waitFor(); assert.equal(await owner.count(), 0);
    await f.page.getByRole('button', { name: /^全部 / }).click();
    await owner.getByRole('button', { name: '修改角色', exact: true }).click();
    assert.equal(await f.page.locator('#github-collaborator-role').inputValue(), 'maintain');
    assert(await f.page.getByRole('button', { name: '保存角色', exact: true }).isDisabled());
    await shot(f.page, `member-edit-${width}`);
    await f.page.getByRole('button', { name: '取消', exact: true }).click();
    await member.getByRole('button', { name: '添加到仓库', exact: true }).click();
    assert.equal(await f.page.locator('#github-member-role').inputValue(), 'write');
    await shot(f.page, `member-add-${width}`);
    await f.page.getByRole('dialog', { name: '添加到仓库', exact: true }).getByRole('button', { name: '添加到仓库', exact: true }).click();
    await f.page.getByRole('button', { name: '刷新 GitHub 状态', exact: true }).click();
    await repositoryMember.getByText('Write', { exact: true }).waitFor();
    assert(f.writes.some(w => w.path.endsWith(`/members/${memberId}/add`) && w.body.role === 'write'));
    await repositoryMember.getByRole('button', { name: '修改角色', exact: true }).click();
    assert.equal(await f.page.locator('#github-collaborator-role').inputValue(), 'write');
    await f.page.locator('#github-collaborator-role').selectOption('admin');
    await f.page.getByRole('button', { name: '保存角色', exact: true }).click();
    await repositoryMember.getByText('Admin', { exact: true }).waitFor();
    assert(f.writes.some(w => w.path.endsWith('/collaborators/12') && w.body.role === 'admin'));
    await shot(f.page, `members-${width}`);
    const denied = route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: '仓库管理权限已变化' }) });
    await f.page.route('**/api/apps/demo/github/collaborators/12', denied);
    await repositoryMember.getByRole('button', { name: '从仓库移除', exact: true }).click();
    await shot(f.page, `member-remove-${width}`);
    await f.page.getByRole('button', { name: '确认从仓库移除', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: '仓库管理权限已变化' }).waitFor();
    assert.equal(f.githubApp.members[1].role, 'admin');
    await f.page.getByRole('button', { name: '取消', exact: true }).click();
    await repositoryMember.getByRole('button', { name: '从仓库移除', exact: true }).waitFor();
    assert.equal(await f.page.getByText('撤权失败', { exact: true }).count(), 0);
    await f.page.unroute('**/api/apps/demo/github/collaborators/12', denied);
    await repositoryMember.getByRole('button', { name: '从仓库移除', exact: true }).click();
    await f.page.getByRole('button', { name: '确认从仓库移除', exact: true }).click();
    await member.getByRole('button', { name: '添加到仓库', exact: true }).waitFor();
    assert.equal(await repositoryMember.count(), 0);
    await guest.getByRole('button', { name: '从仓库移除', exact: true }).click();
    await f.page.getByRole('button', { name: '确认从仓库移除', exact: true }).click();
    await guest.waitFor({ state: 'detached' });
    const refresh = async () => { await f.page.getByRole('button', { name: '刷新 GitHub 状态', exact: true }).click(); };
    Object.assign(f.githubApp.members[1], { role: 'none', state: 'pending', operation: 'grant' });
    await refresh(); await member.getByRole('button', { name: '添加中…', exact: true }).waitFor();
    assert(await member.getByRole('button', { name: '添加中…' }).isDisabled());
    Object.assign(f.githubApp.members[1], { login: null, state: 'unlinked', role: 'unknown' });
    await refresh(); await member.getByText('未关联 GitHub', { exact: true }).waitFor();
    assert.equal(await member.getByRole('button', { name: '添加到仓库', exact: true }).count(), 0);
    Object.assign(f.githubApp.members[1], { login: 'demo-member', role: 'write', state: 'succeeded', roleError: 'GitHub 暂不可用' });
    await refresh(); await repositoryMember.getByText('GitHub 暂不可用', { exact: true }).waitFor();
    assert(await repositoryMember.getByRole('button', { name: '修改角色', exact: true }).isDisabled());
    await shot(f.page, `member-stale-${width}`);
    Object.assign(f.githubApp.members[1], { role: 'none', roleError: '', state: 'not_requested', canChangeRole: false });
    f.githubApp.members[0].canChangeRole = false;
    await refresh(); await member.getByRole('button', { name: '添加到仓库', exact: true }).click();
    assert.deepEqual(await f.page.locator('#github-member-role option').evaluateAll(options => options.map(o => o.value)), ['write']);
    await f.page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await owner.getByRole('button').count(), 0);
    await f.page.goto(`${base}/settings?section=github`);
    await f.page.getByText('高级设置：手动配置已有 GitHub App', { exact: true }).click();
    await f.page.locator('#github-organization').waitFor();
    await f.page.getByRole('button', { name: '检查已保存的连接' }).click();
    await f.page.getByRole('status').filter({ hasText: '组织、App 权限及仓库覆盖范围检查通过' }).waitFor();
    await f.page.getByRole('button', { name: '保存设置', exact: true }).click();
    assert(f.writes.some(w => w.path === '/api/settings/github' && w.method === 'PUT'));
    await shot(f.page, `settings-${width}`);
    await f.context.close();
    const wizard = await fixture(width);
    Object.assign(wizard.settings, { enabled: false, appId: '', clientId: '', installationId: '', hasClientSecret: false, hasPrivateKey: false, appSlug: null, connectionState: 'unconfigured' });
    await wizard.page.goto(`${base}/settings?section=github`);
    await wizard.page.getByLabel('GitHub 组织名称', { exact: true }).fill('eat-org');
    await wizard.page.getByLabel('GitHub App 名称', { exact: true }).fill('EAT Demo');
    await shot(wizard.page, `setup-initialize-${width}`);
    await wizard.page.getByRole('button', { name: '初始化 GitHub App', exact: true }).click();
    await wizard.page.getByRole('status').filter({ hasText: 'App 已创建' }).waitFor();
    assert.equal(wizard.settings.enabled, false);
    assert(wizard.writes.some(w => w.external && w.method === 'POST'));
    await shot(wizard.page, `setup-created-${width}`);
    await wizard.page.getByRole('button', { name: '安装到组织', exact: true }).click();
    await wizard.page.getByText('组织已连接', { exact: true }).waitFor();
    assert.equal(wizard.settings.installationId, '99'); assert.equal(wizard.settings.enabled, true);
    await shot(wizard.page, `setup-connected-${width}`);
    const appId = wizard.settings.appId;
    Object.assign(wizard.settings, { connectionState: 'uninstalled', connectionError: 'App 已卸载，请重新安装' });
    await wizard.page.goto(`${base}/settings?section=github`);
    await wizard.page.getByText('未安装到组织', { exact: true }).waitFor();
    await shot(wizard.page, `setup-uninstalled-${width}`);
    await wizard.page.getByRole('button', { name: '重新安装到组织', exact: true }).click();
    await wizard.page.getByText('组织已连接', { exact: true }).waitFor();
    assert.equal(wizard.settings.appId, appId, 'reinstallation must reuse the App');
    Object.assign(wizard.settings, { connectionState: 'app_unavailable', connectionError: 'App 不可用或私钥已失效，请检查后再重新初始化' });
    await wizard.page.goto(`${base}/settings?section=github`);
    await wizard.page.getByRole('button', { name: '重新初始化 GitHub App', exact: true }).click();
    await wizard.page.getByRole('alertdialog').waitFor();
    await shot(wizard.page, `setup-reinitialize-${width}`);
    await wizard.page.getByRole('alertdialog').getByRole('button', { name: '继续创建新 App', exact: true }).click();
    await wizard.page.getByRole('status').filter({ hasText: 'App 已创建' }).waitFor();
    assert.notEqual(wizard.settings.appId, appId);
    assert.equal(wizard.account.needsAuthorization, true);
    assert(wizard.writes.some(w => w.path === '/api/settings/github/initialize' && w.body.replaceExisting));
    await wizard.context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`GitHub UI desktop/mobile passed; screenshots: ${shots}`);
} finally { await browser.close(); await new Promise(r => server.close(r)); }
