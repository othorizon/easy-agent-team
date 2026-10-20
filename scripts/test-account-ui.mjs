#!/usr/bin/env node
// 使用真实构建页面与本地 API fixture 验证表单、跳转和响应式布局；服务端规则由 account.spec.ts 覆盖。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { updateAccountSchema, notificationPreferencesSchema, registrationSettingsSchema, updateBioSchema, sendWebhookCodeSchema } from '../packages/shared/dist/index.js';

const dist = resolve('apps/web/dist');
const shots = join(tmpdir(), 'eat-account-ui');
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
  const notification = { webhookUrl: '', hasWebhookSecret: false, verified: false, notifyHelp: true, notifyReply: true, notifyMention: true };
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
      Object.assign(notification, notificationPreferencesSchema.parse(body)); result = notification;
    } else if (path === '/api/admin/registration-settings') {
      if (method === 'PUT') Object.assign(settings, registrationSettingsSchema.parse(body));
      result = settings;
    } else if (path === '/api/users') result = [{ ...user, status: 'active' }];
    else if (path.endsWith('/bio')) { user.bio = updateBioSchema.parse(body).bio; result = { id: user.id, bio: user.bio }; }
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
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
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
    await verify(f.page);
    await f.page.getByText('已验证', { exact: true }).waitFor();
    await f.page.getByRole('switch', { name: '接收 Folio 评论 @ 通知', exact: true }).click();
    await f.page.getByRole('button', { name: '保存通知偏好' }).click();
    await f.page.getByText('通知偏好已保存', { exact: true }).waitFor();
    assert.equal(f.notification.notifyMention, false);
    await screenshot(f.page, `account-${width}`);
    await f.page.locator('#old-password').fill('oldpassword');
    await f.page.locator('#new-password').fill('newpassword123');
    await f.page.locator('#confirm-password').fill('different123');
    await f.page.getByRole('button', { name: '修改密码', exact: true }).click();
    await f.page.getByText('两次输入的新密码不一致', { exact: true }).waitFor();
    assert.equal(f.writes.filter((r) => r.path.endsWith('/password')).length, 0);
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
  await admin.page.getByRole('button', { name: '编辑简介' }).click();
  await admin.page.locator('#admin-user-bio').fill('管理员可编辑本人简介');
  await admin.page.getByRole('button', { name: '保存简介' }).click();
  await admin.page.getByText('个人简介已更新', { exact: true }).waitFor();
  assert.equal(admin.user.bio, '管理员可编辑本人简介');
  await admin.context.close();
  assert.deepEqual(errors, []);
  console.log(`用户中心、三个强制补全组合、管理员豁免及编辑、表单校验和桌面/移动布局检查通过。截图：${shots}`);
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
