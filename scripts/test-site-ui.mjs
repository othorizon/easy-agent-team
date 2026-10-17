#!/usr/bin/env node
/** Folio UI 回归：先启动 web dev server，再运行 node scripts/test-site-ui.mjs。
 * 使用 API 替身验证交互与请求上下文；不会连接真实页面或写入业务数据。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { captureFolioUI } from './folio-ui-evidence.mjs';
import { captureWebsiteUI } from './folio-website-evidence.mjs';

const upstreamPlatform = process.env.EAT_UI_URL ?? 'http://127.0.0.1:5173';
let platform = upstreamPlatform;
const output = process.env.EAT_UI_SHOTS ?? '/tmp/eat-site-ui';
// 用真实本地 HTTP 响应保留地址空间分类，避免路由替身被浏览器视为公网源。
const publishedServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(publishedHtml());
});
await new Promise((resolve) => publishedServer.listen(0, '127.0.0.1', resolve));
const published = 'http://127.0.0.1:' + publishedServer.address().port;
// Real cross-origin HTTP, actual SDK V4 URL generation, and native browser CORS/preflight.
// This is an OSS protocol substitute, not validation against Alibaba Cloud.
const requireServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const OSS = requireServer('ali-oss');
const { zipSync } = createRequire(new URL('../apps/web/package.json', import.meta.url))('fflate');
const blobs = new Map(), staged = new Map(), uploadSessions = new Map(), signatures = new Set();
let denyCors = false, corsOptions = 0, binaryPuts = 0;
const ossServer = createServer(async (request, response) => {
  if (!denyCors) {
    response.setHeader('Access-Control-Allow-Origin', platform);
    response.setHeader('Access-Control-Allow-Methods', 'PUT');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (request.method === 'OPTIONS') { corsOptions++; response.writeHead(204).end(); return; }
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers['content-type'], 'application/octet-stream');
  assert.equal(request.headers.origin, platform);
  const url = new URL(request.url, 'http://oss');
  assert.equal(url.searchParams.get('x-oss-signature-version'), 'OSS4-HMAC-SHA256');
  if (!signatures.has(url.pathname + url.search)) { response.writeHead(403).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  staged.set(url.pathname.slice(1), Buffer.concat(chunks));
  binaryPuts++; response.writeHead(200).end();
});
await new Promise((resolve) => ossServer.listen(0, '127.0.0.1', resolve));
const oss = new OSS({ region: 'oss-cn-hangzhou', bucket: 'test-folio-bucket', accessKeyId: 'test-key',
  accessKeySecret: 'test-secret', endpoint: `http://127.0.0.1:${ossServer.address().port}`, cname: true, secure: false });
async function uploadStatus(session, sign) {
  const missing = [...new Map(session.files.filter((f) => !blobs.has(f.hash)).map((f) => [f.hash, { hash: f.hash, size: f.size }])).values()];
  const uploads = [];
  if (sign) for (const file of missing) {
    const headers = { 'Content-Type': 'application/octet-stream' };
    const url = await oss.signatureUrlV4('PUT', 600, { headers }, `staging/${session.id}/${file.hash}`);
    const parsed = new URL(url); signatures.add(parsed.pathname + parsed.search);
    uploads.push({ ...file, headers, url, expiresAt: new Date(Date.now() + 600000).toISOString() });
  }
  return { ...session, missing, uploads, expiresAt: new Date(Date.now() + 86400000).toISOString() };
}
const v1 = '10000000-0000-4000-8000-000000000001';
const v2 = '10000000-0000-4000-8000-000000000002';
const user = {
  id: '20000000-0000-4000-8000-000000000001',
  name: '林晓',
  email: 'lin@example.test',
  role: 'member',
};
const timestamp = '2026-10-16T02:30:00.000Z';
const source = await readFile(new URL('../apps/server/src/sites/site-embed.ts', import.meta.url), 'utf8');
const embed = source.slice(source.indexOf('String.raw`') + 'String.raw`'.length, source.lastIndexOf('`;'));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const failures = [];
const writes = [];
let failThreads = false;
let denyAccess = false;
let failDelete = false;
let failReply = false;
let delayReply = false;
let pendingReply;
let pendingDelete;
let delayDelete = false;
let delayAbout = false;
let releaseAbout;
let site = {
  id: 'demo-id',
  slug: 'demo',
  name: '产品体验站',
  description: '分享想法，一起把体验打磨得更好。',
  ownerId: user.id,
  access: 'public',
  spa: true,
  currentVersionId: v2,
  url: published,
  canManage: true,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const versions = [
  {
    id: v2,
    number: 2,
    message: '更新首页与移动端布局',
    fileCount: 12,
    totalBytes: 204800,
    publisherId: user.id,
    createdAt: timestamp,
    url: published,
  },
  {
    id: v1,
    number: 1,
    message: '首次发布',
    fileCount: 8,
    totalBytes: 102400,
    publisherId: user.id,
    createdAt: '2026-10-15T02:30:00.000Z',
    url: published,
  },
];
function thread(id, content, versionId = v1, page = '/', status = 'open', anchor = { type: 'page' }) {
  return {
    id,
    page,
    versionId,
    versionNumber: versionId === v1 ? 1 : 2,
    anchor,
    status,
    authorId: user.id,
    canResolve: true,
    createdAt: timestamp,
    url: published + page + '?eat_thread=' + id,
    comments: [
      {
        id: id + '-first',
        authorId: user.id,
        authorName: '林晓',
        content,
        versionId,
        versionNumber: versionId === v1 ? 1 : 2,
        mentions: [],
        deletedAt: null,
        canDelete: true,
        createdAt: timestamp,
      },
    ],
  };
}
let threads = [
  thread('old', '首页标题可以更清楚地表达产品价值。', v1, '/', 'open', {
    type: 'element',
    elementId: 'hero-title',
    text: '让灵感成为作品',
  }),
  thread('new', '移动端布局已经很舒服了。', v2, '/', 'resolved'),
  thread('about', '关于页面的反馈', v2, '/about'),
];
function publishedHtml() {
  const config = Buffer.from(
    JSON.stringify({ platform, slug: 'demo', versionId: v1, versionNumber: 1, proof: 'page-proof' }),
  ).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px system-ui;margin:0;background:#faf9f6}main{padding:60px 36px;max-width:680px}h1{font-size:48px;line-height:1.2}p{line-height:1.8;color:#666}button,iframe{display:none!important}#region{height:180px;background:#eee;border-radius:20px;padding:24px}</style></head><body><main><p>STUDIO / 让创造发生</p><h1 id="hero-title">让灵感成为作品</h1><p>一个轻盈的空间，用于分享正在构建的想法。你可以留下反馈，也可以直接标注你关注的地方。</p><div id="region">一起打磨更好的体验</div></main><script data-eat="${config}">${embed}</script></body></html>`;
}
async function context(authenticated = true, viewport = { width: 1440, height: 1000 }, options = {}) {
  const ctx = await browser.newContext({
    viewport,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ...options,
  });
  if (authenticated)
    await ctx.addInitScript(
      ({ user, platform }) => {
        if (location.origin === platform) {
          localStorage.setItem('eat.token', 'ui-test-token');
          localStorage.setItem('eat.user', JSON.stringify(user));
        }
      },
      { user, platform },
    );
  ctx.on('page', (page) => page.on('pageerror', (error) => failures.push(error.message)));
  return ctx;
}
async function apiHandler(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/sites/demo', '');
    const data = request.postDataJSON();
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET')
      writes.push({ path, method: request.method(), data, headers: request.headers() });
    if (path === '/api/sites/capability') return json({ enabled: true, status: 'enabled' });
    if (path === '/api/sites' && request.method() === 'GET') return json([site]);
    if (path === '' && request.method() === 'GET') return json(site);
    if (path === '' && request.method() === 'PATCH') {
      site = { ...site, ...data, updatedAt: new Date().toISOString() };
      return json(site);
    }
    if (path === '/versions') return json(versions);
    if (path === '/embed-origin') {
      assert.equal(url.searchParams.get('origin'), published);
      return json({ origin: published });
    }
    if (path === '/mention-users')
      return json([
        user,
        { id: '20000000-0000-4000-8000-000000000002', name: '陈沐', email: 'chen@example.test' },
      ]);
    if (path === '/access') {
      denyAccess = false;
      return json({ accessToken: 'verified-proof' });
    }
    if (path === '/activate') {
      site.currentVersionId = data.versionId;
      return json({ ok: true });
    }
    if (path === '/uploads') {
      let session = [...uploadSessions.values()].find((s) => s.requestId === data.requestId);
      if (!session) {
        session = { id: randomUUID(), requestId: data.requestId, files: data.files, state: 'uploading', result: null };
        uploadSessions.set(session.id, session);
      }
      return json(await uploadStatus(session, true), 201);
    }
    if (path.startsWith('/uploads/')) {
      const [, , id, action] = path.split('/');
      const session = uploadSessions.get(id);
      if (!session) return json({ message: '会话不存在' }, 404);
      if (action === 'complete') {
        for (const file of session.files) if (!blobs.has(file.hash)) {
          const bytes = staged.get(`staging/${id}/${file.hash}`);
          if (!bytes || bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.hash)
            return json({ message: 'SHA-256 或大小不符' }, 400);
          blobs.set(file.hash, bytes);
        }
        site.currentVersionId = v2; session.state = 'completed'; session.result = versions[0];
        return json(session.result, 201);
      }
      return json(await uploadStatus(session, action === 'renew'));
    }
    if (path === '/threads' && request.method() === 'GET') {
      if (failThreads) return json({ message: '服务暂时不可用' }, 503);
      if (denyAccess && !request.headers()['x-eat-site-access'])
        return json({ error: 'SITE_PASSWORD_REQUIRED', message: '请先验证 Folio 访问密码' }, 403);
      const result = threads.filter(
        (t) =>
          t.comments.some((c) => !c.deletedAt) &&
          (!url.searchParams.get('page') || t.page === url.searchParams.get('page')) &&
          (!url.searchParams.get('versionId') || t.versionId === url.searchParams.get('versionId')),
      );
      if (delayAbout && url.searchParams.get('page') === '/about') {
        delayAbout = false;
        await new Promise((resolve) => {
          releaseAbout = resolve;
        });
      }
      return json(result);
    }
    if (path === '/threads' && request.method() === 'POST') {
      const t = thread(
        'created-' + writes.length,
        data.content,
        data.versionId,
        data.page,
        'open',
        data.anchor,
      );
      threads.unshift(t);
      return json(t, 201);
    }
    if (path.startsWith('/comments/') && request.method() === 'DELETE') {
      if (failDelete) return json({ message: '删除失败，请稍后重试' }, 503);
      if (delayDelete)
        await new Promise((resolve) => {
          pendingDelete = resolve;
        });
      const id = path.slice('/comments/'.length);
      const c = threads.flatMap((t) => t.comments).find((c) => c.id === id);
      if (!c || c.deletedAt) return json({ message: '评论不存在或已删除' }, 404);
      c.content = '';
      c.mentions = [];
      c.canDelete = false;
      c.deletedAt = new Date().toISOString();
      return json({ ok: true });
    }
    const match = /^\/threads\/([^/]+)(\/replies)?$/.exec(path);
    if (match) {
      const t = threads.find((t) => t.id === match[1]);
      if (match[2]) {
        if (delayReply)
          await new Promise((resolve) => {
            pendingReply = resolve;
          });
        if (failReply) return json({ message: '回复发送失败，请重试' }, 503);
        t.comments.push({
          ...t.comments[0],
          id: 'reply-' + writes.length,
          content: data.content,
          versionId: data.versionId,
          versionNumber: data.versionId === v1 ? 1 : 2,
        });
      } else t.status = data.status;
      return json(t);
    }
    throw new Error('Unhandled API ' + request.method() + ' ' + request.url());
}
// Native HTTP API substitute avoids DevTools routing changing CORS/preflight behavior.
const platformServer = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      await apiHandler({ request: () => ({ url: () => platform + req.url, method: () => req.method,
        headers: () => req.headers, postDataJSON: () => body ? JSON.parse(body) : null }),
        fulfill: ({ status, contentType, body }) => { res.writeHead(status, { 'Content-Type': contentType }); res.end(body); } });
    } else {
      const upstream = await fetch(upstreamPlatform + req.url);
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'text/plain' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (e) { failures.push(e.message); res.writeHead(500).end(); }
});
await new Promise((resolve) => platformServer.listen(0, '127.0.0.1', resolve));
platform = 'http://127.0.0.1:' + platformServer.address().port;
const waitText = (page, text) => page.getByText(text, { exact: true }).first().waitFor({ state: 'visible' });
const shot = (page, name) => page.screenshot({ path: output + '/' + name + '.png', fullPage: true });
async function refreshWebsite(frame) {
  await frame.getByRole('button', { name: '评论面板操作', exact: true }).click();
  await frame.getByRole('menuitem', { name: '刷新评论', exact: true }).click();
}
async function startWebsiteComment(frame) {
  if (!(await frame.getByRole('textbox', { name: '评论内容', exact: true }).count()))
    await frame.getByRole('button', { name: /^(添加评论…|继续编辑新评论…)$/ }).click();
}
async function chooseAnnotation(frame, name) {
  await frame.getByRole('button', { name: '选择标注位置', exact: true }).click();
  await frame.getByRole('menuitem', { name, exact: true }).click();
}
async function deleteWebsiteComment(frame, scope) {
  await scope.getByRole('button', { name: /^(讨论操作|回复操作)$/ }).click();
  await frame.getByRole('menuitem', { name: '删除评论', exact: true }).click();
}
try {
  await mkdir(output, { recursive: true });
  if (process.env.EAT_UI_CAPTURE === '1')
    await captureFolioUI({ context, platform, published, output, site, user });
  if (process.env.EAT_UI_CAPTURE === '1')
    await captureWebsiteUI({ context, platform, published, output, threads });
  const ctx = await context();
  const page = await ctx.newPage();
  await page.goto(platform + '/folios');
  await page.getByRole('heading', { name: 'Folio', exact: true }).waitFor();
  await page.getByRole('button', { name: '创建 Folio', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: '创建 Folio', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('link', { name: site.name, exact: true }).click();
  await waitText(page, '首页标题可以更清楚地表达产品价值。');
  assert.equal(
    await page.getByRole('tab', { name: '评论', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  assert.equal(await page.getByRole('combobox', { name: /版本/ }).count(), 0);
  assert.equal(await page.getByText('发起于 v1').isVisible(), false);
  await page.getByRole('textbox', { name: '评论内容', exact: true }).fill('切换 tab 仍保留的草稿');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByLabel('谁可以访问').selectOption('password');
  assert.equal(await page.getByLabel('访问密码', { exact: true }).getAttribute('required'), '');
  await page.getByLabel('访问密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '保存设置' }).click();
  await waitText(page, '设置已保存');
  assert.equal(writes.at(-1).data.access, 'password');
  await shot(page, 'settings-desktop');
  await page.getByRole('tab', { name: '评论', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: '评论内容', exact: true }).inputValue(),
    '切换 tab 仍保留的草稿',
  );
  await page.getByRole('button', { name: '发送评论', exact: true }).click();
  await waitText(page, '切换 tab 仍保留的草稿');
  assert.equal(writes.find((w) => w.data?.content === '切换 tab 仍保留的草稿').data.versionId, v2);
  const oldThread = page.locator('#thread-old');
  await oldThread.getByRole('button', { name: '回复', exact: true }).click();
  await oldThread.getByRole('textbox', { name: '回复内容' }).fill('当前页面已调整');
  await oldThread.getByRole('button', { name: '发送回复' }).click();
  await waitText(page, '当前页面已调整');
  assert.equal(writes.at(-1).data.versionId, v2);
  await oldThread.getByRole('button', { name: '标记解决' }).click();
  await oldThread.getByRole('button', { name: '重新打开' }).waitFor();
  await oldThread.getByRole('button', { name: '重新打开' }).click();
  await oldThread.getByRole('button', { name: '标记解决' }).waitFor();
  await page.getByRole('button', { name: '提及同事', exact: true }).click();
  const commentInput = page.getByRole('textbox', { name: '评论内容', exact: true });
  assert.equal(await commentInput.inputValue(), '@');
  assert.equal(await commentInput.evaluate((el) => el === document.activeElement), true);
  await commentInput.pressSequentially('陈');
  await page.getByRole('button', { name: '陈沐 chen@example.test' }).click();
  await page.getByRole('textbox', { name: '评论内容', exact: true }).press('End');
  await page.getByRole('textbox', { name: '评论内容', exact: true }).pressSequentially('请看一下');
  await page.getByRole('textbox', { name: '评论内容', exact: true }).press('Control+Enter');
  await waitText(page, '@陈沐 请看一下');
  assert.deepEqual(writes.at(-1).data.mentions, ['20000000-0000-4000-8000-000000000002']);
  await shot(page, 'comments-desktop');
  await page.getByRole('tab', { name: '发布记录' }).click();
  const row = page.getByRole('row').filter({ hasText: '首次发布' });
  await row.getByRole('button', { name: '相关评论' }).click();
  await waitText(page, '正在查看发布记录 v1 的评论');
  await waitText(page, '首页标题可以更清楚地表达产品价值。');
  await page.getByRole('button', { name: '返回全部评论' }).click();
  await waitText(page, '移动端布局已经很舒服了。');
  await page.getByRole('tab', { name: '发布记录' }).click();
  await row.getByRole('button', { name: '恢复此发布' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click();
  assert.equal(writes.filter((w) => w.path === '/activate').length, 0);
  await row.getByRole('button', { name: '恢复此发布' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '恢复发布', exact: true }).click();
  await waitText(page, '已恢复，Folio 链接现在展示所选内容');
  assert.equal(site.currentVersionId, v1);
  await page.getByRole('button', { name: '发布新版', exact: true }).click();
  await page
    .locator('input[aria-label="上传 ZIP"]')
    .setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid') });
  await waitText(page, 'invalid zip data');
  // 上传失败保留对话框，随后重试目录上传。
  const uploadDirectory = await mkdtemp(join(tmpdir(), 'eat-ui-upload-'));
  try {
    await writeFile(join(uploadDirectory, 'index.html'), '<h1>Updated</h1>');
    const beforeDeniedPuts = binaryPuts;
    denyCors = true;
    await page.locator('input[aria-label="上传目录"]').setInputFiles(uploadDirectory);
    await page.getByRole('alert').filter({ hasText: 'OSS 二进制上传失败' }).waitFor();
    assert.ok(await page.getByRole('button', { name: '重试发布', exact: true }).isVisible());
    assert.equal(binaryPuts, beforeDeniedPuts, 'failed preflight prevents PUT');
    const sessionCount = uploadSessions.size;
    await page.reload();
    await page.getByRole('button', { name: '发布新版', exact: true }).click();
    await page.getByText('存在未完成的发布', { exact: false }).waitFor();
    denyCors = false;
    await page.locator('input[aria-label="上传目录"]').setInputFiles(uploadDirectory);
    await waitText(page, 'Folio 已发布，访问链接保持不变');
    assert.equal(uploadSessions.size, sessionCount, 'reload resumes the same session');
    assert.equal(binaryPuts, 1);
    await page.getByRole('button', { name: '发布新版', exact: true }).click();
    const zip = zipSync({ 'index.html': Buffer.from('<body>ZIP binary</body>'), 'image.png': Buffer.from([0,128,255]) });
    await page.locator('input[aria-label="上传 ZIP"]').setInputFiles({ name: 'valid.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(binaryPuts, 3);
    assert.ok(corsOptions >= 3, 'browser performed native cross-origin preflights');
    console.log('PASS binary directory/ZIP, SDK V4 URLs/Content-Type, native CORS denial, reload/resume, retry, no EAT credentials');
  } finally {
    await rm(uploadDirectory, { recursive: true, force: true });
  }
  assert.equal(site.currentVersionId, v2);
  await page.getByRole('tab', { name: '评论', exact: true }).click();
  // 后返回的旧页面响应不能覆盖当前筛选结果。
  delayAbout = true;
  const aboutRequest = page.waitForRequest((r) => r.url().includes('threads?page=%2Fabout'));
  await page.getByRole('textbox', { name: '按页面筛选评论' }).fill('/about');
  await aboutRequest;
  await page.getByRole('textbox', { name: '按页面筛选评论' }).fill('/');
  await waitText(page, '首页标题可以更清楚地表达产品价值。');
  const aboutResponse = page.waitForResponse((r) => r.url().includes('threads?page=%2Fabout'));
  releaseAbout();
  await aboutResponse;
  assert.equal(await page.getByText('关于页面的反馈', { exact: true }).isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot(page, 'comments-mobile');
  console.log(
    'PASS console: tabs, draft, settings, cross-publication replies, resolve, history filter, restore, publish retry, stale response, mobile',
  );

  const sitePage = await ctx.newPage();
  await sitePage.goto(published);
  const iframeUrl = new URL(await sitePage.locator('iframe[title="Folio 评论"]').getAttribute('src'));
  assert.equal(iframeUrl.searchParams.get('origin'), published);
  const toggle = sitePage.locator('#__eat_widget').getByRole('button', { name: '评论', exact: true });
  const badge = sitePage.locator('#__eat_widget .comment-dot');
  await badge.waitFor({ state: 'visible' });
  assert.equal(await toggle.innerText(), '');
  assert.equal(await toggle.getAttribute('aria-label'), '评论');
  await toggle.click();
  assert.equal(await badge.isVisible(), false);
  const frame = sitePage.frameLocator('iframe[title="Folio 评论"]');
  await frame.getByText('首页标题可以更清楚地表达产品价值。', { exact: true }).waitFor();
  assert.equal(await frame.getByRole('combobox').count(), 0);
  assert.equal(await frame.getByRole('textbox').count(), 0, 'composer starts collapsed');
  assert.equal(
    await frame.getByText('移动端布局已经很舒服了。', { exact: true }).count(),
    0,
    'resolved discussions start folded',
  );
  assert.equal(await frame.getByRole('button', { name: '回复', exact: true }).count(), 0);
  assert.equal(await frame.getByRole('button', { name: '定位标注', exact: true }).count(), 0);
  await sitePage.evaluate(() => {
    window.__eatLocations = [];
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'eat:locate') window.__eatLocations.push(e.data.threadId);
    });
  });
  const embeddedOld = frame.locator('#thread-old');
  const selectedText = await embeddedOld
    .getByText('首页标题可以更清楚地表达产品价值。', { exact: true })
    .boundingBox();
  await sitePage.mouse.move(selectedText.x + 2, selectedText.y + selectedText.height / 2);
  await sitePage.mouse.down();
  await sitePage.mouse.move(selectedText.x + 90, selectedText.y + selectedText.height / 2, { steps: 8 });
  await sitePage.mouse.up();
  assert.equal(
    await embeddedOld.getAttribute('data-active'),
    'false',
    'selecting text must not activate discussion',
  );
  await sitePage
    .frames()
    .find((f) => f.url().startsWith(platform))
    .evaluate(() => window.getSelection()?.removeAllRanges());
  await embeddedOld.getByRole('button', { name: '展开讨论并定位标注' }).click();
  await embeddedOld.getByRole('textbox', { name: '回复内容' }).fill('第一组保留的草稿');
  await embeddedOld.getByText('当前页面已调整', { exact: true }).waitFor();
  await sitePage.locator('#__eat_highlight').waitFor({ state: 'visible' });
  const another = frame.locator('article').filter({ hasText: '切换 tab 仍保留的草稿' });
  await another.getByRole('button', { name: '展开讨论并定位标注' }).click();
  await another.getByRole('button', { name: '提及同事' }).click();
  const mentionPopover = frame.getByRole('dialog', { name: '提及同事' });
  await mentionPopover.waitFor();
  const mentionBounds = await mentionPopover.boundingBox();
  const embedBounds = await sitePage.locator('iframe[title="Folio 评论"]').boundingBox();
  assert.ok(
    mentionBounds.y >= embedBounds.y &&
      mentionBounds.y + mentionBounds.height <= embedBounds.y + embedBounds.height,
    'mention suggestions remain inside iframe',
  );
  await frame.getByRole('button', { name: '陈沐 chen@example.test' }).click();
  assert.equal(await another.getByRole('textbox', { name: '回复内容' }).inputValue(), '@陈沐 ');
  await another.getByRole('textbox', { name: '回复内容' }).fill('第二组保留的草稿');
  await embeddedOld.getByRole('button', { name: '展开讨论并定位标注' }).click();
  assert.equal(await embeddedOld.getByRole('textbox', { name: '回复内容' }).inputValue(), '第一组保留的草稿');
  assert.equal(await frame.getByRole('textbox').count(), 1, 'only one active editor');
  const locationCount = await sitePage.evaluate(() => window.__eatLocations.length);
  await embeddedOld.getByRole('button', { name: '讨论操作' }).click();
  await frame.getByRole('menuitem', { name: '详细信息' }).click();
  await embeddedOld.getByText('页面：/ · 发起于 v1', { exact: true }).waitFor();
  assert.equal(
    await sitePage.evaluate(() => window.__eatLocations.length),
    locationCount,
    'menu action must not locate',
  );
  await embeddedOld.getByRole('button', { name: '讨论操作' }).click();
  await frame.getByRole('menuitem', { name: '复制讨论链接' }).click();
  await frame.getByText('讨论链接已复制', { exact: true }).waitFor();
  await embeddedOld.getByRole('button', { name: '讨论操作' }).click();
  await frame.getByRole('menuitem', { name: '标记解决' }).click();
  await frame.getByText('讨论已解决', { exact: true }).waitFor();
  assert.equal(await embeddedOld.count(), 0, 'resolved thread moves into folded section');
  await frame.getByRole('button', { name: '撤销', exact: true }).click();
  await embeddedOld.getByRole('textbox', { name: '回复内容' }).waitFor();
  assert.equal(await embeddedOld.getByRole('textbox', { name: '回复内容' }).inputValue(), '第一组保留的草稿');
  failReply = true;
  delayReply = true;
  const pendingReplyRequest = sitePage.waitForRequest(
    (r) => r.url().includes('/threads/old/replies') && r.method() === 'POST',
  );
  await embeddedOld.getByRole('button', { name: '发送回复' }).click();
  await pendingReplyRequest;
  await another.getByRole('button', { name: '展开讨论并定位标注' }).click();
  await embeddedOld.getByRole('button', { name: '展开讨论并定位标注' }).click();
  assert.equal(
    await embeddedOld.getByRole('button', { name: '发送回复' }).isDisabled(),
    true,
    'in-flight send survives thread switching',
  );
  assert.equal(typeof pendingReply, 'function');
  pendingReply();
  await embeddedOld.getByRole('alert').getByText('回复发送失败，请重试').waitFor();
  assert.equal(await embeddedOld.getByRole('textbox', { name: '回复内容' }).inputValue(), '第一组保留的草稿');
  failReply = false;
  delayReply = false;
  await embeddedOld.getByRole('button', { name: '发送回复' }).click();
  await embeddedOld.getByText('第一组保留的草稿', { exact: true }).waitFor();
  assert.equal(writes.at(-1).data.versionId, v1, 'reply belongs to actual embedded version');
  const resolvedToggle = frame.getByRole('button', { name: /^已解决/ });
  await resolvedToggle.click();
  await frame.locator('#thread-new').getByRole('button', { name: '展开讨论并定位标注' }).click();
  await frame.locator('#thread-new').getByRole('textbox', { name: '回复内容' }).waitFor();
  assert.equal(
    await sitePage.locator('#__eat_highlight').isVisible(),
    false,
    'page feedback clears anchor highlight',
  );
  await resolvedToggle.click();

  await startWebsiteComment(frame);
  await frame.getByRole('textbox', { name: '评论内容', exact: true }).fill('元素批注草稿');
  const beforeSelection = writes.length;
  await chooseAnnotation(frame, '标注元素');
  await sitePage.getByRole('button', { name: '取消标注', exact: true }).waitFor();
  await sitePage.keyboard.press('Escape');
  assert.equal(writes.length, beforeSelection, 'annotation tool must not submit draft');
  assert.equal(
    await frame.getByRole('textbox', { name: '评论内容', exact: true }).inputValue(),
    '元素批注草稿',
  );
  await chooseAnnotation(frame, '标注元素');
  await sitePage.locator('#__eat_widget').getByRole('button', { name: '取消标注', exact: true }).waitFor();
  await sitePage.locator('#hero-title').click();
  await frame.getByRole('button', { name: '取消标注', exact: true }).waitFor();
  await embeddedOld.getByRole('button', { name: '展开讨论并定位标注' }).click();
  await startWebsiteComment(frame);
  await frame.getByRole('button', { name: '取消标注', exact: true }).waitFor();
  assert.equal(
    await frame.getByRole('textbox', { name: '评论内容', exact: true }).inputValue(),
    '元素批注草稿',
    'new comment keeps content and anchor across discussion selection',
  );
  await frame.getByRole('button', { name: '发送评论', exact: true }).click();
  await frame.getByText('元素批注草稿', { exact: true }).waitFor();
  assert.equal(writes.at(-1).data.versionId, v1);
  assert.equal(writes.at(-1).data.anchor.elementId, 'hero-title');
  await startWebsiteComment(frame);
  await chooseAnnotation(frame, '框选区域');
  await sitePage.locator('#__eat_widget').getByRole('button', { name: '取消标注', exact: true }).waitFor();
  const bounds = await sitePage.locator('#region').boundingBox();
  await sitePage.mouse.move(bounds.x + 12, bounds.y + 12);
  await sitePage.mouse.down();
  await sitePage.mouse.move(bounds.x + 120, bounds.y + 70);
  await sitePage.mouse.up();
  await frame.getByRole('button', { name: '取消标注', exact: true }).waitFor();
  await frame.getByRole('textbox', { name: '评论内容', exact: true }).fill('区域批注');
  await frame.getByRole('button', { name: '发送评论', exact: true }).click();
  await frame.getByText('区域批注', { exact: true }).waitFor();
  assert.equal(writes.at(-1).data.anchor.type, 'region');
  assert.ok(writes.at(-1).data.anchor.rect.width > 0);
  await embeddedOld.getByRole('button', { name: '展开讨论并定位标注' }).click();
  await sitePage.locator('#__eat_highlight').waitFor({ state: 'visible' });
  await sitePage.locator('#hero-title').evaluate((el) => el.remove());
  await embeddedOld.getByRole('button', { name: '展开讨论并定位标注' }).click();
  await embeddedOld.getByText('页面内容已变化，可查看评论时的页面。', { exact: false }).waitFor();
  await embeddedOld.getByRole('link', { name: '查看评论时的页面' }).waitFor();
  await shot(sitePage, 'embedded-desktop');
  await sitePage.setViewportSize({ width: 390, height: 844 });
  await startWebsiteComment(frame);
  const sendBounds = await frame.getByRole('button', { name: '发送评论', exact: true }).boundingBox();
  assert.ok(sendBounds.y + sendBounds.height < 844);
  await shot(sitePage, 'embedded-mobile');
  await frame.getByRole('button', { name: '关闭评论' }).click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await badge.waitFor({ state: 'visible' });
  await toggle.click();
  await startWebsiteComment(frame);
  await frame.getByRole('textbox', { name: '评论内容', exact: true }).fill('切页前草稿');
  await sitePage.evaluate(() => history.pushState({}, '', '/about'));
  await frame.getByText('关于页面的反馈', { exact: true }).waitFor();
  await startWebsiteComment(frame);
  assert.equal(await frame.getByRole('textbox', { name: '评论内容', exact: true }).inputValue(), '');
  assert.equal(await frame.getByRole('button', { name: '取消标注', exact: true }).count(), 0);

  const linked = await ctx.newPage();
  await linked.goto(published + '?eat_thread=new');
  const linkedFrame = linked.frameLocator('iframe[title="Folio 评论"]');
  await linkedFrame.locator('#thread-new[data-active="true"]').waitFor();
  assert.equal(
    await linkedFrame.getByRole('button', { name: /^已解决/ }).getAttribute('aria-expanded'),
    'true',
  );
  await linked.close();
  const touchContext = await context(true, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(published);
  await touchPage.locator('#__eat_widget').getByRole('button', { name: '评论', exact: true }).click();
  const touchFrame = touchPage.frameLocator('iframe[title="Folio 评论"]');
  await touchFrame.locator('#thread-old').getByRole('button', { name: '展开讨论并定位标注' }).click();
  assert.equal(
    await touchFrame
      .getByRole('textbox', { name: '回复内容' })
      .evaluate((el) => el === document.activeElement),
    false,
    'touch selection must not autofocus keyboard',
  );
  assert.equal(
    await touchPage.locator('iframe[title="Folio 评论"]').evaluate((el) => el.contentWindow !== null),
    true,
  );
  await touchContext.close();
  console.log(
    'PASS embed: grouped replies, single editor, drafts, menus, resolve/undo, folded history/deep link, locate/fallback, annotation tools, actual version, navigation and touch focus',
  );

  const anonymous = await context(false);
  const anon = await anonymous.newPage();
  failThreads = true;
  await anon.goto(platform + '/folio-comments/demo?versionId=' + v1);
  await waitText(anon, '服务暂时不可用');
  assert.equal(await anon.getByLabel('Folio 访问密码').count(), 0);
  failThreads = false;
  await anon.getByRole('button', { name: '重试', exact: true }).click();
  await waitText(anon, '首页标题可以更清楚地表达产品价值。');
  await anon.getByRole('button', { name: '登录后评论', exact: true }).waitFor();
  denyAccess = true;
  await refreshWebsite(anon);
  await anon.getByLabel('Folio 访问密码').fill('password');
  await anon.getByRole('button', { name: '验证', exact: true }).click();
  await waitText(anon, '首页标题可以更清楚地表达产品价值。');
  assert.equal(writes.at(-1).path, '/access');
  console.log('PASS errors: retry without password prompt, password verification, anonymous sign-in entry');
  const blockedPopupPage = await anonymous.newPage();
  await blockedPopupPage.goto(published);
  await blockedPopupPage.locator('#__eat_widget').getByRole('button', { name: '评论', exact: true }).click();
  const popupFrame = blockedPopupPage.frameLocator('iframe[title="Folio 评论"]');
  await popupFrame.getByRole('button', { name: '登录后评论', exact: true }).waitFor();
  await blockedPopupPage
    .frames()
    .find((f) => f.url().startsWith(platform))
    .evaluate(() => {
      window.open = () => null;
    });
  await popupFrame.getByRole('button', { name: '登录后评论', exact: true }).click();
  await popupFrame.getByText('登录窗口未能打开，请允许弹出窗口后重试。', { exact: true }).waitFor();
  console.log('PASS sign-in: blocked popup gives actionable feedback');
  const deletion = thread('delete-ui', '需要删除的评论', v2);
  deletion.comments.push({
    ...deletion.comments[0],
    id: 'keep-reply',
    content: '其他人的回复仍然保留',
    canDelete: false,
  });
  threads.unshift(deletion);
  await page.getByRole('button', { name: '刷新评论' }).click();
  await waitText(page, '需要删除的评论');
  await page
    .locator('#comment-delete-ui-first')
    .getByRole('button', { name: '删除评论', exact: true })
    .click();
  let confirmation = page.getByRole('alertdialog');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(writes.filter((w) => w.method === 'DELETE').length, 0);
  await page
    .locator('#comment-delete-ui-first')
    .getByRole('button', { name: '删除评论', exact: true })
    .click();
  failDelete = true;
  await confirmation.getByRole('button', { name: '删除评论', exact: true }).click();
  await confirmation.getByText('删除失败，请稍后重试', { exact: true }).waitFor();
  assert.equal(
    await page.locator('#comment-delete-ui-first').getByText('需要删除的评论', { exact: true }).isVisible(),
    true,
  );
  failDelete = false;
  delayDelete = true;
  const deletionRequest = page.waitForRequest((r) => r.method() === 'DELETE');
  await confirmation.getByRole('button', { name: '删除评论', exact: true }).click();
  await deletionRequest;
  assert.equal(await confirmation.getByRole('button', { name: '删除评论', exact: true }).isDisabled(), true);
  assert.equal(await confirmation.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('[role="alertdialog"] button[disabled]') !== null);
  while (!pendingDelete) await new Promise((resolve) => setTimeout(resolve, 10));
  pendingDelete();
  delayDelete = false;
  await page.locator('#comment-delete-ui-first').getByText('评论已删除', { exact: true }).waitFor();
  assert.equal(
    await page
      .locator('#comment-delete-ui-first')
      .getByRole('button', { name: '删除评论', exact: true })
      .count(),
    0,
  );
  await waitText(page, '其他人的回复仍然保留');
  assert.equal(
    await page.locator('#comment-keep-reply').getByRole('button', { name: '删除评论', exact: true }).count(),
    0,
  );
  threads.unshift(thread('delete-embedded', '页面内删除的评论', v1, '/about'));
  await refreshWebsite(frame);
  await frame.getByText('页面内删除的评论', { exact: true }).waitFor();
  await deleteWebsiteComment(frame, frame.locator('#comment-delete-embedded-first'));
  await frame.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).focus();
  await sitePage.keyboard.press('Escape');
  await frame.getByRole('textbox', { name: '评论内容', exact: true }).waitFor();
  assert.equal(
    await sitePage
      .locator('#__eat_widget')
      .getByRole('button', { name: '收起评论', exact: true })
      .getAttribute('aria-expanded'),
    'true',
  );
  await deleteWebsiteComment(frame, frame.locator('#comment-delete-embedded-first'));
  await frame.getByRole('alertdialog').getByRole('button', { name: '删除评论', exact: true }).click();
  await frame.locator('#thread-delete-embedded').waitFor({ state: 'detached' });
  console.log(
    'PASS deletion: confirm/cancel, failure retry, in-flight guard, tombstone, preserved replies, permissions, embedded deletion and Escape',
  );
  // 蓝点代表当前路径存在评论，打开面板后不把它当作“已读”清除。
  await sitePage.evaluate(() => history.pushState({}, '', '/indicator-empty'));
  await frame.getByText('还没有评论', { exact: true }).waitFor();
  await frame.getByRole('button', { name: '关闭评论', exact: true }).click();
  assert.equal(await badge.isVisible(), false);
  await sitePage.evaluate(() =>
    window.postMessage(
      {
        type: 'eat:comment-state',
        page: location.pathname,
        versionId: '10000000-0000-4000-8000-000000000001',
        hasComments: true,
      },
      location.origin,
    ),
  );
  assert.equal(await badge.isVisible(), false);
  await toggle.click();
  await startWebsiteComment(frame);
  await frame.getByRole('textbox', { name: '评论内容', exact: true }).fill('当前路径的新反馈');
  await frame.getByRole('button', { name: '发送评论', exact: true }).click();
  const indicatorThread = frame.locator('article').filter({ hasText: '当前路径的新反馈' });
  await indicatorThread.waitFor();
  await frame.getByRole('button', { name: '关闭评论', exact: true }).click();
  await badge.waitFor({ state: 'visible' });
  await toggle.click();
  await deleteWebsiteComment(frame, indicatorThread);
  await frame.getByRole('alertdialog').getByRole('button', { name: '删除评论', exact: true }).click();
  await frame.getByText('还没有评论', { exact: true }).waitFor();
  await frame.getByRole('button', { name: '关闭评论', exact: true }).click();
  assert.equal(await badge.isVisible(), false);
  await sitePage.evaluate(() => history.pushState({}, '', '/about'));
  await badge.waitFor({ state: 'visible' });
  await sitePage.evaluate(() => history.pushState({}, '', '/indicator-empty'));
  await badge.waitFor({ state: 'hidden' });
  console.log(
    'PASS comment indicator: icon-only, count handshake, open/close, route changes, create/delete last comment, untrusted message ignored',
  );
  site.canManage = false;
  const readonly = await ctx.newPage();
  await readonly.goto(platform + '/folios/demo');
  await waitText(readonly, '首页标题可以更清楚地表达产品价值。');
  assert.equal(await readonly.getByRole('tab', { name: '设置', exact: true }).count(), 0);
  assert.equal(await readonly.getByRole('button', { name: '发布新版', exact: true }).count(), 0);
  site.canManage = true;
  site.currentVersionId = null;
  const unpublished = await ctx.newPage();
  await unpublished.goto(platform + '/folios/demo');
  await waitText(unpublished, '发布 Folio，开始收集反馈');
  assert.equal(await unpublished.getByRole('link', { name: '打开 Folio', exact: true }).count(), 0);
  console.log('PASS access states: read-only member and unpublished website');
  assert.deepEqual(failures, [], 'Browser runtime errors');
  console.log('Screenshots: ' + output);
} catch (error) {
  console.error('Browser errors:', failures);
  for (const ctx of browser.contexts())
    for (const page of ctx.pages()) {
      console.error('Page:', page.url(), await page.locator('#__eat_widget').count());
      await page
        .screenshot({
          path:
            output + '/failure-' + browser.contexts().indexOf(ctx) + '-' + ctx.pages().indexOf(page) + '.png',
          fullPage: true,
        })
        .catch(() => {});
    }
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => publishedServer.close(resolve));
  await new Promise((resolve) => ossServer.close(resolve));
  await new Promise((resolve) => platformServer.close(resolve));
}
