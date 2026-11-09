#!/usr/bin/env node
/** Built UI smoke test: all API traffic stays in schema-validated local fixtures. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import {
  createAliyunConnectionSchema,
  updateAliyunConnectionSchema,
  aliyunConnectionInfoSchema,
  aliyunPermissionsSchema,
  aliyunConnectionStatusSchema,
} from '../packages/shared/dist/index.js';

const dist = resolve('apps/web/dist'),
  screenshots = join(tmpdir(), 'eat-aliyun-ui');
mkdirSync(screenshots, { recursive: true });
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path.startsWith('/assets/')
    ? join(dist, path)
    : join(dist, 'index.html');
  if (!file.startsWith(dist) || !existsSync(file))
    return res.writeHead(404).end();
  res.setHeader(
    'content-type',
    file.endsWith('.js')
      ? 'application/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/html',
  );
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const cdp =
  process.env.BROWSER_CDP_URL ??
  execFileSync(
    'agent-browser',
    ['--session', 'eat-ticket10', 'get', 'cdp-url'],
    { encoding: 'utf8' },
  ).trim();
const browser = await chromium.connectOverCDP(cdp);
const me = {
  id: randomUUID(),
  name: '测试管理员',
  email: 'admin@example.com',
  role: 'admin',
};
let connections = [],
  permissions = [],
  refreshCalls = 0,
  saves = 0,
  failRefresh = false,
  adminRequests = 0;
const runtimeErrors = [];
async function context(user, viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((user) => {
    localStorage.setItem('eat.token', 'test');
    localStorage.setItem('eat.user', JSON.stringify(user));
  }, user);
  await ctx.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    if (url.origin !== base) return route.abort();
    if (!path.startsWith('/api/')) return route.continue();
    const body = req.postDataJSON();
    const reply = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
      });
    if (path === '/api/account/onboarding') return reply({ required: false });
    if (path === '/api/requests') return reply({ items: [], pendingCount: 0 });
    if (path === '/api/aliyun/status')
      return reply({ available: connections.length > 0 });
    adminRequests++;
    assert.equal(
      user.role,
      'admin',
      `Member must not query management: ${path}`,
    );
    if (path === '/api/aliyun/connections' && method === 'GET')
      return reply(connections);
    if (path === '/api/aliyun/connections' && method === 'POST') {
      const v = createAliyunConnectionSchema.parse(body);
      saves++;
      const c = aliyunConnectionInfoSchema.parse({
        id: randomUUID(),
        name: v.name,
        accountId: 'account-ui-test',
        defaultRegion: v.defaultRegion,
        status: 'enabled',
        accessKeyIdMasked: '********',
        accessKeySecretMasked: '********',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      connections.push(c);
      return reply(c, 201);
    }
    if (path === '/api/aliyun/permissions/manage') return reply(permissions);
    const match = path.match(
      /^\/api\/aliyun\/connections\/([^/]+)(?:\/(status|validate|refresh))?$/,
    );
    if (match) {
      const c = connections.find((c) => c.id === match[1]);
      assert.ok(c);
      if (method === 'PATCH') {
        const v = updateAliyunConnectionSchema.parse(body);
        c.name = v.name;
        c.defaultRegion = v.defaultRegion;
        return reply(c);
      }
      if (method === 'DELETE') {
        connections = connections.filter((r) => r.id !== c.id);
        permissions = [];
        return reply({ ok: true });
      }
      if (match[2] === 'status') {
        c.status = aliyunConnectionStatusSchema.parse(body).status;
        return reply(c);
      }
      if (match[2] === 'validate') return reply({ accountId: c.accountId });
      if (match[2] === 'refresh') {
        refreshCalls++;
        if (failRefresh) {
          failRefresh = false;
          return reply({ message: '模拟 RAM 失败，请重试' }, 503);
        }
        permissions = aliyunPermissionsSchema.parse([
          {
            id: permissions[0]?.id ?? randomUUID(),
            connectionId: c.id,
            policyName: 'eat-perm-read-data',
            description: refreshCalls === 1 ? '初次发现' : 'RAM 说明已更新',
            cloudExists: refreshCalls < 3,
            open: false,
            purpose: '',
            dataScope: '',
            ownerId: null,
            discoveredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]);
        return reply(permissions);
      }
    }
    throw new Error(`Unexpected local fixture request: ${method} ${path}`);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => runtimeErrors.push(e.message));
  return { ctx, page };
}
async function noOverflow(page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
}
try {
  const { ctx, page } = await context(me, { width: 1440, height: 1000 });
  await page.goto(`${base}/settings?section=aliyun`);
  await page.getByRole('button', { name: '新建接入' }).click();
  assert.equal(
    await page.getByRole('link', { name: '阿里云权限', exact: true }).count(),
    0,
  );
  await page.getByRole('textbox', { name: '接入名称' }).fill('Invalid_Name');
  await page.getByRole('button', { name: '校验并保存' }).click();
  await page.getByText('接入名称只允许小写字母、数字和连字符').waitFor();
  assert.equal(saves, 0);
  await page.getByRole('textbox', { name: '接入名称' }).fill('team-cloud');
  await page.getByLabel('管理 AccessKey ID', { exact: true }).fill('test-ak');
  await page
    .getByLabel('管理 AccessKey Secret', { exact: true })
    .fill('test-sk');
  await page.getByRole('button', { name: '校验并保存' }).click();
  await page.getByRole('link', { name: '阿里云权限', exact: true }).waitFor();
  assert.equal(saves, 1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByText('已暂停', { exact: true }).waitFor();
  await page.getByRole('link', { name: '目录管理', exact: true }).click();
  await page.getByText('初次发现', { exact: true }).waitFor();
  assert.equal(
    refreshCalls,
    1,
    'Opening management automatically refreshes once',
  );
  await page.getByRole('button', { name: '刷新目录' }).click();
  await page.getByText('RAM 说明已更新', { exact: true }).waitFor();
  assert.equal(refreshCalls, 2);
  await page.getByRole('button', { name: '刷新目录' }).click();
  await page.getByText('云端已删除', { exact: true }).waitFor();
  assert.equal(refreshCalls, 3, 'Manual refresh can be repeated');
  failRefresh = true;
  await page.getByRole('button', { name: '刷新目录' }).click();
  await page.getByRole('alert').filter({ hasText: '模拟 RAM 失败' }).waitFor();
  await page.getByRole('button', { name: '刷新目录' }).click();
  await page
    .getByRole('button', { name: '刷新目录' })
    .waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
  await noOverflow(page);
  await page.screenshot({
    path: join(screenshots, 'desktop-manage.png'),
    fullPage: true,
  });
  await page.goto(`${base}/settings?section=aliyun`);
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByText('已启用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '接入名称' }).fill('renamed-cloud');
  assert.equal(
    await page
      .getByLabel('管理 AccessKey Secret', { exact: true })
      .inputValue(),
    '',
  );
  await page.getByRole('button', { name: '校验并保存' }).click();
  await page.getByText('renamed-cloud', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({
    path: join(screenshots, 'mobile-settings.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await noOverflow(page);
  await page.screenshot({
    path: join(screenshots, 'mobile-editor.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('link', { name: '目录管理', exact: true }).click();
  await page.getByText('云端已删除', { exact: true }).waitFor();
  await noOverflow(page);
  await page.screenshot({
    path: join(screenshots, 'mobile-manage.png'),
    fullPage: true,
  });
  const beforeMember = adminRequests;
  const member = await context(
    { ...me, role: 'member' },
    { width: 390, height: 844 },
  );
  await member.page.goto(`${base}/aliyun?tab=manage`);
  await member.page.getByRole('tab', { name: '目录', exact: true }).waitFor();
  assert.equal(
    await member.page.getByRole('tab', { name: '管理', exact: true }).count(),
    0,
  );
  assert.equal(adminRequests, beforeMember);
  await member.ctx.close();
  await page.goto(`${base}/settings?section=aliyun`);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page
    .getByText('暂无接入，添加云账号后即可发现权限点。', { exact: true })
    .waitFor();
  assert.equal(await page.locator('a[href="/aliyun"]').count(), 0);
  await ctx.close();
  assert.deepEqual(runtimeErrors, []);
  console.log(
    JSON.stringify({
      passed: true,
      viewports: ['1440x1000', '390x844'],
      refreshCalls,
      screenshots,
    }),
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
