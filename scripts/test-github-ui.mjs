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
    members: [{ userId: user.id, name: user.name, login: 'demo-owner', orgState: 'active', role: 'maintain', state: 'succeeded', error: '', notification: '', canGrant: true, canChangeRole: true },
      { userId: memberId, name: '应用成员', login: 'demo-member', orgState: 'active', role: 'none', state: 'failed', error: '仓库授权暂未完成', notification: '已通知管理员', canGrant: true, canChangeRole: true }] };
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
    else if (path === '/api/users') result = [user, { ...user, id: memberId, name: '应用成员', role: 'member' }];
    else if (/^\/api\/users\/[^/]+\/github$/.test(path)) result = method === 'GET' ? account : { ok: true };
    else if (path === '/api/apps') result = [appInfo];
    else if (path === '/api/apps/demo/github') result = githubApp;
    else if (path === '/api/apps/demo/github/refresh' || path.endsWith('/retry') || path.endsWith('/role')) result = { ok: true };
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
  return { page, context, writes, account, settings };
}
async function shot(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true, animations: 'disabled' });
}
try {
  for (const width of [1280, 390]) {
    const f = await fixture(width);
    await f.page.goto(`${base}/account`);
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
    await f.page.getByRole('button', { name: /demo.*组织演示应用/ }).click();
    await f.page.getByRole('heading', { name: '成员的 GitHub 仓库权限' }).waitFor();
    await f.page.getByRole('button', { name: '授予 Write／重试', exact: true }).last().click();
    assert(f.writes.some(w => w.path.endsWith(`/members/${memberId}/retry`)));
    await f.page.getByLabel('选择 应用成员 的仓库角色').selectOption('admin');
    await f.page.getByRole('button', { name: '修改角色', exact: true }).last().click();
    await f.page.getByRole('alertdialog').getByRole('button', { name: '修改角色', exact: true }).click();
    assert(f.writes.some(w => w.path.endsWith(`/members/${memberId}/role`) && w.body.role === 'admin'));
    await f.page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    await shot(f.page, `members-${width}`);
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
