#!/usr/bin/env node
// 使用真实构建页面与本地 API fixture 验证表单、跳转和响应式布局；服务端规则由 account.spec.ts 覆盖。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { updateAccountSchema, notificationPreferencesSchema, patchNotificationPreferencesSchema, registrationSettingsSchema, updateUserProfileSchema, sendWebhookCodeSchema } from '../packages/shared/dist/index.js';

const dist = resolve('apps/web/dist');
const shots = process.env.EAT_UI_SHOTS || '/workspace/artifacts/eat-account-notifications';
mkdirSync(shots, { recursive: true });
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path.startsWith('/assets/') ? join(dist, path) : join(dist, 'index.html');
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const errors = [];

async function fixture({ requireBio = false, requireNotification = false, role = 'member', width = 1280, bio = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 950 } });
  const user = { id: '00000000-0000-4000-8000-000000000001', name: '测试用户', email: 'member@test.dev', role, bio, allowHelp: true };
  const notification = { webhookUrl: '', hasWebhookSecret: false, verified: false, notifyHelp: true, notifyReply: true, notifyMention: true, notifyApprovalRequest: true, notifyApprovalResult: true };
  const settings = { enabled: true, allowedEmailSuffixes: [], requireBio, requireNotification };
  const writes = [];
  let sentUrl = '';
  const onboarding = () => ({
    requireBio: role !== 'admin' && settings.requireBio,
    requireNotification: role !== 'admin' && settings.requireNotification,
    bioComplete: !!user.bio.trim(), notificationComplete: notification.verified,
    required: role !== 'admin' && ((settings.requireBio && !user.bio.trim()) || (settings.requireNotification && !notification.verified)),
  });
  await context.addInitScript((user) => { localStorage.setItem('eat.token', 'test-token'); localStorage.setItem('eat.user', JSON.stringify(user)); }, user);
  await context.route('**/api/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    let result = {}, status = 200;
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/api/account/onboarding') result = onboarding();
    else if (path === '/api/account') {
      if (method === 'PATCH') Object.assign(user, updateAccountSchema.parse(body));
      result = { ...user, notification, onboarding: onboarding() };
    } else if (path === '/api/account/notification/code') {
      sentUrl = sendWebhookCodeSchema.parse(body).webhookUrl;
      result = { challengeId: '00000000-0000-4000-8000-000000000002', retryAfter: 60, expiresIn: 600 };
    } else if (path === '/api/account/notification/verify') {
      if (body.code !== '123456') { status = 400; result = { error: 'VERIFICATION_FAILED', message: '验证码不正确' }; }
      else { notification.webhookUrl = sentUrl; notification.verified = true; result = notification; }
    } else if (path === '/api/account/notification/preferences') {
      Object.assign(notification, (method === 'PATCH' ? patchNotificationPreferencesSchema : notificationPreferencesSchema).parse(body)); result = notification;
    } else if (path === '/api/admin/registration-settings') {
      if (method === 'PUT') Object.assign(settings, registrationSettingsSchema.parse(body));
      result = settings;
    } else if (path === '/api/account/github' || /^\/api\/users\/[^/]+\/github$/.test(path)) result = { enabled: false, organization: '', linked: false, login: null, needsAuthorization: false, orgState: 'unknown', orgRole: null, checkedAt: null, error: '', task: null };
    else if (path === '/api/requests') result = { items: [], total: 0, pendingCount: 0, page: 1, pageSize: 20 };
    else if (path === '/api/users') result = [{ ...user, status: 'active' }];
    else if (path.endsWith('/profile')) { Object.assign(user, updateUserProfileSchema.parse(body)); result = { id: user.id, name: user.name, bio: user.bio }; }
    else if (path === '/api/helpers') result = { helpers: [], skillAuthors: [] };
    else if (path.includes('/help-requests/') && path.endsWith('/page')) result = { items: [], total: 0, page: 1, pageSize: 20, counts: { all: 0, pending: 0, attention: 0 } };
    else if (path === '/api/auth/registration') result = settings;
    else { status = 404; result = { message: `未覆盖的测试请求 ${path}` }; errors.push(result.message); }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  return { page, context, user, notification, settings, writes };
}
const screenshot = async (page, name) => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 不应出现横向溢出`);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true, animations: 'disabled' });
};
async function verify(page) {
  await page.locator('#notification-url').fill('https://open.feishu.cn/open-apis/bot/v2/hook/ui-test');
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await page.locator('#notification-code').fill('000000');
  await page.getByRole('button', { name: '验证并启用' }).click();
  await page.getByText('验证码不正确', { exact: true }).waitFor();
  await page.locator('#notification-code').fill('123456');
  await page.getByRole('button', { name: '验证并启用' }).click();
}
try {
  for (const width of [1280, 390]) {
    const f = await fixture({ width });
    await f.page.goto(`${base}/account`);
    await f.page.locator('#account-bio').fill('我负责支付对账与数据分析');
    await f.page.locator('#account-name').fill('新姓名');
    await f.page.getByRole('button', { name: '保存个人资料' }).click();
    await f.page.getByText('个人资料已保存', { exact: true }).waitFor();
    assert.equal(f.user.name, '新姓名');
    await screenshot(f.page, `profile-${width}`);
    const section = async (label, id) => {
      if (width >= 900) await f.page.getByRole('navigation', { name: '个人中心分类' }).getByRole('link', { name: label }).click();
      else { await f.page.locator('#account-category').click(); await f.page.getByRole('option', { name: label, exact: true }).click(); }
      await f.page.locator(`[data-account-panel=${id}]:not([hidden])`).waitFor();
    };
    await f.page.locator('#account-name').fill('尚未保存的姓名');
    await section('通知设置', 'notifications');
    await section('个人资料', 'profile');
    assert.equal(await f.page.locator('#account-name').inputValue(), '尚未保存的姓名');
    await f.page.locator('#account-name').fill(f.user.name);
    await section('通知设置', 'notifications');
    assert.equal(await f.page.getByRole('switch', { name: '待我审批的申请', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await f.page.getByRole('switch', { name: '我的申请处理结果', exact: true }).getAttribute('aria-checked'), 'true');
    await screenshot(f.page, `notifications-unbound-${width}`);
    await verify(f.page);
    await f.page.getByText('飞书已连接', { exact: true }).waitFor();
    await screenshot(f.page, `notifications-default-${width}`);
    await f.page.getByRole('switch', { name: 'Folio 评论提及', exact: true }).click();
    await f.page.getByRole('switch', { name: '待我审批的申请', exact: true }).click();
    await f.page.getByRole('switch', { name: '我的申请处理结果', exact: true }).click();
    await f.page.getByRole('button', { name: '保存通知偏好' }).click();
    await f.page.getByText('通知偏好已保存', { exact: true }).waitFor();
    assert.equal(f.notification.notifyMention, false);
    assert.equal(f.notification.notifyApprovalRequest, false);
    assert.equal(f.notification.notifyApprovalResult, false);
    await f.page.reload();
    await f.page.getByText('飞书已连接', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('switch', { name: '待我审批的申请', exact: true }).getAttribute('aria-checked'), 'false');
    await screenshot(f.page, `notifications-${width}`);
    await section('GitHub 账户', 'github');
    await screenshot(f.page, `github-${width}`);
    await section('账户安全', 'security');
    await screenshot(f.page, `security-${width}`);
    await f.page.locator('#old-password').fill('oldpassword');
    await f.page.locator('#new-password').fill('newpassword123');
    await f.page.locator('#confirm-password').fill('different123');
    await f.page.getByRole('button', { name: '修改密码', exact: true }).click();
    await f.page.getByText('两次输入的新密码不一致', { exact: true }).waitFor();
    assert.equal(f.writes.filter((r) => r.path.endsWith('/password')).length, 0);
    await f.page.goto(`${base}/account?github=linked`);
    await f.page.locator('[data-account-panel=github]:not([hidden])').waitFor();
    await f.context.close();
  }
  for (const [requireBio, requireNotification] of [[true, false], [false, true], [true, true]]) {
    const f = await fixture({ requireBio, requireNotification, width: 390 });
    await f.page.goto(`${base}/help`);
    await f.page.waitForURL('**/complete-profile?next=*');
    await f.page.getByRole('heading', { name: '完善个人资料' }).waitFor();
    assert.equal(await f.page.locator('#account-bio').count(), requireBio ? 1 : 0);
    assert.equal(await f.page.locator('#notification-url').count(), requireNotification ? 1 : 0);
    await screenshot(f.page, `completion-${requireBio}-${requireNotification}`);
    if (requireBio) {
      await f.page.locator('#account-bio').fill('负责财务数据分析');
      await f.page.getByRole('button', { name: '保存个人简介' }).click();
      if (requireNotification) await f.page.getByText('已完成', { exact: true }).waitFor();
    }
    if (requireNotification) await verify(f.page);
    await f.page.waitForURL(`${base}/help`);
    await f.page.getByRole('heading', { name: '求助', exact: true }).waitFor();
    assert.equal(await f.page.getByText('可求助登记', { exact: true }).count(), 0);
    await f.context.close();
  }
  for (const width of [1280, 390]) {
    const f = await fixture({ width, bio: '负责数据分析' });
    f.notification.notifyMention = false;
    f.notification.notifyHelp = false;
    await f.page.goto(`${base}/help?tab=mine&status=all`);
    await f.page.getByRole('button', { name: '求助设置', exact: true }).click();
    const allow = f.page.getByRole('switch', { name: '接受他人求助', exact: true });
    const reply = f.page.getByRole('switch', { name: '接收回复通知', exact: true });
    await allow.click();
    await f.page.getByText('求助偏好已保存', { exact: true }).waitFor();
    await reply.click();
    await f.page.getByText('回复通知偏好已保存', { exact: true }).waitFor();
    assert.equal(f.user.allowHelp, false);
    assert.equal(f.user.bio, '负责数据分析');
    assert.equal(f.notification.notifyReply, false);
    assert.equal(f.notification.notifyMention, false);
    assert.equal(f.notification.notifyHelp, false);
    assert.equal(f.page.url(), `${base}/help?tab=mine&status=all`);
    await f.page.locator('#help-allow[aria-checked="false"]').waitFor();
    await f.page.locator('#help-reply[aria-checked="false"]').waitFor();
    await screenshot(f.page, `help-settings-${width}`);
    await f.page.getByRole('button', { name: '完成', exact: true }).click();
    await f.page.getByRole('button', { name: '求助设置', exact: true }).click();
    assert.equal(await allow.getAttribute('aria-checked'), 'false');
    assert.equal(await reply.getAttribute('aria-checked'), 'false');
    // 请求失败时保持已保存值，不把失败的切换显示成成功。
    await f.page.route('**/api/account/notification/preferences', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ message: '测试保存失败' }),
    }));
    await reply.click();
    await f.page.getByText('测试保存失败', { exact: true }).waitFor();
    assert.equal(await reply.getAttribute('aria-checked'), 'false');
    await f.context.close();
  }
  const admin = await fixture({ role: 'admin', requireBio: true, requireNotification: true });
  await admin.page.goto(`${base}/settings?section=registration`);
  await admin.page.getByRole('switch', { name: '强制填写个人简介', exact: true }).waitFor();
  assert.equal(new URL(admin.page.url()).pathname, '/settings');
  await admin.page.getByRole('switch', { name: '强制填写个人简介', exact: true }).click();
  await admin.page.getByRole('button', { name: '保存设置', exact: true }).click();
  await admin.page.getByText('注册与登录设置已保存', { exact: true }).waitFor();
  assert.equal(admin.settings.requireBio, false); assert.equal(admin.settings.requireNotification, true);
  await screenshot(admin.page, 'registration-desktop');
  await admin.page.goto(`${base}/users`);
  await admin.page.getByRole('button', { name: '编辑资料' }).click();
  await admin.page.locator('#admin-user-name').fill('管理员修改姓名');
  await admin.page.locator('#admin-user-bio').fill('管理员可编辑本人简介');
  await screenshot(admin.page, 'admin-edit-profile');
  await admin.page.getByRole('button', { name: '保存资料' }).click();
  await admin.page.getByText('用户资料已更新', { exact: true }).waitFor();
  assert.equal(admin.user.name, '管理员修改姓名');
  assert.equal(admin.user.bio, '管理员可编辑本人简介');
  assert.equal(await admin.page.evaluate(() => JSON.parse(localStorage.getItem('eat.user')).name), '管理员修改姓名');
  await admin.context.close();
  assert.deepEqual(errors, []);
  console.log(`用户中心、三个强制补全组合、管理员姓名与简介编辑、求助设置保存及失败恢复、表单校验和桌面/移动布局检查通过。截图：${shots}`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
