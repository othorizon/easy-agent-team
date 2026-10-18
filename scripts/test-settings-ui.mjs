#!/usr/bin/env node
/** Build Web first, then run: node scripts/test-settings-ui.mjs
 * Uses the real built UI and schema-checked local API fixtures; never writes platform settings.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  llmSettingsSchema,
  llmUserPolicySchema,
  updateAiSettingsSchema,
  updateDokploySettingsSchema,
  updateSiteSettingsSchema,
  updateSiteCdnSchema,
} from '../packages/shared/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps/web/dist');
const screenshots = process.env.EAT_SETTINGS_SCREENSHOTS || join(tmpdir(), 'eat-settings-ui');
mkdirSync(screenshots, { recursive: true });
assert(existsSync(join(dist, 'index.html')), 'Build Web before running this check');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path.startsWith('/assets/') ? join(dist, path) : join(dist, 'index.html');
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
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
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const errors = [],
  writes = [],
  requests = [];
const currency = { quotaPerUnit: 500000, currency: 'CNY', exchangeRate: 7.3 };
let failSave = false,
  failTest = false,
  failLists = false,
  failRead = false,
  enablingReads = -1;
let ai = {
  configured: true,
  apiBaseUrl: 'https://models.example.com/v1',
  apiKeyMasked: 'sk-****a19f',
  model: 'deepseek-flash',
  enabled: true,
};
let gateway = {
  configured: true,
  apiUrl: 'https://newapi.example.com',
  accessTokenMasked: 'abc****xyz',
  accountId: 7,
  accountName: 'eat-models',
  defaultQuota: 34246574,
  currency,
  updatedAt: '2026-10-18T03:00:00Z',
};
const personal = {
  configured: true,
  userId: '11111111-1111-4111-8111-111111111111',
  userName: '管理员',
  userStatus: 'active',
  disabled: false,
  initialQuota: null,
  initialQuotaEffective: 34246575,
  giftClaimed: true,
  key: { id: 'key-fixture', maskedKey: 'sk-****demo', status: 'active', createdAt: '2026-10-18T03:00:00Z' },
  totalQuota: 34246575,
  usedQuota: 3700,
  remainingQuota: 34242875,
  currency,
  apiBaseUrl: 'https://newapi.example.com/v1',
  updatedAt: '2026-10-18T03:00:00Z',
  pending: false,
  error: null,
};
let recipient = {
  ...personal,
  userId: '22222222-2222-4222-8222-222222222222',
  userName: '精度验证成员',
  initialQuota: 34246574,
  initialQuotaEffective: 34246574,
  giftClaimed: false,
  key: null,
  totalQuota: 0,
  usedQuota: 0,
  remainingQuota: 0,
};
let deployment = {
  configured: true,
  apiUrl: 'https://deploy.example.com/api',
  apiTokenMasked: '****deploy',
  enabled: true,
  projectId: 'team',
  environmentId: 'production',
  sshKeyId: 'git',
  domainSuffix: 'apps.example.com',
  domainHttps: true,
  provisioningReady: true,
};
let folio = {
  configured: true,
  enabled: false,
  status: 'disabled',
  domain: 'sites.example.com',
  platformUrl: 'https://eat.example.com',
  ossRegion: 'oss-cn-hangzhou',
  ossBucket: 'eat-folio-assets',
  tlsMode: 'alidns',
  acmeEmail: 'admin@example.com',
  certificateId: '',
  resolverName: '',
  platformApplicationId: 'eat-console',
  upstreamUrl: '',
  upstreamPort: 3000,
  gatewayTarget: '203.0.113.10',
  autoDns: false,
  ossAccessKeyIdMasked: 'LTAI****demo',
  hasOssSecret: true,
  dnsAccessKeyIdMasked: 'LTAI****dns',
  hasDnsSecret: true,
  checks: [],
  lastError: '',
  updatedAt: '2026-10-18T03:00:00Z',
};
let cdn = {
  enabled: false,
  scope: 'global',
  credentialSource: 'independent',
  autoDns: false,
  verifyOriginCertificate: false,
  status: 'disabled',
  connected: false,
  accessKeyIdMasked: 'LTAI****cdn',
  hasSecret: true,
  phase: '',
  lastError: '',
  cname: '',
  dnsInstructions: [],
  certificateExpiresAt: null,
  certificateUploaded: false,
  originCertificateCheckedAt: null,
  certificateSyncedAt: null,
  certificateSyncError: '',
  retryAt: null,
  drainUntil: null,
  updatedAt: '2026-10-18T03:00:00Z',
  cacheRefresh: {
    pending: 0,
    lastCompletedAt: null,
    lastError: '',
    retryAt: null,
  },
};

async function context(role = 'admin') {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  await ctx.addInitScript((role) => {
    localStorage.setItem('eat.token', 'local-ui-fixture');
    localStorage.setItem(
      'eat.user',
      JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        name: '管理员',
        email: 'admin@example.com',
        role,
      }),
    );
  }, role);
  await ctx.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    requests.push({ role, method, path });
    const body = req.postDataJSON();
    const reply = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    if (role !== 'admin' && path.startsWith('/api/admin/')) return reply({ message: '没有管理员权限' }, 403);
    if (method !== 'GET') writes.push({ path, body });
    if (path.endsWith('/test')) {
      const ok = !failTest;
      failTest = false;
      return reply({
        ok,
        message: ok ? '连接成功' : '服务未响应，请检查地址后重试',
        latencyMs: 82,
      });
    }
    if (path === `/api/admin/llm-gateway/users/${recipient.userId}/policy`) {
      const policy = llmUserPolicySchema.parse(body);
      recipient = {
        ...recipient,
        ...policy,
        initialQuotaEffective: policy.initialQuota ?? gateway.defaultQuota,
      };
      return reply(recipient);
    }
    if (method === 'PUT') {
      if (failSave) {
        failSave = false;
        return reply({ message: '连接信息有误，请检查服务地址后重试' }, 400);
      }
      await new Promise((r) => setTimeout(r, 180));
      const schema =
        path === '/api/admin/ai-settings'
          ? updateAiSettingsSchema
          : path === '/api/admin/dokploy-settings'
            ? updateDokploySettingsSchema
            : path.endsWith('/cdn')
              ? updateSiteCdnSchema
              : path === '/api/admin/site-settings'
                ? updateSiteSettingsSchema
                : llmSettingsSchema;
      const parsed = schema.safeParse(body);
      assert(parsed.success, `Invalid settings payload: ${path}`);
      if (path === '/api/admin/ai-settings') {
        const { apiKey, ...values } = parsed.data;
        ai = { ...ai, ...values };
        return reply(ai);
      }
      if (path === '/api/admin/dokploy-settings') {
        const { apiToken, ...values } = parsed.data;
        deployment = { ...deployment, ...values };
        return reply(deployment);
      }
      if (path === '/api/admin/llm-gateway-settings') {
        const { accessToken, ...values } = parsed.data;
        gateway = {
          ...gateway,
          ...values,
          updatedAt: new Date().toISOString(),
        };
        return reply(gateway);
      }
      if (path.endsWith('/cdn')) {
        const { accessKeyId, accessKeySecret, ...values } = parsed.data;
        cdn = {
          ...cdn,
          ...values,
          status: 'awaiting_dns',
          dnsInstructions: [
            {
              name: '*.sites.example.com',
              type: 'CNAME',
              value: 'sites.example.com.cdn.example.net',
            },
          ],
        };
        return reply(cdn);
      }
      const { ossAccessKeyId, ossAccessKeySecret, dnsAccessKeyId, dnsAccessKeySecret, ...values } =
        parsed.data;
      folio = { ...folio, ...values };
      return reply(folio);
    }
    if (path === '/api/admin/ai-settings')
      return failRead ? reply({ message: '配置服务暂时不可用' }, 503) : reply(ai);
    if (path === '/api/admin/llm-gateway-settings') return reply(gateway);
    if (path.endsWith('/llm-gateway-settings/account'))
      return reply({
        remainingQuota: 342465753,
        usedQuota: 1000,
        currency,
        checkedAt: '2026-10-18T03:00:00Z',
      });
    if (path === '/api/llm-gateway') return reply(personal);
    if (path === '/api/llm-gateway/models') return reply([{ id: 'gpt-4o-mini' }]);
    if (path === '/api/llm-gateway/usage')
      return reply({
        items: [
          {
            id: 'usage-fixture',
            createdAt: 1792292400,
            model: 'gpt-4o-mini',
            quota: 3700,
            promptTokens: 100,
            completionTokens: 30,
            type: 2,
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
    if (path === '/api/admin/llm-gateway/users') return reply([recipient]);
    if (path === '/api/admin/dokploy-settings') return reply(deployment);
    if (path === '/api/admin/dokploy/projects')
      return failLists
        ? reply({ message: '项目清单暂时不可用' }, 503)
        : reply([
            {
              projectId: 'team',
              name: '团队应用',
              environments: [
                {
                  environmentId: 'production',
                  name: '生产环境',
                  isDefault: true,
                },
              ],
            },
            {
              projectId: 'research',
              name: '研发项目',
              environments: [
                {
                  environmentId: 'staging',
                  name: '预发布环境',
                  isDefault: true,
                },
              ],
            },
          ]);
    if (path === '/api/admin/dokploy/ssh-keys')
      return failLists
        ? reply({ message: 'SSH 清单暂时不可用' }, 503)
        : reply([{ sshKeyId: 'git', name: '团队仓库' }]);
    if (path === '/api/admin/dokploy/applications')
      return reply([
        {
          applicationId: 'eat-console',
          name: 'EAT 控制台',
          appName: 'eat-console',
          projectName: '平台服务',
        },
      ]);
    if (path.includes('/tls-options/'))
      return reply({
        certificates: [
          {
            id: 'existing-cert',
            name: 'Folio 泛域名证书',
            domains: '*.sites.example.com',
            expiresAt: '2027-01-01',
            serverId: null,
          },
        ],
        resolvers: ['dns-main'],
      });
    if (path === '/api/admin/site-settings/enable') {
      enablingReads = 1;
      folio = {
        ...folio,
        status: 'checking',
        checks: [
          {
            id: 'https',
            name: '检查 HTTPS',
            status: 'running',
            message: '正在验证入口',
          },
        ],
      };
      return reply(folio);
    }
    if (path === '/api/admin/site-settings/disable') {
      folio = { ...folio, enabled: false, status: 'disabled', checks: [] };
      return reply(folio);
    }
    if (path === '/api/admin/site-settings') {
      if (enablingReads-- === 0)
        folio = {
          ...folio,
          enabled: true,
          status: 'enabled',
          checks: [
            {
              id: 'https',
              name: '检查 HTTPS',
              status: 'passed',
              message: '入口验证通过',
            },
          ],
        };
      return reply(folio);
    }
    if (path === '/api/admin/site-settings/cdn/retry') {
      cdn = { ...cdn, connected: true, status: 'enabled', dnsInstructions: [] };
      return reply(cdn);
    }
    if (path === '/api/admin/site-settings/cdn') return reply(cdn);
    return reply([]);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
const titles = {
  'platform-ai': '平台 AI',
  'llm-gateway': 'LLM API 网关',
  deployment: '部署接入',
  folio: '基础发布',
  'folio-cdn': 'CDN 加速',
};
async function category(page, id) {
  if (page.viewportSize().width < 900) await choose(page, '#settings-category', titles[id]);
  else
    await page
      .getByRole('navigation', { name: '设置分类', exact: true })
      .getByRole('link', { name: titles[id], exact: true })
      .click();
  await page.locator(`[data-settings-panel="${id}"] h2`).waitFor();
  assert(new URL(page.url()).searchParams.get('section') === id || id === 'platform-ai');
  return page.locator(`[data-settings-panel="${id}"]`);
}
async function menuFits(page) {
  await page.getByRole('listbox').evaluate(async (menu) => {
    await Promise.all(menu.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const menu = await page.getByRole('listbox').boundingBox();
  assert(
    menu && menu.x >= -1 && menu.x + menu.width <= page.viewportSize().width + 1,
    'Dropdown exceeds viewport',
  );
}
async function choose(page, selector, name) {
  await page.locator(selector).click();
  await menuFits(page);
  await page.getByRole('option', { name, exact: true }).click();
}
async function saved(panel) {
  await panel.getByText('更改已保存', { exact: true }).waitFor();
}
async function fits(page) {
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Page overflows viewport',
  );
  const invalid = await page
    .locator(
      '.settings-workspace input:visible:not([aria-hidden="true"]), .settings-workspace button[role="combobox"]:visible',
    )
    .evaluateAll((els) =>
      els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < -1 || r.right > innerWidth + 1;
        })
        .map((el) => el.id),
    );
  assert.deepEqual(invalid, [], 'Form controls overflow viewport');
}

try {
  const { page, ctx } = await context();
  await page.goto(base + '/settings');
  await page.locator('#ai-model').waitFor();
  assert(
    !requests.some((r) => r.path.includes('site-settings') || r.path.includes('dokploy-settings')),
    'Unvisited settings fetched eagerly',
  );
  await page.locator('#ai-model').fill('gpt-4o-mini');
  let panel = await category(page, 'llm-gateway');
  assert.equal(await page.locator('#llm-gift').inputValue(), '500.0');
  assert(await panel.getByRole('button', { name: '保存更改', exact: true }).isDisabled());
  await panel.getByText('5,000.0 CNY', { exact: true }).waitFor();
  await page.locator('#llm-token').fill('fixture-replacement-token');
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await saved(panel);
  assert.equal(writes.at(-1).body.defaultQuota, 34246574, 'Rounded display changed an untouched quota');
  await page.locator('#llm-gift').fill('500');
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await saved(panel);
  assert.equal(writes.at(-1).body.defaultQuota, 34246575);
  assert.equal(await page.locator('#llm-gift').inputValue(), '500.0');
  assert(await panel.getByRole('button', { name: '保存更改', exact: true }).isDisabled());
  assert.equal(writes.at(-1).body.accessToken, '');
  await category(page, 'platform-ai');
  assert.equal(await page.locator('#ai-model').inputValue(), 'gpt-4o-mini');
  await page.goBack();
  await page.locator('[data-settings-panel="llm-gateway"]:visible').waitFor();
  await page.goForward();
  panel = page.locator('[data-settings-panel="platform-ai"]');
  await panel.getByRole('button', { name: '测试连接' }).click();
  await panel.getByText('连接成功（82ms）', { exact: true }).waitFor();
  await page.locator('#ai-key').fill('fixture-ui-model-key');
  failSave = true;
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.locator('#ai-key').inputValue(), 'fixture-ui-model-key');
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await saved(panel);
  assert.equal(await page.locator('#ai-key').inputValue(), '');
  failTest = true;
  await panel.getByRole('button', { name: '测试连接' }).click();
  await panel.getByRole('alert').filter({ hasText: '服务未响应' }).waitFor();

  panel = await category(page, 'deployment');
  await page.locator('#dokploy-project').click();
  await page.getByRole('option', { name: '研发项目', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#dokploy-env')?.textContent.includes('预发布'));
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await saved(panel);
  assert.equal(writes.at(-1).body.environmentId, 'staging');
  assert.equal(writes.at(-1).body.apiToken, '');

  panel = await category(page, 'folio');
  await choose(page, '#site-tlsMode', 'Cloudflare：自动签发与续期');
  await page.getByText('Cloudflare API Token', { exact: true }).waitFor();
  await choose(page, '#site-tlsMode', '复用 Dokploy 中已有的泛域名证书');
  const beforeValidation = writes.length;
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await panel.getByText('请选择已有泛域名证书', { exact: true }).waitFor();
  assert.equal(writes.length, beforeValidation, 'Missing certificate was submitted');
  assert.equal(await page.locator('#site-certificateId').getAttribute('aria-invalid'), 'true');
  await page.waitForFunction(() => document.activeElement?.id === 'site-certificateId');
  await choose(page, '#site-certificateId', /Folio 泛域名证书/);
  await choose(page, '#site-tlsMode', '复用已有 DNS 证书解析器');
  await choose(page, '#site-resolverName', 'dns-main');
  await choose(page, '#site-tlsMode', '阿里云 DNS：自动签发与续期');
  await panel.getByRole('checkbox', { name: /自动添加/ }).check();
  await page.locator('#site-upstreamPort').fill('3001');
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await saved(panel);
  assert.equal(writes.at(-1).body.upstreamPort, 3001);
  assert.equal(writes.at(-1).body.ossAccessKeySecret, '');
  assert.equal(writes.at(-1).body.autoDns, true);
  await panel.getByRole('button', { name: '检查并启用', exact: true }).click();
  await panel.getByText('正在检查', { exact: true }).waitFor();
  assert(await page.locator('#site-domain').isDisabled());
  assert(await page.locator('#site-tlsMode').isDisabled());
  assert(await page.locator('#site-autoDns').isDisabled());
  await panel.getByText('已启用', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '停用并清理入口', exact: true }).click();
  await panel.getByText('未启用', { exact: true }).waitFor();

  panel = await category(page, 'folio-cdn');
  await choose(page, '#site-credentialSource', '显式复用 AliDNS 凭证（仍需 CDN 权限）');
  assert.equal(await panel.locator('#site-accessKeySecret').count(), 0);
  await choose(page, '#site-credentialSource', '独立 RAM AccessKey');
  await page.locator('#site-scope').click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option');
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '全球但不含中国内地');
  await page.keyboard.press('Enter');
  await panel.getByLabel(/校验回源证书/).check();
  await panel.getByRole('checkbox', { name: /自动管理 Folio DNS/ }).check();
  await panel.getByRole('switch', { name: /启用 CDN/ }).click();
  await panel.getByRole('button', { name: '保存更改', exact: true }).click();
  await saved(panel);
  assert.equal(writes.at(-1).body.verifyOriginCertificate, true);
  assert.equal(writes.at(-1).body.scope, 'overseas');
  assert.equal(writes.at(-1).body.enabled, true);
  assert.equal(writes.at(-1).body.autoDns, true);
  await panel.getByText(/sites.example.com.cdn.example.net/).waitFor();
  await panel.getByRole('button', { name: '重新检查 / 恢复', exact: true }).click();
  await panel.getByText('已接入', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-sonner-toast]'));
  await fits(page);
  await page.screenshot({
    path: join(screenshots, 'settings-desktop-cdn.png'),
    fullPage: true,
  });
  await page.locator('#site-scope').click();
  await menuFits(page);
  await page.screenshot({ path: join(screenshots, 'settings-desktop-cdn-menu.png') });
  await page.keyboard.press('Escape');
  await category(page, 'platform-ai');
  const reads = requests.filter((r) => r.path.endsWith('/cdn')).length;
  await page.waitForTimeout(5200);
  assert.equal(requests.filter((r) => r.path.endsWith('/cdn')).length, reads, 'Hidden CDN kept polling');
  await page
    .locator('[data-settings-panel="platform-ai"]')
    .getByRole('button', { name: '测试连接', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  assert.equal(await page.locator('#ai-url').getAttribute('aria-describedby'), 'ai-url-description');
  const currentCategory = page
    .getByRole('navigation', { name: '设置分类', exact: true })
    .getByRole('link', { name: '平台 AI', exact: true });
  await currentCategory.focus();
  await page.keyboard.press('Tab');
  assert(
    await page
      .getByRole('navigation', { name: '设置分类', exact: true })
      .getByRole('link', { name: 'LLM API 网关', exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press('Enter');
  await page.locator('[data-settings-panel="llm-gateway"] h2').waitFor();
  await category(page, 'platform-ai');
  await page.screenshot({
    path: join(screenshots, 'settings-desktop.png'),
    fullPage: true,
  });
  for (const width of [390, 768, 899, 900, 1024, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of Object.keys(titles)) {
      await category(page, id);
      await fits(page);
    }
    if (width === 390) {
      await page.locator('#site-credentialSource').click();
      await menuFits(page);
      await page.screenshot({ path: join(screenshots, 'settings-mobile-cdn-menu.png') });
      await page.keyboard.press('Escape');
      await category(page, 'folio');
      await choose(page, '#site-tlsMode', '复用 Dokploy 中已有的泛域名证书');
      await page.locator('#site-certificateId').click();
      await menuFits(page);
      await page.screenshot({ path: join(screenshots, 'settings-mobile-certificate-menu.png') });
      await page.keyboard.press('Escape');
      await choose(page, '#site-tlsMode', '阿里云 DNS：自动签发与续期');
      await category(page, 'llm-gateway');
      await page.screenshot({
        path: join(screenshots, 'settings-mobile.png'),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 720, height: 500 });
  await category(page, 'folio');
  await fits(page);
  await page.goto(base + '/settings#static-sites');
  await page.locator('[data-settings-panel="folio"] h2').waitFor();
  assert.equal(
    (await page.locator('#settings-category').innerText()).trim(),
    '基础发布',
    'Legacy Folio link did not select its category',
  );
  await page.goto(base + '/llm-gateway');
  const personalView = page.getByRole('tabpanel', { name: '我的 API Key', exact: true });
  await personalView.getByText('500.0 CNY', { exact: true }).waitFor();
  await personalView.getByRole('cell', { name: '0.1 CNY', exact: true }).waitFor();
  assert.equal(
    await personalView.getByText('0.1 CNY', { exact: true }).count(),
    2,
    'Usage and consumed quota should round to one decimal',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('tab', { name: '成员与额度', exact: true }).click();
  await page.getByRole('cell', { name: '首次赠送 500.0 CNY', exact: true }).waitFor();
  await page.getByRole('button', { name: '首次赠送', exact: true }).click();
  assert.equal(await page.locator('#llm-adjust-amount').inputValue(), '500.0');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(
    writes.at(-1).body.initialQuota,
    34246574,
    'Saving an unchanged personal gift lost quota precision',
  );
  await ctx.close();

  const originalFolio = folio;
  folio = { ...folio, tlsMode: 'certificate' };
  const restricted = await context();
  await restricted.page.goto(base + '/settings?section=folio-cdn');
  await restricted.page.locator('#site-credentialSource').click();
  assert.equal(
    await restricted.page
      .getByRole('option', { name: '显式复用 AliDNS 凭证（仍需 CDN 权限）', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  await restricted.ctx.close();
  folio = originalFolio;

  failLists = true;
  const fallback = await context();
  await fallback.page.goto(base + '/settings?section=deployment');
  await fallback.page.locator('input#dokploy-project').waitFor();
  await fallback.page.locator('#dokploy-project').fill('manual-project');
  await fallback.page.locator('#dokploy-env').fill('manual-environment');
  await fallback.page.getByRole('button', { name: '保存更改', exact: true }).click();
  await fallback.page.getByText('更改已保存', { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.projectId, 'manual-project');
  await fallback.ctx.close();
  failLists = false;
  failRead = true;
  const retry = await context();
  await retry.page.goto(base + '/settings');
  await retry.page.getByText('未能读取设置', { exact: true }).waitFor();
  failRead = false;
  await retry.page.getByRole('button', { name: '重新读取' }).click();
  await retry.page.locator('#ai-url').waitFor();
  await retry.ctx.close();
  const member = await context('member');
  const count = requests.filter((r) => r.role === 'member').length;
  await member.page.goto(base + '/settings?section=folio-cdn');
  await member.page.getByText('只有管理员可以查看和修改系统设置。', { exact: true }).waitFor();
  assert.equal(
    requests.filter((r) => r.role === 'member').length,
    count,
    'Member requested administrator settings',
  );
  await member.ctx.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      viewports: [1440, 1024, 900, 899, 768, 720, 390, 320],
      checked: [
        'categories_and_history',
        'legacy_link',
        'keyboard_navigation_and_field_hints',
        'draft_preservation',
        'lazy_queries',
        'save_success_and_failure',
        'masked_credentials',
        'rounded_money_and_preserved_quota',
        'shadcn_controls_keyboard_validation_disabled_options',
        'connection_tests',
        'deployment_selection_and_fallback',
        'folio_tls_enable_disable',
        'cdn_options_dns_and_retry',
        'hidden_polling_stopped',
        'load_retry',
        'member_permissions',
        'no_horizontal_overflow',
      ],
      schemaCheckedWrites: writes.filter((r) => !r.path.endsWith('/test')).length,
      screenshots,
    }),
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
