#!/usr/bin/env node
/** pnpm build 后运行：公共中转页自动导航、手动兜底与无效目标的浏览器回归。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildReplyRedirectUrl } from '../packages/shared/dist/index.js';

const dist = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/received') return res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Received</h1>');
  const file = pathname.startsWith('/assets/') ? resolve(dist, '.' + pathname) : join(dist, 'index.html');
  if (!file.startsWith(dist + '/')) return res.writeHead(404).end();
  try {
    res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const errors = [];
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const message = '中文回复 & # + % 换行\n<script>alert(1)</script> 🔔';
    const link = buildReplyRedirectUrl(base, `${base}/received?message={message}&keep=a%2Bb`, message);
    const before = requests.filter((url) => url.startsWith('/received')).length;
    await page.goto(link);
    await page.waitForURL('**/received?**');
    assert.equal(new URL(page.url()).searchParams.get('message'), message);
    assert.equal(new URL(page.url()).searchParams.get('keep'), 'a+b');
    assert.equal(requests.filter((url) => url.startsWith('/received')).length, before + 1);
    assert.ok(requests.includes('/redirect'));
    assert.ok(!requests.some((url) => url.startsWith('/redirect?')));
    assert.ok(!requests.some((url) => url.startsWith('/api/'))); // 未登录仍可使用

    // 无外部应用的 headless 浏览器：检查自动尝试后保留的手动入口，不把它当作真实唤起成功。
    const appLink = buildReplyRedirectUrl(base, 'codex://new?prompt={message}', message);
    await page.goto(appLink);
    await page.getByRole('status').filter({ hasText: /已尝试打开任务|未能自动打开任务/ }).waitFor();
    assert.equal(await page.getByRole('link', { name: '打开任务', exact: true }).getAttribute('href'),
      'codex://new?prompt=' + encodeURIComponent(message));
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('clipboard unavailable'); } },
    }));
    await page.getByRole('button', { name: '复制任务链接' }).click();
    await page.getByRole('status').filter({ hasText: '请手动复制' }).waitFor();
    assert.equal(await page.locator('details').evaluate((el) => el.open), true);
    assert.equal(await page.getByLabel('任务链接').inputValue(), 'codex://new?prompt=' + encodeURIComponent(message));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    for (const target of ['', 'javascript:window.__redirectExecuted=true', 'data:text/html,<script>alert(1)</script>', 'file:///tmp/test']) {
      await page.goto(`${base}/redirect#${new URLSearchParams({ url: target })}`);
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('link', { name: '打开任务', exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__redirectExecuted), undefined);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Reply redirect: desktop/mobile auto-navigation, encoding, public access, fallback and invalid URLs passed.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
