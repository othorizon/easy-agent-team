#!/usr/bin/env node
// 用户目录契约回归：普通 Owner 的目录没有 status，管理员仍须过滤禁用账号。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const dist = resolve('apps/web/dist');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path.startsWith('/assets/') ? join(dist, path) : join(dist, 'index.html');
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(readFileSync(file));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  for (const role of ['member', 'admin']) {
    const user = { id: 'owner', name: '配置作者', email: 'owner@test.dev', role };
    const candidate = { id: 'candidate', name: '可选成员', email: 'candidate@test.dev', role: 'member', bio: '', canNotifyAll: false, notificationReady: false };
    const people = role === 'member' ? [candidate] : [{ ...candidate, status: 'active' }, { ...candidate, id: 'disabled', name: '禁用成员', status: 'disabled' }];
    const context = await browser.newContext();
    await context.addInitScript(user => { localStorage.setItem('eat.token', 'fixture'); localStorage.setItem('eat.user', JSON.stringify(user)); }, user);
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      let result = [];
      if (path === '/api/users') result = people;
      else if (path === '/api/account/onboarding') result = { required: false };
      else if (path === '/api/mcp-configs') result = [{ id: 'config', slug: 'demo', name: '测试 MCP', description: '', ownerId: user.id, ownerName: user.name, transport: 'stdio', visibility: 'team', subscriptionStatus: 'none' }];
      else if (path === '/api/skills/demo') result = { id: 'skill', slug: 'demo', name: '测试 Skill', ownerId: user.id, ownerName: user.name, visibility: 'team', files: [], content: '# Test', currentVersion: 1, subscriberCount: 0 };
      if (req.method() === 'POST') writes.push({ path, body: req.postDataJSON() });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    });
    for (const kind of role === 'admin' ? ['mcp-configs', 'skills'] : ['mcp-configs']) {
      await page.goto(`${base}/${kind}${kind === 'skills' ? '/demo' : ''}`);
      await page.getByRole('button', { name: kind === 'skills' ? '添加订阅者' : '订阅者', exact: true }).click();
      await page.getByRole('dialog').getByRole('combobox').click();
      await page.getByRole('option', { name: /可选成员/ }).waitFor();
      assert.equal(await page.getByRole('option', { name: /禁用成员/ }).count(), 0);
      await page.getByRole('option', { name: /可选成员/ }).click();
      const saved = page.waitForResponse(r => r.url().endsWith(`/api/${kind}/demo/subscribers`) && r.request().method() === 'POST');
      await page.getByRole('dialog').getByRole('button', { name: kind === 'skills' ? '添加' : '分配', exact: true }).click();
      assert.equal((await saved).status(), 200);
      assert.deepEqual(writes.at(-1), { path: `/api/${kind}/demo/subscribers`, body: { userId: candidate.id } });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('User directory UI passed: member MCP owner without status, admin MCP/Skill assignment and disabled-account filtering.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
