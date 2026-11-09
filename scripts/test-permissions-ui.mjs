/** Called by the explicit Nest harness, never starts a production server or reads cloud profiles. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

export async function runPermissionsUi({ origin, viewport, actors, api, callbacks, seed, scenario }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const dir = `${scenario === 'membership-options' ? '/tmp/eat-review-ui' : '/tmp/eat-ticket19-ui'}/${viewport.width}`;
  await mkdir(dir, { recursive: true });
  const browser = await chromium.connectOverCDP(process.env.BROWSER_CDP_URL);
  const contexts = [], pages = {}, report = { origin, viewport, browser: browser.version(), checks: [], errors: [], httpErrors: [], consoleErrors: [], browserWarnings: [], requestFailures: [] };
  let seq = 0, current;
  const text = (p, value) => p.getByText(value, { exact: true });
  const button = (p, name) => p.getByRole('button', { name, exact: true });
  const dialog = p => p.getByRole('dialog').last();
  const alert = p => p.getByRole('alertdialog').last();
  const row = (p, name) => p.getByRole('row').filter({ hasText: name }).first();
  const check = async (p, name) => {
    current = p;
    await p.screenshot({ path: `${dir}/${String(++seq).padStart(3, '0')}-${name}.png`, fullPage: true, animations: 'disabled' });
    const bounds = await p.evaluate(() => ({ width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth, overlays: Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter(e => e.getAttribute('data-state') !== 'closed').map(e => { const r = e.getBoundingClientRect(); return { title: e.querySelector('h2')?.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }; }) }));
    if (name === 'mobile-disabled-reason-tip') {
      bounds.tooltip = await p.locator('[data-slot="tooltip-content"]').boundingBox();
      assert.ok(bounds.tooltip && bounds.tooltip.x >= -1 && bounds.tooltip.x + bounds.tooltip.width <= bounds.width + 1, `${name}: tooltip outside viewport ${JSON.stringify(bounds.tooltip)}`);
    }
    report.checks.push({ name, bounds });
    console.log(`QA ${viewport.width}: ${name}`);
    assert.ok(bounds.pageWidth <= bounds.width + 1, `${name}: page overflow ${bounds.pageWidth}/${bounds.width}`);
    for (const o of bounds.overlays) { assert.ok(o.scrollWidth <= o.clientWidth + 1, `${name}: dialog content overflow ${o.scrollWidth}/${o.clientWidth}`); assert.ok(o.left >= -1 && o.right <= bounds.width + 1 && o.top >= -1 && o.bottom <= bounds.height + 1, `${name}: overlay outside viewport ${JSON.stringify(o)}`); }
  };
  const go = async (who, path) => {
    const p = pages[who]; current = p;
    await p.bringToFront(); await p.goto(`${origin}${path}`); await p.waitForLoadState('networkidle');
    return p;
  };
  const close = async p => {
    // Request decisions finish invalidating active queries before they accept close.
    // Retry the real control if the first click lands during that short pending state.
    for (let attempt = 0; attempt < 5; attempt++) {
      const opened = p.locator('[role="dialog"][data-state="open"]');
      if (await opened.count()) await opened.last().getByRole('button', { name: '关闭', exact: true }).last().click();
      try { await p.getByRole('dialog').waitFor({ state: 'hidden', timeout: 1000 }); return; }
      catch (error) { if (attempt === 4) throw error; }
    }
  };
  const confirm = async (p, trigger, name, screenshot) => {
    await trigger.click(); await alert(p).waitFor(); await check(p, screenshot);
    await button(alert(p), name).click(); await alert(p).waitFor({ state: 'hidden' }); await p.waitForLoadState('networkidle');
  };
  const select = async (p, trigger, name) => { await trigger.click(); await p.getByRole('option', { name, exact: true }).click(); };
  const submit = async (p, scope, name) => { await button(scope, name).click(); await p.waitForLoadState('networkidle'); await p.waitForFunction(() => !document.querySelector('[role="dialog"] svg.animate-spin')); };
  const requestId = async type => (await api('GET', `/api/requests?scope=mine&type=${type}&status=pending`, 'member')).body.items[0].id;
  const requestDialog = async (who, id) => { const p = await go(who, `/requests?request=${id}`); await dialog(p).waitFor(); return p; };
  const approve = async (p, name) => { await button(dialog(p), '批准申请').click(); await check(p, `${name}-confirm`); await submit(p, dialog(p), '确认批准'); };
  try {
    for (const who of ['admin', 'owner', 'member', 'other']) {
      const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 600 }); contexts.push(ctx); ctx.setDefaultTimeout(10_000);
      await ctx.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        report.errors.push(`unexpected external request: ${url.origin}`); return route.abort();
      });
      await ctx.addInitScript(({ token, user }) => { localStorage.setItem('eat.token', token); localStorage.setItem('eat.user', JSON.stringify(user)); }, actors[who]);
      const p = await ctx.newPage(); pages[who] = p;
      p.on('pageerror', e => report.errors.push(`${who}: ${e.message}`));
      p.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push({ who, text: msg.text() }); else if (msg.type() === 'warning') report.browserWarnings.push({ who, text: msg.text() }); });
      p.on('requestfailed', request => { const reason = request.failure()?.errorText ?? ''; if (!reason.includes('ERR_ABORTED')) report.requestFailures.push({ who, path: new URL(request.url()).pathname, reason }); });
      p.on('response', r => { if (r.status() >= 400) report.httpErrors.push({ who, status: r.status(), url: new URL(r.url()).pathname }); });
    }
    if (scenario === 'membership-options') {
      const catalog = (await api('POST', `/api/db/assignments/${seed.assignment.id}/access`, 'owner', { open: true })).body;
      const path = `/api/db/access/catalog/${catalog.id}`;
      await api('POST', `${path}/grants`, 'owner', { userId: actors.member.user.id, level: 'read' });
      let p = await go('admin', '/db?tab=access'); await check(p, 'options-consistent');
      assert.equal(await button(row(p, seed.eatDb), '云端不一致').count(), 0);
      await callbacks.membershipOptions(catalog.id, actors.member.user.id, false);
      const before = await callbacks.membershipSnapshot(catalog.id, actors.member.user.id);
      p = await go('admin', '/db?tab=access'); await button(row(p, seed.eatDb), '云端不一致').click();
      await text(dialog(p), '成员选项不一致').waitFor();
      for (const value of ['ADMIN FALSE', 'INHERIT TRUE', 'SET TRUE', 'ADMIN TRUE', 'INHERIT FALSE', 'SET FALSE', seed.manager]) await text(dialog(p), value).waitFor();
      await check(p, 'options-diff');
      assert.deepEqual(await callbacks.membershipSnapshot(catalog.id, actors.member.user.id), before);
      await confirm(p, button(dialog(p), '按 EAT 记录修复'), '修复成员关系', 'options-repair-confirm');
      await dialog(p).waitFor({ state: 'hidden' });
      await button(row(p, seed.eatDb), '云端不一致').waitFor({ state: 'hidden' }); await check(p, 'options-repaired');
      await callbacks.membershipOptions(catalog.id, actors.member.user.id, true);
      p = await go('admin', '/db?tab=access'); await button(row(p, seed.eatDb), '云端不一致').click();
      await text(dialog(p), 'dev').waitFor(); await check(p, 'options-foreign-grantor');
      const foreignBefore = await callbacks.membershipSnapshot(catalog.id, actors.member.user.id);
      await confirm(p, button(dialog(p), '按 EAT 记录修复'), '修复成员关系', 'options-foreign-repair-confirm');
      await p.getByText(/成员选项由 dev 授予/).waitFor(); await check(p, 'options-foreign-repair-failed');
      assert.deepEqual(await callbacks.membershipSnapshot(catalog.id, actors.member.user.id), foreignBefore);
      await callbacks.removeForeignMembership(catalog.id, actors.member.user.id);
      await confirm(p, button(dialog(p), '按 EAT 记录修复'), '修复成员关系', 'options-dba-handled-retry');
      await dialog(p).waitFor({ state: 'hidden' }); await check(p, 'options-retry-complete');
      const final = (await api('GET', '/api/db/access/catalog')).body.find(c => c.id === catalog.id);
      assert.equal(final.drift.consistent, true);
      report.unexpectedHttpErrors = report.httpErrors.filter(e => !(e.status === 409 && e.url === `${path}/repair`));
      report.unexpectedConsoleErrors = report.consoleErrors.filter(e => !/^Failed to load resource: the server responded with a status of 409/.test(e.text));
      assert.deepEqual(report.unexpectedHttpErrors, []); assert.deepEqual(report.unexpectedConsoleErrors, []);
      assert.deepEqual(report.errors, []); assert.deepEqual(report.requestFailures, []); assert.deepEqual(report.browserWarnings, []);
      return;
    }
    // OSS migration: read-only conflict report, persistent partial success, explicit retry and shared Key warnings.
    let p = await go('admin', '/settings?section=oss'); await check(p, 'oss-settings');
    await button(p, '迁移预演').click(); await text(p, '2 个个人身份 · 未发现冲突').or(p.getByText('2 个个人身份 · 存在冲突', { exact: false })).waitFor();
    await check(p, 'oss-preview-conflict');
    const before = callbacks.cloudState();
    await button(dialog(p), '重新预演').click(); await p.waitForLoadState('networkidle'); assert.deepEqual(callbacks.cloudState(), before);
    await confirm(p, button(dialog(p), '执行迁移'), '确认执行迁移', 'oss-migration-confirm');
    await button(dialog(p), '关闭').first().click(); await text(p, '部分失败，写操作已暂停').waitFor(); await check(p, 'oss-migration-partial');
    await api('POST', '/api/oss/spaces', 'member', { name: 'blocked', purpose: 'migration', requestId: crypto.randomUUID() }, 409);
    await callbacks.conflict(false);
    await button(p, '迁移预演').click(); await p.getByText('2 个个人身份 · 未发现冲突', { exact: true }).waitFor();
    await confirm(p, button(dialog(p), '重试未完成迁移'), '确认执行迁移', 'oss-retry-confirm');
    await button(dialog(p), '关闭').first().click(); await text(p, '迁移完成').waitFor(); await check(p, 'oss-migration-complete');
    const migrated = callbacks.cloudState(); assert.ok(migrated.every(u => u.name.startsWith('eat-') && !u.name.startsWith('eat-oss-')));

    // Database first open, settings, invalid schema feedback, external registration and SQL report.
    p = await go('owner', '/db?tab=access'); await check(p, 'db-owner-unopened');
    await button(row(p, seed.eatDb), '开放申请').click(); await check(p, 'db-open-dialog');
    await p.locator('#access-schemas').fill('missing_schema'); await submit(p, dialog(p), '开放申请');
    // A failed open remains a visible, retryable catalog operation.
    if (await dialog(p).count()) await close(p);
    await check(p, 'db-open-failure');
    await button(row(p, seed.eatDb), '配置权限').click(); await p.locator('#access-schemas').fill('public, analytics'); await submit(p, dialog(p), '保存并重新应用');
    await dialog(p).waitFor({ state: 'hidden' }); await text(row(p, seed.eatDb), '开放申请').waitFor();
    const catalog = (await api('GET', '/api/db/access/catalog', 'owner')).body.find(c => c.dbName === seed.eatDb);
    await button(row(p, seed.eatDb), '配置权限').click(); await check(p, 'db-schema-config'); await submit(p, dialog(p), '保存并重新应用');
    await confirm(p, button(row(p, seed.eatDb), '关闭申请'), '确认', 'db-close-confirm');
    await button(row(p, seed.eatDb), '开放申请').click(); await submit(p, dialog(p), '开放申请');
    await button(row(p, seed.eatDb), '重新应用授权').click(); await p.waitForLoadState('networkidle');
    p = await go('admin', '/db?tab=instances'); await check(p, 'db-instances');
    assert.equal(await button(row(p, 'qa19-mysql'), '登记外部库').count(), 0);
    await button(row(p, 'qa19-postgres'), '管理凭证').click(); await check(p, 'db-management-credentials'); await close(p);
    await button(row(p, 'qa19-postgres'), '登记外部库').click(); await check(p, 'db-register-external');
    await submit(p, dialog(p), '校验并登记'); await check(p, 'db-external-validation');
    await p.locator('#external-name').fill(seed.extDb);
    await select(p, dialog(p).getByRole('combobox'), 'QA Owner（owner@qa19.test）');
    await p.locator('#external-creator').fill(seed.externalOwner); await submit(p, dialog(p), '校验并登记');
    await p.getByRole('heading', { name: '外部库登记结果' }).waitFor(); await check(p, 'db-external-report');
    await button(dialog(p), '完成').click();
    const ext = (await api('GET', '/api/db/access/catalog')).body.find(c => c.dbName === seed.extDb);
    await api('POST', `/api/db/access/catalog/${ext.id}/access`, 'owner', { open: true });
    p = await go('admin', '/db?tab=access'); await button(row(p, seed.extDb), '权限检查').click();
    await p.getByText('已有角色的有效权限与继承', { exact: true }).click(); await check(p, 'db-external-existing-permissions'); await close(p);

    // Actual member request → Owner decision → personal password reveal, hide, reset, upgrade and direct level change.
    p = await go('member', '/db?tab=access'); assert.equal(await button(p, '配置权限').count(), 0); await check(p, 'db-member-catalog');
    await button(row(p, seed.eatDb), '申请权限').click(); await check(p, 'db-request-dialog');
    await submit(p, dialog(p), '提交申请'); await check(p, 'db-request-validation');
    await p.locator('#request-db-reason').fill('QA 季度分析'); await submit(p, dialog(p), '提交申请'); await dialog(p).waitFor({ state: 'hidden' });
    let dbRequest = await requestId('db-access'); p = await requestDialog('owner', dbRequest); await check(p, 'requests-db-owner'); await approve(p, 'requests-db-owner'); await close(p);
    p = await go('member', '/db?tab=access'); await button(p, '个人凭证').click(); await check(p, 'db-personal-credentials-hidden');
    await button(dialog(p), '查看个人凭证').click(); await p.getByText(`eat-${actors.member.user.id}`, { exact: true }).waitFor(); await check(p, 'db-personal-credentials-visible');
    await button(dialog(p), '隐藏个人凭证').click();
    await confirm(p, button(dialog(p), '重置个人密码'), '重置个人密码', 'db-password-reset-confirm'); await close(p);
    await button(p, '申请读写').click(); await check(p, 'db-upgrade-dialog'); await p.locator('#request-db-reason').fill('QA 更新报表数据'); await submit(p, dialog(p), '提交申请');
    p = await go('owner', '/db?tab=access'); await button(row(p, seed.eatDb), '授予权限').click(); await check(p, 'db-direct-grant');
    await select(p, p.locator('#access-user'), 'QA 成员（member@qa19.test）'); await select(p, p.locator('#access-level'), '读写'); await submit(p, dialog(p), '授予权限');
    await button(row(p, seed.eatDb), '授予权限').click(); await select(p, p.locator('#access-user'), 'QA 成员（member@qa19.test）'); await submit(p, dialog(p), '授予权限');
    await callbacks.driftDb(catalog.id, actors.member.user.id);
    p = await go('admin', '/db?tab=access'); await button(row(p, seed.eatDb), '云端不一致').click(); await check(p, 'db-drift-report');
    await confirm(p, button(dialog(p), '按 EAT 记录修复'), '修复成员关系', 'db-drift-repair-confirm'); await dialog(p).waitFor({ state: 'hidden' });
    const memberDbGrant = (await api('GET', '/api/db/access/grants', 'member')).body.find(g => g.catalogId === catalog.id); assert.equal(memberDbGrant.state, 'active'); assert.equal(memberDbGrant.level, 'read');
    await api('POST', `/api/db/access/catalog/${catalog.id}/credentials`, 'admin', undefined, 403);
    p = await go('owner', '/db?tab=access'); await button(p, '撤销').first().click(); await check(p, 'db-revoke-dialog'); await close(p);

    // Cloud connections: new/edit validation and mask, plus same policy name in a second cloud account.
    p = await go('admin', '/settings?section=aliyun'); await button(p, '新建接入').click(); await check(p, 'aliyun-new-connection');
    await submit(p, dialog(p), '校验并保存'); await check(p, 'aliyun-connection-validation');
    await p.getByLabel('接入名称', { exact: true }).fill('qa19-cloud'); await p.getByLabel('管理 AccessKey ID', { exact: true }).fill(seed.management.accessKeyId); await p.getByLabel('管理 AccessKey Secret', { exact: true }).fill(seed.management.accessKeySecret); await p.getByLabel('默认地域（可选）').fill('cn-beijing'); await submit(p, dialog(p), '校验并保存'); await dialog(p).waitFor({ state: 'hidden' });
    await button(row(p, 'qa19-cloud'), '编辑').click(); assert.equal(await p.getByLabel('管理 AccessKey Secret', { exact: true }).inputValue(), ''); await check(p, 'aliyun-edit-masked'); await close(p);
    const one = (await api('GET', '/api/aliyun/connections')).body[0];
    const two = (await api('POST', '/api/aliyun/connections', 'admin', { name: 'qa19-second', ...seed.cloudCredentials2 })).body;
    for (const c of [one, two]) await api('POST', `/api/aliyun/connections/${c.id}/refresh`);
    const points = (await api('GET', '/api/aliyun/permissions/manage')).body;
    const point = points.find(v => v.connectionId === one.id && v.policyName === 'eat-perm-report');
    for (const pt of points) await api('PATCH', `/api/aliyun/permissions/${pt.id}`, 'admin', { open: true, purpose: '季度报表', dataScope: '指定报表对象', ownerId: actors.owner.user.id });
    p = await go('admin', '/aliyun?tab=manage'); await check(p, 'aliyun-management');
    await button(row(p, 'eat-perm-report'), '开放设置').click(); await check(p, 'aliyun-open-settings'); await close(p);
    await button(row(p, 'eat-perm-' + 'x'.repeat(110)), '开放设置').click(); await check(p, 'aliyun-long-policy-settings'); await close(p);
    await button(row(p, 'eat-perm-extra'), '直接授予').click(); await check(p, 'aliyun-direct-grant'); await select(p, p.locator('#aliyun-grant-user'), 'QA 其他成员（other@qa19.test）'); await submit(p, dialog(p), '授予权限'); await dialog(p).waitFor({ state: 'hidden' });
    await button(p, '撤销').first().click(); await check(p, 'aliyun-revoke-dialog'); await p.locator('#aliyun-revoke-reason').fill('QA 临时授权已完成'); await submit(p, dialog(p), '撤销授权');
    callbacks.fault('ListPolicies', 'AccessDenied'); await button(p, '刷新目录').click(); await p.waitForLoadState('networkidle'); await check(p, 'aliyun-refresh-error'); callbacks.fault('ListPolicies'); await button(p, '刷新目录').click(); await p.waitForLoadState('networkidle');
    p = await go('member', '/aliyun?tab=catalog'); assert.equal(await p.getByRole('tab', { name: '管理', exact: true }).count(), 0); await check(p, 'aliyun-member-catalog');
    await button(row(p, 'eat-perm-report'), '申请').click(); await check(p, 'aliyun-request-dialog'); await submit(p, dialog(p), '提交申请'); await check(p, 'aliyun-request-validation'); await p.locator('#aliyun-request-reason').fill('QA 云端报表分析'); await submit(p, dialog(p), '提交申请');
    let cloudRequest = await requestId('aliyun');
    p = await requestDialog('member', cloudRequest); assert.equal(await button(dialog(p), '展开策略原文（从 RAM 现取）').count(), 0); await check(p, 'requests-aliyun-member'); await close(p);
    await api('POST', `/api/aliyun/connections/${one.id}/status`, 'admin', { status: 'paused' });
    p = await go('member', '/aliyun?tab=catalog'); assert.equal(await button(row(p, 'eat-perm-extra'), '申请').isDisabled(), true); await check(p, 'aliyun-member-paused-catalog');
    if (viewport.width < 600) { await row(p, 'eat-perm-extra').locator('span[tabindex="0"]').last().tap(); await p.getByRole('tooltip').waitFor(); await check(p, 'mobile-disabled-reason-tip'); await p.keyboard.press('Escape'); }
    p = await requestDialog('owner', cloudRequest); assert.equal(await button(dialog(p), '批准申请').isDisabled(), true); await check(p, 'requests-aliyun-paused');
    await button(dialog(p), '展开策略原文（从 RAM 现取）').click(); await dialog(p).locator('pre').waitFor(); assert.match(await dialog(p).locator('pre').innerText(), /oss:GetObject/); await check(p, 'requests-current-policy-document'); await close(p);
    await api('POST', `/api/aliyun/connections/${one.id}/status`, 'admin', { status: 'enabled' });
    callbacks.fault('AttachPolicyToUser', 'LimitExceeded.User.Policy');
    p = await requestDialog('owner', cloudRequest); await approve(p, 'requests-cloud'); await check(p, 'requests-approved-execution-failed'); await close(p);
    callbacks.fault('AttachPolicyToUser'); p = await go('owner', '/aliyun?tab=manage'); await button(p, '重试').first().click(); await p.waitForLoadState('networkidle'); await check(p, 'aliyun-grant-retried');
    p = await go('member', '/aliyun?tab=mine'); await check(p, 'aliyun-mine-with-oss'); assert.ok(await p.getByRole('link', { name: 'QA member 空间' }).count());
    await button(p, '查看 / 领取 Key').first().click(); await text(p, 'AccessKey Secret').waitFor(); await check(p, 'aliyun-key-visible'); await button(p, '隐藏 Key').first().click();
    await confirm(p, button(p, '重置 Key').first(), '重置 Key', 'aliyun-shared-key-reset');
    const cloudKey = await api('POST', `/api/aliyun/connections/${one.id}/credentials`, 'member'); const ossKey = await api('POST', '/api/oss/me/credentials', 'member'); assert.equal(cloudKey.body.accessKeyId, ossKey.body.accessKeyId); assert.equal(cloudKey.headers['cache-control'], 'no-store');
    await callbacks.driftCloud(actors.member.user.id);
    p = await go('admin', '/aliyun?tab=manage'); await check(p, 'aliyun-drift-report');
    await confirm(p, button(p, '按 EAT 记录修复').first(), '修复绑定', 'aliyun-drift-repair');
    // Safety-sync failure is visible without changing the member's active session.
    await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'admin', { userId: actors.other.user.id, level: 'read' });
    await callbacks.dbStatusFailure(true); callbacks.fault('UpdateAccessKey', 'AccessDenied');
    await api('PATCH', `/api/users/${actors.other.user.id}`, 'admin', { status: 'disabled' });
    p = await go('admin', '/users'); await text(p, '数据库同步待完成').waitFor(); await text(p, '阿里云同步待完成').waitFor(); await check(p, 'users-safety-sync-pending');
    await callbacks.dbStatusFailure(false); callbacks.fault('UpdateAccessKey'); await api('PATCH', `/api/users/${actors.other.user.id}`, 'admin', { status: 'active' });
    // Owner self-request, rejection/resubmission, withdrawal and stopped Owner notices.
    const secondPoint = points.find(v => v.connectionId === two.id && v.policyName === 'eat-perm-report');
    await api('POST', `/api/aliyun/permissions/${secondPoint.id}/requests`, 'owner', { reason: 'Owner 本人临时操作' });
    await api('POST', `/api/aliyun/permissions/${secondPoint.id}/requests`, 'member', { reason: 'QA 待办驳回' });
    cloudRequest = await requestId('aliyun'); p = await requestDialog('owner', cloudRequest); await button(dialog(p), '驳回').click(); await p.getByLabel('驳回原因').fill('请限定数据范围'); await check(p, 'requests-reject'); await submit(p, dialog(p), '确认驳回'); await close(p);
    p = await requestDialog('member', cloudRequest); await button(dialog(p), '重新申请').click(); await p.getByLabel('申请说明').fill('限定为报表对象'); await check(p, 'requests-resubmit'); await submit(p, dialog(p), '确认提交'); await close(p);
    cloudRequest = await requestId('aliyun'); p = await requestDialog('member', cloudRequest); await button(dialog(p), '撤回申请').click(); await check(p, 'requests-withdraw'); await submit(p, dialog(p), '确认提交'); await close(p);
    const vanishedPoint = points.find(v => v.connectionId === two.id && v.policyName === 'eat-perm-extra');
    const vanishedRequest = (await api('POST', `/api/aliyun/permissions/${vanishedPoint.id}/requests`, 'member', { reason: '云端删除失效验证' })).body.requestId;
    await callbacks.deleteSecondExtra(); await api('POST', `/api/aliyun/connections/${two.id}/refresh`);
    assert.equal((await api('GET', `/api/requests/${vanishedRequest}`, 'member')).body.request.status, 'invalid');
    p = await go('admin', '/aliyun?tab=manage'); await text(p, '云端已删除').filter({ visible: true }).first().waitFor(); await check(p, 'aliyun-cloud-deleted');
    p = await go('member', '/requests?tab=mine'); await p.getByRole('tab', { name: '我发起的', exact: true }).click(); await check(p, 'requests-mine-tab');
    p = await go('admin', '/requests?tab=history'); await p.getByRole('tab', { name: '已处理', exact: true }).click(); await check(p, 'requests-history-tab');
    await pages.owner.close();
    await api('PATCH', `/api/users/${actors.owner.user.id}`, 'admin', { status: 'disabled' });
    p = await go('admin', `/db/${seed.assignment.id}`); await text(p, 'Owner 已停用').waitFor(); await check(p, 'db-owner-disabled-detail');
    p = await go('admin', '/db?tab=all'); await check(p, 'db-owner-disabled-list');
    p = await go('member', '/aliyun?tab=catalog'); await p.getByText(/Owner 已停用/).first().waitFor(); await check(p, 'aliyun-owner-disabled');
    await api('PATCH', `/api/users/${actors.owner.user.id}`, 'admin', { status: 'active' }); Object.assign(actors.owner, (await api('POST', '/api/auth/login', 'owner', { email: 'owner@qa19.test', password: 'qa-password-19' })).body);
    // Explicit member relinquish and management revoke; cloud cleanup fails, then retries with retained credentials.
    p = await go('member', '/aliyun?tab=mine'); await confirm(p, button(p, '放弃').first(), '放弃授权', 'aliyun-relinquish');
    const ownerGrant = (await api('GET', '/api/aliyun/grants', 'owner')).body.grants.find(g => g.permissionId === secondPoint.id);
    await api('POST', `/api/aliyun/grants/${ownerGrant.id}/revoke`, 'admin', {});
    p = await go('admin', '/settings?section=aliyun');
    callbacks.failCleanup(true); await confirm(p, button(row(p, 'qa19-second'), '删除'), '确认删除接入', 'aliyun-delete-confirm'); await text(p, '清理失败').waitFor(); await check(p, 'aliyun-cleanup-failed');
    callbacks.failCleanup(false); await confirm(p, button(row(p, 'qa19-second'), '重试清理'), '重试清理', 'aliyun-cleanup-retry'); await row(p, 'qa19-second').waitFor({ state: 'hidden' });
    // External ownership blocker and retry, instance deletion confirmation.
    await callbacks.blockExternalDelete(ext.id, true);
    p = await go('admin', '/db?tab=access'); await confirm(p, button(row(p, seed.extDb), '删除登记'), '删除登记', 'db-external-delete-confirm'); await check(p, 'db-external-ownership-blocker');
    await callbacks.blockExternalDelete(ext.id, false);
    await confirm(p, button(row(p, seed.extDb), '删除登记'), '删除登记', 'db-external-delete-retry'); await row(p, seed.extDb).waitFor({ state: 'hidden' });
    p = await go('admin', '/db?tab=instances'); await button(row(p, 'qa19-postgres'), '删除').click(); await check(p, 'db-instance-delete-confirm'); await button(alert(p), '取消').click();
    p = await go('member', '/db?tab=access'); await confirm(p, button(p, '放弃').first(), '放弃授权', 'db-relinquish');
    p = await go('member', `/oss/${seed.spaces.member.id}`); await check(p, 'oss-space-detail');
    await button(p, '查看 AK/SK').click(); await dialog(p).waitFor(); await check(p, 'oss-credentials-visible'); await close(p);
    await button(p, '重置凭证').click(); await check(p, 'oss-shared-key-warning'); await button(alert(p), '取消').click();
    p = await go('member', '/settings?section=aliyun'); assert.equal(await button(p, '新建接入').count(), 0); await check(p, 'member-settings-boundary');
    if (viewport.width === 390) { await button(p, '打开导航').click(); await check(p, 'mobile-navigation'); await p.keyboard.press('Escape'); }
    report.unexpectedHttpErrors = report.httpErrors.filter(e => !(e.status === 503 && e.url.endsWith('/refresh')) && !(e.status === 409 && e.url.startsWith('/api/db/access/catalog/')));
    assert.deepEqual(report.unexpectedHttpErrors, []);
    report.unexpectedConsoleErrors = report.consoleErrors.filter(e => !/^Failed to load resource: the server responded with a status of (503|409)/.test(e.text));
    assert.deepEqual(report.unexpectedConsoleErrors, []);
    assert.deepEqual(report.requestFailures, []);
    assert.deepEqual(report.errors, []);
  } catch (e) {
    report.errors.push(e.stack ?? String(e));
    if (current) await current.screenshot({ path: `${dir}/FAILED.png`, fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2));
    for (const ctx of contexts) await ctx.close();
    await browser.close();
  }
}
