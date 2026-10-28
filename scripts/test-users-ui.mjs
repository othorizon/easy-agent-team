#!/usr/bin/env node
/** 仅对 notify.spec.ts 建立的本地测试数据库运行；需要已构建并启动的测试服务。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = process.env.EAT_UI_TEST_URL || 'http://127.0.0.1:3087';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), '只允许本机测试服务');
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@notify.test', password: 'password123' }) }).then(r => r.json());
assert.ok(login.token);
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json();
}
let users = await api('GET', '/api/users');
for (let i = 1; i <= 16; i++) {
  const email = `ui-${i}@notify.test`;
  if (!users.some(u => u.email === email)) await api('POST', '/api/users', { name: `预览成员 ${String(i).padStart(2, '0')}`, email, password: 'password123' });
}
users = await api('GET', '/api/users');
const longUser = users.find(u => u.email === 'ui-1@notify.test');
await api('PATCH', `/api/users/${longUser.id}/profile`, { name: '用于检查窄屏布局的非常长的成员名称与很长的用户资料' });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(({ token, user }) => { localStorage.setItem('eat.token', token); localStorage.setItem('eat.user', JSON.stringify(user)); }, login);
    const page = await context.newPage(); const errors = []; const githubRequests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/\/api\/users\/[^/]+\/github$/.test(r.url())) githubRequests.push(r.url()); });
    await page.goto(`${base}/users`);
    await page.getByRole('button', { name: '管理员 的操作', exact: true }).waitFor();
    assert.equal(githubRequests.length, 0, '列表不为每行请求 GitHub 详情');
    assert.equal(await page.locator('tbody tr').count(), 20);
    assert.equal(await page.getByRole('button', { name: '编辑资料', exact: true }).count(), 0);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 2);
    await page.getByRole('textbox', { name: '搜索用户' }).fill('ready@notify.test');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('button', { name: '已配置 的操作', exact: true }).click();
    await page.getByRole('menuitem', { name: 'GitHub 详情' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByText('@ready-github', { exact: true }).last().waitFor();
    assert.equal(githubRequests.length, 1);
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: '搜索用户' }).fill('admin@notify.test');
    await page.getByRole('button', { name: '管理员 的操作', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: '重置密码' }).count(), 0);
    await page.getByRole('menuitem', { name: '权限设置' }).click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByRole('combobox', { name: '角色', exact: true }).isDisabled(), true);
    const toggle = dialog.getByRole('switch', { name: '允许发送全员通知' });
    const previous = await toggle.getAttribute('aria-checked'); await toggle.click();
    const saved = page.waitForResponse(r => r.url().endsWith(`/api/users/${login.user.id}`) && r.request().method() === 'PATCH');
    await dialog.getByRole('button', { name: '保存权限' }).click(); assert.equal((await saved).status(), 200);
    await dialog.waitFor({ state: 'hidden' });
    const updated = (await api('GET', '/api/users')).find(u => u.id === login.user.id);
    assert.equal(updated.canNotifyAll, previous !== 'true');
    await page.getByRole('textbox', { name: '搜索用户' }).fill('');
    await page.getByRole('combobox', { name: '账号状态' }).click();
    await page.getByRole('option', { name: '已禁用', exact: true }).click();
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('button', { name: '禁用用户 的操作' }).click();
    await page.getByRole('menuitem', { name: '启用账号' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    assert.equal((await api('GET', '/api/users')).find(u => u.email === 'disabled@notify.test').status, 'disabled');
    await page.getByRole('combobox', { name: '账号状态' }).click();
    await page.getByRole('option', { name: '全部状态', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '页面不能横向溢出');
    const actionBox = await page.getByRole('button', { name: '管理员 的操作', exact: true }).boundingBox();
    assert.ok(actionBox && actionBox.x + actionBox.width <= width, '窄屏操作按钮应直接可见，无需横向滚动');
    const maxHeight = await page.locator('tbody tr').evaluateAll(rows => Math.max(...rows.map(row => row.getBoundingClientRect().height)));
    assert.ok(maxHeight <= 80, `行高过大：${maxHeight}`);
    await page.screenshot({ path: `/tmp/eat-users-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Users UI passed: desktop/mobile, compact rows, pagination/search, permission save, lazy GitHub, self protection and cancel.');
} finally { await browser.close(); }
