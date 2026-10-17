/** Browser contract tests with isolated HTTP API substitutes. No cloud or production writes. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
const base = process.env.EAT_UI_URL ?? 'http://127.0.0.1:5173';
const output = process.env.EAT_UI_SHOTS ?? '/tmp/eat-folio-cdn-ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
let state = {
  enabled: false,
  scope: 'overseas',
  credentialSource: 'independent',
  autoDns: false,
  cacheRefresh: { pending: 0, lastCompletedAt: null, lastError: '', retryAt: null },
  status: 'disabled',
  connected: false,
  accessKeyIdMasked: '',
  hasSecret: false,
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
  updatedAt: null,
};
const folio = {
  configured: true,
  enabled: true,
  status: 'enabled',
  domain: 'sites.example.com',
  platformUrl: 'https://eat.example.test',
  ossRegion: 'oss-cn-hangzhou',
  ossBucket: 'example-folio-bucket',
  ossAccessKeyIdMasked: 'test****key',
  hasOssSecret: true,
  tlsMode: 'alidns',
  acmeEmail: 'admin@example.test',
  dnsAccessKeyIdMasked: 'test****dns',
  hasDnsSecret: true,
  certificateId: '',
  resolverName: '',
  platformApplicationId: 'example-app',
  upstreamUrl: '',
  upstreamPort: 3000,
  gatewayTarget: '203.0.113.10',
  autoDns: false,
  checks: [],
  lastError: '',
  updatedAt: new Date().toISOString(),
};
const user = { id: 'admin-id', name: 'CDN Test Admin', email: 'admin@example.test', role: 'admin' };
let writes = 0,
  retries = 0;
const errors = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript((user) => {
      localStorage.setItem('eat.token', 'isolated-ui-token');
      localStorage.setItem('eat.user', JSON.stringify(user));
    }, user);
    await context.route('**/api/**', async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      let body = {};
      if (path === '/api/admin/site-settings/cdn') {
        if (req.method() === 'PUT') {
          const dto = req.postDataJSON();
          writes++;
          assert.equal(dto.accessKeySecret, 'ui-test-secret');
          state = {
            ...state,
            enabled: dto.enabled,
            scope: dto.scope,
            credentialSource: dto.credentialSource,
            autoDns: dto.autoDns,
            status: 'checking',
            connected: false,
            accessKeyIdMasked: 'ui-t****-key',
            hasSecret: true,
            phase: '检查服务和权限',
            updatedAt: new Date().toISOString(),
          };
        }
        body = state;
      } else if (path === '/api/admin/site-settings/cdn/retry') {
        retries++;
        state = {
          ...state,
          status: 'enabled',
          connected: true,
          lastError: '',
          phase: 'CDN 已接入；公开及密码 Folio 静态资源可缓存',
          dnsInstructions: [],
          certificateExpiresAt: '2026-12-17T00:00:00Z',
          certificateUploaded: true,
          certificateSyncedAt: new Date().toISOString(),
          cacheRefresh: { pending: 0, lastCompletedAt: new Date().toISOString(), lastError: '', retryAt: null },
        };
        body = state;
      } else if (path === '/api/admin/site-settings') body = folio;
      else if (path === '/api/auth/me') body = user;
      else if (path === '/api/admin/dokploy-settings')
        body = {
          enabled: false,
          configured: false,
          apiUrl: '',
          apiTokenMasked: '',
          provisionProjectId: '',
          provisionEnvironmentId: '',
          provisionSshKeyId: '',
          domainSuffix: '',
          domainHttps: true,
        };
      else if (path === '/api/admin/ai-settings')
        body = { enabled: false, configured: false, baseUrl: '', model: '', apiKeyMasked: '' };
      else if (path === '/api/sites/capability')
        body = { enabled: true, status: 'enabled', domain: folio.domain };
      else if (path.includes('applications') || path.includes('projects') || path.includes('ssh-keys'))
        body = [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/settings');
    const section = page.getByRole('region', { name: '阿里云 CDN' });
    await section.waitFor();
    await section.getByText('改密码、改权限和删除会异步清理 CDN 缓存', { exact: false }).waitFor();
    assert.equal(await section.getByText('缓存维护：', { exact: false }).count(), 1);
    if (viewport.width === 1440) {
      await section.getByText('CDN 证书同步：尚未上传', { exact: true }).waitFor();
      await section.getByRole('checkbox', { name: '启用 CDN' }).check();
      await section.getByLabel('CDN 加速区域').selectOption('global');
      await section.getByLabel('CDN AccessKey ID', { exact: true }).fill('ui-test-key');
      await section.getByLabel('CDN AccessKey Secret', { exact: true }).fill('ui-test-secret');
      await section.getByRole('button', { name: '保存 CDN 配置' }).click();
      await section.getByText('配置意愿：开启 · 实际接入：未确认接入').waitFor();
      assert.equal(await section.getByLabel('CDN AccessKey Secret', { exact: true }).inputValue(), '');
      await section.screenshot({ path: output + '/checking-desktop.png' });
      state = {
        ...state,
        status: 'awaiting_dns',
        phase: '等待 DNS 验证',
        lastError: '验证 TXT 尚未生效，请核对 DNS 权限',
        dnsInstructions: [{ name: 'verification.example.com', type: 'TXT', value: 'verify_isolated_test' }],
      };
      await page.reload();
      await section.getByText('验证 TXT 尚未生效，请核对 DNS 权限').waitFor();
      await section
        .getByText('请在 DNS 服务商完成以下记录后点击“重新检查 / 恢复”：', { exact: true })
        .waitFor();
      await section.screenshot({ path: output + '/recovery-desktop.png' });
      state = { ...state, autoDns: true };
      await page.reload();
      await section.getByText('系统将自动处理以下 DNS 记录，等待解析生效后继续；无需手动重复添加。').waitFor();
      assert.equal(
        await section.getByText('请在 DNS 服务商完成以下记录后点击“重新检查 / 恢复”：', { exact: true }).count(),
        0,
      );
      state = {
        ...state,
        status: 'failed',
        phase: '验证 CDN HTTPS、回源和公开静态缓存命中',
        lastError: 'CDN 接入检查失败：HTTP 502，请检查 HTTPS 回源地址、Host/SNI 与源站证书；CDN 错误类型：TLS / 证书握手',
        certificateUploaded: true,
        dnsInstructions: [],
      };
      await page.reload();
      await section.getByText('CDN 证书同步：已上传，等待边缘验证', { exact: true }).waitFor();
      await section.getByText(state.lastError, { exact: true }).waitFor();
      await section.screenshot({ path: output + '/edge-verification-desktop.png' });
      state = { ...state, cacheRefresh: { pending: 3, lastCompletedAt: null,
        lastError: 'CDN 缓存刷新失败：RAM 权限不足，将自动重试', retryAt: new Date().toISOString() } };
      await page.reload();
      await section.getByText('缓存维护：刷新未完成（3 个目录）', { exact: true }).waitFor();
      await section.getByText(state.cacheRefresh.lastError, { exact: true }).waitFor();
      await section.screenshot({ path: output + '/cache-refresh-recovery-desktop.png' });
      await section.getByRole('button', { name: '重新检查 / 恢复' }).click();
      await section.getByText('配置意愿：开启 · 实际接入：已验证接入').waitFor();
      await section.getByText('缓存维护：无待处理任务', { exact: true }).waitFor();
      await section.getByText('最近刷新完成：', { exact: false }).waitFor();
      await section.screenshot({ path: output + '/enabled-desktop.png' });
    } else {
      state = {
        ...state,
        status: 'failed',
        connected: false,
        lastError: '证书同步失败，将自动重试',
        certificateSyncError: 'RAM 权限不足，请检查证书同步权限',
        cacheRefresh: { pending: 1, lastCompletedAt: null, lastError: '缓存刷新失败，将自动重试', retryAt: new Date().toISOString() },
      };
      await page.reload();
      await section.getByText('证书同步失败，将自动重试', { exact: true }).waitFor();
      await section.getByText('缓存维护：刷新未完成（1 个目录）', { exact: true }).waitFor();
      await section.getByText('缓存刷新失败，将自动重试', { exact: true }).waitFor();
      await section.scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        'mobile horizontal overflow',
      );
      await section.screenshot({ path: output + '/failure-mobile.png' });
      await section.getByRole('button', { name: '重新检查 / 恢复' }).click();
      await section.getByText('配置意愿：开启 · 实际接入：已验证接入').waitFor();
    }
    await context.close();
  }
  assert.equal(writes, 1);
  assert.equal(retries, 2);
  assert.deepEqual(errors, []);
  console.log(
    'CDN browser checks passed: origin cache semantics, configuration, pending state, refresh progress/failure/recovery, DNS guidance, upload versus edge verification, recovery, credential clearing, mobile layout',
  );
} finally {
  await browser.close();
}
