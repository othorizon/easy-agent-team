/** Screenshot and interaction evidence using only isolated API fixtures. */
import assert from 'node:assert/strict';

export async function captureFolioUI({ context, platform, published, output, site, user }) {
  const ctx = await context();
  const page = await ctx.newPage();
  const samples = [
    site,
    {
      ...site,
      id: 'report-fixture',
      slug: 'quarterly-report',
      name: '季度产品报告',
      description: '用数据回顾产品进展，让下一步的方向更清晰。',
      access: 'authenticated',
      url: 'https://quarterly-report.example.test',
      updatedAt: '2026-10-15T06:00:00Z',
    },
    {
      ...site,
      id: 'design-fixture',
      slug: 'design-exploration',
      name: '设计探索 · 新的开始',
      description: '收集界面方向与交互原型，在发布前听听团队的声音。',
      access: 'password',
      url: 'https://design-exploration.example.test',
      updatedAt: '2026-10-14T08:00:00Z',
    },
    {
      ...site,
      id: 'draft-fixture',
      slug: 'release-notes',
      name: '下一次产品发布',
      description: '正在准备的发布说明，等待一次正式亮相。',
      currentVersionId: null,
      access: 'authenticated',
      canManage: false,
      url: 'https://release-notes.example.test',
      updatedAt: '2026-10-13T08:00:00Z',
    },
  ];
  let posted;
  await page.route(platform + '/api/sites', async (route) => {
    if (route.request().method() === 'POST') {
      posted = route.request().postDataJSON();
      const created = { ...site, ...posted, id: 'created-fixture', currentVersionId: null };
      samples.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ json: samples });
  });
  const shot = async (target, name, fullPage = true) => {
    await target.evaluate(() => document.fonts.ready);
    assert.equal(
      await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      name + ': horizontal overflow',
    );
    await target.screenshot({ path: `${output}/${name}.png`, fullPage, animations: 'disabled' });
  };
  await page.goto(platform + '/folios');
  await page.getByRole('link', { name: '季度产品报告', exact: true }).waitFor();
  await shot(page, '01-library');
  await page.getByRole('textbox', { name: '搜索 Folio' }).fill('季度');
  assert.equal(await page.locator('.folio-project').count(), 1);
  await page.getByRole('textbox', { name: '搜索 Folio' }).fill('no-matching-folio');
  await page.getByRole('heading', { name: '没有匹配的 Folio' }).waitFor();
  await page.getByRole('textbox', { name: '搜索 Folio' }).fill('');
  await page.getByRole('button', { name: /我管理的/ }).click();
  assert.equal(await page.locator('.folio-project').count(), 3);
  await page.getByRole('button', { name: /全部 Folio/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, '11-library-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '创建 Folio', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name=slug]').fill('product-notes');
  await dialog.locator('input[name=name]').fill('产品发布说明');
  await dialog.locator('textarea[name=description]').fill('记录每一次迭代，与团队分享新的进展。');
  await shot(page, '02-create');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844, 'create dialog reachable on mobile');
  await shot(page, '12-create-mobile');
  await dialog.getByRole('button', { name: '创建 Folio', exact: true }).click();
  await page.getByRole('link', { name: '产品发布说明', exact: true }).waitFor();
  assert.equal(posted.slug, 'product-notes');
  assert.equal(posted.access, 'authenticated');

  const detail = await ctx.newPage();
  await detail.goto(platform + '/folios/demo');
  await detail.getByText('首页标题可以更清楚地表达产品价值。', { exact: true }).waitFor();
  await shot(detail, '03-comments');
  for (const width of [768, 1280]) {
    await detail.setViewportSize({ width, height: 1024 });
    assert.equal(
      await detail.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'detail viewport ' + width,
    );
  }
  await detail.setViewportSize({ width: 390, height: 844 });
  await shot(detail, '13-comments-mobile');
  await detail.setViewportSize({ width: 1440, height: 1000 });
  await detail.getByRole('tab', { name: '发布记录', exact: true }).click();
  await detail.getByRole('row').filter({ hasText: '首次发布' }).waitFor();
  await shot(detail, '04-releases');
  await detail.setViewportSize({ width: 390, height: 844 });
  await shot(detail, '14-releases-mobile');
  await detail.setViewportSize({ width: 1440, height: 1000 });
  await detail.getByRole('tab', { name: '设置', exact: true }).click();
  await detail.getByLabel('谁可以访问').selectOption('password');
  await shot(detail, '05-settings');
  await detail.getByRole('button', { name: '删除 Folio', exact: true }).click();
  await detail.getByRole('alertdialog').waitFor();
  await shot(detail, '07-delete-confirmation');
  await detail.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  await detail.setViewportSize({ width: 390, height: 844 });
  await shot(detail, '15-settings-mobile');
  await detail.setViewportSize({ width: 1440, height: 1000 });
  await detail.getByRole('button', { name: '发布新版', exact: true }).click();
  await detail.getByRole('dialog').waitFor();
  await shot(detail, '06-publish');
  await detail.keyboard.press('Escape');

  const embedded = await ctx.newPage();
  await embedded.goto(published);
  await embedded.locator('#__eat_widget').getByRole('button', { name: '评论', exact: true }).click();
  const frame = embedded.frameLocator('iframe[title="Folio 评论"]');
  await frame.getByText('首页标题可以更清楚地表达产品价值。', { exact: true }).waitFor();
  await shot(embedded, '08-embedded');
  await embedded.setViewportSize({ width: 390, height: 844 });
  await shot(embedded, '16-embedded-mobile');

  const empty = await ctx.newPage();
  await empty.route(platform + '/api/sites', (route) => route.fulfill({ json: [] }));
  await empty.goto(platform + '/folios');
  await empty.getByRole('heading', { name: '你的下一份作品，从这里开始' }).waitFor();
  await shot(empty, '09-empty');

  const admin = await ctx.newPage();
  await admin.addInitScript(
    (user) => localStorage.setItem('eat.user', JSON.stringify({ ...user, role: 'admin' })),
    user,
  );
  await admin.route(platform + '/api/admin/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ json: body });
    if (path.endsWith('/site-settings'))
      return json({
        configured: true,
        enabled: false,
        status: 'disabled',
        domain: 'folios.example.test',
        platformUrl: 'https://eat.example.test',
        ossRegion: 'oss-cn-hangzhou',
        ossBucket: 'eat-folios',
        tlsMode: 'alidns',
        acmeEmail: 'team@example.test',
        certificateId: '',
        resolverName: '',
        platformApplicationId: 'eat-console',
        upstreamUrl: '',
        upstreamPort: 3000,
        gatewayTarget: '203.0.113.10',
        autoDns: true,
        ossAccessKeyIdMasked: 'test****key',
        hasOssSecret: true,
        dnsAccessKeyIdMasked: 'test****dns',
        hasDnsSecret: true,
        checks: [],
        lastError: '',
        updatedAt: site.updatedAt,
      });
    if (path.endsWith('/ai-settings'))
      return json({ configured: false, enabled: false, apiBaseUrl: '', apiKeyMasked: '', model: '' });
    if (path.endsWith('/dokploy-settings'))
      return json({
        configured: false,
        enabled: false,
        apiUrl: '',
        apiTokenMasked: '',
        projectId: '',
        environmentId: '',
        sshKeyId: '',
        domainSuffix: '',
        domainHttps: false,
      });
    return json([]);
  });
  await admin.goto(platform + '/settings');
  await admin.locator('#static-sites input').first().waitFor();
  await admin.waitForFunction(
    () => document.querySelector('#static-sites input')?.value === 'https://eat.example.test',
  );
  await admin
    .locator('#static-sites')
    .screenshot({ path: `${output}/10-admin-settings.png`, animations: 'disabled' });
  const domain = admin.locator('#static-sites input[name="domain"]');
  await domain.fill('draft.folios.example.test');
  await admin.evaluate(() => window.dispatchEvent(new Event('offline')));
  const refetched = admin.waitForResponse((response) => response.url().endsWith('/api/admin/site-settings'));
  await admin.evaluate(() => window.dispatchEvent(new Event('online')));
  await refetched;
  assert.equal(await domain.inputValue(), 'draft.folios.example.test', 'refetch preserves unsaved admin edits');
  await ctx.close();
  console.log(
    'PASS evidence: library search/scope/create, detail at four viewports, dialogs, embedded panel, empty and admin settings',
  );
}
