#!/usr/bin/env node
/** Browser acceptance against the built UI and schema-validated local fixtures. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import {
  updateOssSettingsSchema,
  requestOssSpaceSchema,
  updateOssSpaceSchema,
  ossPublicReadSchema,
} from '../packages/shared/dist/index.js';
const dist = resolve('apps/web/dist'),
  screenshots = join(tmpdir(), 'eat-oss-ui');
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
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--disable-gpu'],
});
const me = {
  id: randomUUID(),
  name: '测试管理员',
  email: 'admin@example.com',
  role: 'admin',
};
let settings = {
  configured: false,
  status: 'disabled',
  bucket: '',
  region: 'cn-beijing',
  accessKeyIdMasked: '',
  hasSecret: false,
  customDomainsEnabled: false,
  domains: [],
  locationLocked: false,
  checks: [],
  lastError: null,
};
const spaces = [];
let credentialsRead = 0,
  rotate = 0,
  failList = false,
  failSave = false;
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await ctx.addInitScript((me) => {
  localStorage.setItem('eat.token', 'test');
  localStorage.setItem('eat.user', JSON.stringify(me));
}, me);
await ctx.route('**/api/**', async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname,
    method = req.method(),
    body = req.postDataJSON();
  const reply = (data, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  if (path === '/api/admin/oss-settings') {
    if (method === 'PUT') {
      if (failSave) {
        failSave = false;
        return reply({ message: '模拟保存失败，请重试' }, 409);
      }
      const v = updateOssSettingsSchema.parse(body);
      settings = {
        ...settings,
        ...v,
        accessKeyId: undefined,
        accessKeySecret: undefined,
        configured: true,
        hasSecret: true,
        accessKeyIdMasked: 'test****test',
      };
    }
    return reply(settings);
  }
  if (path === '/api/admin/oss-settings/domains')
    return reply([
      { domain: 'assets.example.com', status: 'Enabled' },
      { domain: 'cdn.example.com', status: 'Enabled' },
    ]);
  if (path === '/api/admin/oss-settings/enable') {
    settings.status = 'enabled';
    settings.locationLocked = true;
    settings.checks = [{ name: '目录隔离与清理', status: 'passed' }];
    return reply(settings);
  }
  if (path === '/api/admin/oss-settings/disable') {
    settings.status = 'disabled';
    return reply(settings);
  }
  if (path === '/api/oss/capability')
    return reply({
      enabled: settings.status === 'enabled',
      status: settings.status,
      bucket: settings.bucket,
    });
  if (path === '/api/oss/spaces') {
    if (method === 'POST') {
      const v = requestOssSpaceSchema.parse(body),
        id = randomUUID(),
        prefix = `eat-storage/${randomUUID()}/${me.id}/${id}/`;
      const s = {
        ...v,
        id,
        ownerId: me.id,
        ownerName: me.name,
        status: 'pending',
        prefix,
        bucket: settings.bucket,
        region: settings.region,
        endpoint: 'https://oss-cn-beijing.aliyuncs.com',
        addresses: [
          {
            domain: 'test-bucket.oss-cn-beijing.aliyuncs.com',
            url: `https://test-bucket.oss-cn-beijing.aliyuncs.com/${prefix}`,
            kind: 'official',
            cdn: false,
            source: 'oss',
          },
          ...settings.domains.map((d) => ({
            ...d,
            kind: 'custom',
            source: 'admin',
            url: `https://${d.domain}/${prefix}`,
          })),
        ],
        publicRead: false,
        requestedPublicRead: false,
        publicPrefixes: [],
        operationPending: false,
        lastError: null,
        rejectionReason: null,
        decidedByName: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      spaces.push(s);
      return reply(s, 201);
    }
    if (failList) return reply({ message: '模拟读取失败' }, 503);
    return reply(spaces);
  }
  const match = path.match(/^\/api\/oss\/spaces\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const s = spaces.find((s) => s.id === match[1]);
    if (!s) return reply({ message: '空间不存在' }, 404);
    if (method === 'PATCH') Object.assign(s, updateOssSpaceSchema.parse(body));
    if (match[2] === 'approve') s.status = 'active';
    if (match[2] === 'revoke') {
      s.status = 'revoked';
      s.publicRead = false;
      s.publicPrefixes = [];
    }
    if (match[2] === 'reject') {
      s.status = 'rejected';
      s.rejectionReason = body.reason;
    }
    if (match[2] === 'public-read') {
      const { enabled } = ossPublicReadSchema.parse(body);
      s.publicRead = s.requestedPublicRead = enabled;
      s.publicPrefixes = enabled ? [s.prefix] : [];
    }
    return reply(s);
  }
  if (path === '/api/oss/me/account')
    return reply({
      configured: true,
      accessKeyIdMasked: 'test****key',
      syncPending: false,
      lastError: null,
    });
  if (path === '/api/oss/me/credentials/reset') {
    rotate++;
    return reply({ id: randomUUID(), state: 'complete', lastError: null });
  }
  if (path.startsWith('/api/oss/operations/'))
    return reply({
      id: path.split('/').pop(),
      state: 'complete',
      lastError: null,
    });
  if (path === '/api/oss/me/credentials') {
    credentialsRead++;
    return reply({
      accessKeyId: 'fake-fixture-key',
      accessKeySecret: 'fake-fixture-secret',
      scope: 'all-approved-spaces',
      bucket: settings.bucket,
      region: settings.region,
      endpoint: '',
      prefixes: spaces.map((s) => s.prefix),
    });
  }
  if (path === '/api/auth/whoami') return reply(me);
  return reply([]);
});
const page = await ctx.newPage(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const button = (name) => page.getByRole('button', { name, exact: true });
async function noOverflow() {
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    'Unexpected horizontal overflow',
  );
}
try {
  await page.goto(base + '/oss');
  await page.getByText('还没有存储空间，启用后可提交申请。').waitFor();
  assert(await button('申请空间').isDisabled());
  await page.goto(base + '/settings?section=oss');
  await page.getByLabel('Bucket', { exact: true }).fill('test-bucket');
  await page.getByLabel('AccessKey ID', { exact: true }).fill('fake-manager');
  await page
    .getByLabel('AccessKey Secret', { exact: true })
    .fill('fake-manager-secret');
  failSave = true;
  await button('保存更改').click();
  await page.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
  await button('保存更改').click();
  await page.getByText('更改已保存').waitFor();
  assert.equal(
    await page.getByLabel('AccessKey Secret', { exact: true }).inputValue(),
    '',
  );
  await button('读取已绑定域名').click();
  await page.getByLabel('assets.example.com', { exact: true }).check();
  await page.getByLabel('cdn.example.com', { exact: true }).check();
  await page
    .getByRole('switch', { name: 'cdn.example.com 已启用 CDN' })
    .click();
  await page.getByRole('switch', { name: '展示自定义域名' }).click();
  await button('保存更改').click();
  await page.getByText('更改已保存').waitFor();
  await button('检查并启用').click();
  await page.getByText('目录隔离与清理').waitFor();
  await noOverflow();
  await page.screenshot({
    path: join(screenshots, 'settings-desktop.png'),
    fullPage: true,
  });
  await page.goto(base + '/oss');
  await button('申请空间').click();
  await page.getByLabel('空间名称').fill('项目附件');
  await page.getByLabel('用途').fill('浏览器验收测试');
  await button('提交申请').click();
  await page.getByRole('link', { name: '项目附件', exact: true }).click();
  await button('批准开通').click();
  await page.getByRole('button', { name: '回收空间', exact: true }).waitFor();
  assert.equal(credentialsRead, 0);
  await button('编辑信息').click();
  await page.getByLabel('空间名称').fill('项目图片');
  await button('保存更改').click();
  await page.getByRole('heading', { name: '项目图片', exact: true }).waitFor();
  await button('开启公开读').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await button('关闭公开读').waitFor();
  await button('查看 AK/SK').click();
  await page.getByLabel('AccessKey Secret', { exact: true }).waitFor();
  assert.equal(credentialsRead, 1);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert(
    await page
      .locator('input')
      .evaluateAll((inputs) =>
        inputs.every((i) => i.value !== 'fake-fixture-secret'),
      ),
  );
  await button('重置凭证').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await page.getByText('重置已完成，可查看新凭证。').waitFor();
  assert.equal(rotate, 1);
  await noOverflow();
  await page.screenshot({
    path: join(screenshots, 'detail-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await noOverflow();
  await page.screenshot({ path: join(screenshots, 'detail-mobile.png') });
  await page
    .getByRole('heading', { name: '可用访问域名', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, 'domains-mobile.png') });
  await page.goto(base + '/settings?section=oss');
  await page.getByRole('heading', { name: 'OSS 存储', exact: true }).waitFor();
  await noOverflow();
  await page.screenshot({
    path: join(screenshots, 'settings-mobile.png'),
    fullPage: true,
  });
  await page.goto(base + `/oss/${spaces[0].id}`);
  await button('回收空间').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await page.getByText('EAT 目录授权已回收，云端文件保留。').waitFor();
  assert(await button('开启公开读').isDisabled());
  failList = true;
  await page.goto(base + '/oss');
  await page.getByText('模拟读取失败').waitFor({ timeout: 20000 });
  failList = false;
  await button('重新读取').click();
  await page.getByRole('link', { name: '项目图片', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      screenshots,
      viewports: ['1440x1000', '390x844'],
      credentialsRead,
      rotate,
    }),
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
