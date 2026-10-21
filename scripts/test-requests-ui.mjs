import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
const dist = resolve('apps/web/dist'),
  shots = process.env.EAT_UI_SHOTS || '/workspace/artifacts/eat-requests';
mkdirSync(shots, { recursive: true });
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path.startsWith('/assets/') ? join(dist, path) : join(dist, 'index.html');
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
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
const errors = [];
const day = 86400000,
  now = Date.now();
function makeRow(i, type, status = 'pending', extra = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    type,
    sourceId: `source-${i}`,
    resourceId: `resource-${i}`,
    requesterId: 'lin',
    requesterName: '林小满',
    targetName: {
      env: '预发布环境 · 网关配置',
      mcp: '团队知识检索 MCP',
      db: '业务报表数据库',
      oss: '产品素材与附件',
      app: '团队知识库',
    }[type],
    resourceUrl: '/requests',
    reason: '用于团队内部功能验证与协作，请开放相应权限。',
    status,
    rejectionReason: status === 'rejected' ? '请补充具体使用环境和预计使用时长，再提交申请。' : null,
    closedReason: null,
    execution: null,
    executionError: null,
    decidedByName: status === 'pending' ? null : '管理员',
    createdAt: new Date(now - 2 * day).toISOString(),
    decidedAt: status === 'pending' ? null : new Date(now - day).toISOString(),
    round: 1,
    latest: true,
    details:
      type === 'env'
        ? { keys: ['GATEWAY_URL', 'API_TOKEN'] }
        : type === 'app'
          ? { slug: 'demo', repoVersion: 1, repoUrl: 'https://github.com/eat-org/knowledge', branch: 'main' }
          : {},
    notificationError: null,
    ...extra,
  };
}
async function fixture(width, role = 'admin') {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const user = {
    id: 'lin',
    name: '林小满',
    email: 'lin@example.test',
    role,
    status: 'active',
    bio: '',
    allowHelp: true,
  };
  await context.addInitScript((u) => {
    localStorage.setItem('eat.token', 'fixture-token');
    localStorage.setItem('eat.user', JSON.stringify(u));
  }, user);
  let rows = [
    ...['env', 'mcp', 'db', 'oss', 'app'].map((t, i) =>
      makeRow(i + 1, t, 'pending', { requesterName: ['陈予安', '林小满', '周明', '林小满', '江语'][i] }),
    ),
    makeRow(6, 'db', 'rejected'),
    makeRow(7, 'oss', 'approved', { execution: 'failed', executionError: '云端暂不可用，请在资源详情重试' }),
    makeRow(8, 'env', 'approved'),
    makeRow(9, 'mcp', 'withdrawn', { closedReason: '申请人主动撤回' }),
  ];
  let offline = false,
    failDecision = false;
  const writes = [];
  const info = (r) => ({
    ...r,
    canApprove: role === 'admin' && r.status === 'pending',
    canWithdraw: r.status === 'pending',
    canResubmit: r.latest && ['rejected', 'withdrawn'].includes(r.status),
    canRemind: r.status === 'pending',
  });
  const detail = (id) => {
    const r = rows.find((x) => x.id === id);
    return {
      request: info(r),
      rounds: rows
        .filter((x) => x.sourceId === r.sourceId)
        .sort((a, b) => b.round - a.round)
        .map(info),
    };
  };
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method(),
      body = req.postData() ? JSON.parse(req.postData()) : {};
    let data = {},
      status = 200;
    if (path === '/api/account/onboarding') data = { required: false };
    else if (path === '/api/apps/demo/github')
      data = {
        enabled: true,
        organization: 'eat-org',
        scope: 'organization',
        repository: 'eat-org/knowledge',
        ownerLogin: 'jiangyu',
        ownerRole: 'admin',
        ownerIsOrgOwner: false,
        checkedAt: new Date(now).toISOString(),
        members: [],
      };
    else if (path === '/api/requests') {
      if (offline) {
        status = 503;
        data = { message: '申请服务暂不可用' };
      } else {
        const q = url.searchParams;
        let filtered = rows.filter((r) => r.latest);
        if (q.get('scope') === 'inbox')
          filtered = role === 'admin' ? filtered.filter((r) => r.status === 'pending') : [];
        if (q.get('scope') === 'history') filtered = filtered.filter((r) => r.status !== 'pending');
        if (q.get('type')) filtered = filtered.filter((r) => r.type === q.get('type'));
        if (q.get('status') === 'ongoing')
          filtered = filtered.filter((r) => r.status === 'pending' || r.execution === 'failed');
        else if (q.get('status') && q.get('status') !== 'all')
          filtered = filtered.filter((r) => r.status === q.get('status'));
        if (q.get('q')) filtered = filtered.filter((r) => r.targetName.includes(q.get('q')));
        const page = Number(q.get('page') || 1),
          size = Number(q.get('pageSize') || 20);
        data = {
          items: filtered.slice((page - 1) * size, page * size).map(info),
          total: filtered.length,
          page,
          pageSize: size,
          pendingCount: role === 'admin' ? rows.filter((r) => r.status === 'pending').length : 0,
        };
      }
    } else if (path.startsWith('/api/requests/')) {
      const id = path.split('/')[3],
        r = rows.find((x) => x.id === id),
        action = path.split('/')[4];
      if (method === 'POST') {
        writes.push({ id, action, body });
        if (failDecision) {
          status = 409;
          data = { message: '申请已被他人处理，请刷新' };
        } else if (action === 'decision' || action === 'notification-approve') {
          r.status = action === 'notification-approve' ? 'approved' : body.decision;
          r.rejectionReason = body.reason || null;
          r.decidedByName = '林小满';
          r.decidedAt = new Date().toISOString();
          data = detail(id);
        } else if (action === 'resubmit') {
          r.latest = false;
          const next = {
            ...r,
            id: `00000000-0000-4000-8000-000000000099`,
            round: r.round + 1,
            latest: true,
            status: 'pending',
            reason: body.reason,
            rejectionReason: null,
            decidedByName: null,
            decidedAt: null,
          };
          rows.push(next);
          data = detail(next.id);
        } else if (action === 'withdraw') {
          r.status = 'withdrawn';
          r.closedReason = '申请人主动撤回';
          data = detail(id);
        } else data = detail(id);
      } else data = detail(id);
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return { page, context, writes, setOffline: (v) => (offline = v), setFail: (v) => (failDecision = v) };
}
try {
  for (const width of [1280, 390]) {
    const f = await fixture(width),
      p = f.page;
    await p.goto(base + '/requests');
    await p.getByRole('list', { name: '申请列表' }).getByRole('button').first().waitFor();
    assert.equal(await p.getByRole('list', { name: '申请列表' }).getByRole('button').count(), 5);
    await p.screenshot({ path: join(shots, `inbox-${width}.png`), fullPage: true });
    await p.getByRole('button').filter({ hasText: '团队知识库' }).click();
    const dialog = p.getByRole('dialog');
    await dialog.getByText('EAT 组织仓库').waitFor();
    await p.screenshot({ path: join(shots, `app-review-${width}.png`), fullPage: false });
    await dialog.getByRole('button', { name: '驳回', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: '确认驳回' }).isDisabled(), true);
    await dialog.getByRole('textbox', { name: '驳回原因' }).fill('请确认仓库的部署内容，并补充用途说明。');
    await p.screenshot({ path: join(shots, `reject-${width}.png`), fullPage: false });
    await dialog.getByRole('button', { name: '确认驳回' }).click();
    await dialog.getByText('驳回原因', { exact: true }).waitFor();
    assert.equal(f.writes.at(-1).body.reason, '请确认仓库的部署内容，并补充用途说明。');
    await p.keyboard.press('Escape');
    await p.getByRole('tab', { name: '已处理', exact: true }).click();
    await p.getByRole('button').filter({ hasText: '团队知识库' }).waitFor();
    assert.equal(new URL(p.url()).searchParams.get('tab'), 'history');
    await p.reload();
    await p.getByRole('button').filter({ hasText: '团队知识库' }).waitFor();
    await p.screenshot({ path: join(shots, `history-${width}.png`), fullPage: true });
    await p.getByRole('tab', { name: '我发起的', exact: true }).click();
    await p.getByRole('combobox', { name: '申请状态' }).click();
    await p.getByRole('option', { name: '已驳回', exact: true }).click();
    await p.getByRole('button').filter({ hasText: '业务报表数据库' }).click();
    await dialog.getByText('请补充具体使用环境和预计使用时长，再提交申请。', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '重新申请', exact: true }).click();
    await dialog.getByRole('textbox', { name: '申请说明' }).fill('仅用于预发布环境，预计使用两周。');
    await dialog.getByRole('button', { name: '确认提交' }).click();
    await dialog.getByText('历次申请', { exact: true }).waitFor();
    assert.equal(f.writes.at(-1).action, 'resubmit');
    await p.screenshot({ path: join(shots, `rounds-${width}.png`), fullPage: false });
    await p.keyboard.press('Escape');
    await p.goto(base + '/requests');
    await p.getByRole('button').filter({ hasText: '预发布环境 · 网关配置' }).click();
    await dialog.getByRole('button', { name: '批准申请' }).click();
    await dialog.getByRole('textbox', { name: '授权有效期' }).waitFor();
    f.setFail(true);
    await dialog.getByRole('button', { name: '确认批准' }).click();
    await p.getByText('申请已被他人处理，请刷新').waitFor();
    assert.equal(await dialog.getByRole('button', { name: '确认批准' }).count(), 1);
    await p.keyboard.press('Escape');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    f.setOffline(true);
    await p.reload();
    await p.getByRole('button', { name: '重试', exact: true }).waitFor();
    await f.context.close();
    const member = await fixture(width, 'member');
    await member.page.goto(base + '/requests?tab=mine&status=rejected');
    await member.page.getByRole('button').filter({ hasText: '业务报表数据库' }).click();
    await member.page.getByRole('dialog').getByRole('button', { name: '重新申请' }).waitFor();
    assert.equal(await member.page.getByRole('button', { name: '批准申请' }).count(), 0);
    await member.context.close();
    const quick = await fixture(width);
    const quickId = '00000000-0000-4000-8000-000000000001';
    await quick.context.addInitScript(() => { window.closeCalls = 0; window.close = () => { window.closeCalls++; }; });
    await quick.page.goto(`${base}/requests/${quickId}/approve?token=fixture-signed-action`);
    await quick.page.getByRole('heading', { name: '已同意申请' }).waitFor();
    await quick.page.waitForFunction(() => window.closeCalls === 1);
    assert.equal(quick.writes.length, 1, '快捷同意只发送一次审批请求');
    assert.equal(quick.writes[0].action, 'notification-approve');
    assert.equal(quick.writes[0].body.token, 'fixture-signed-action');
    await quick.page.screenshot({ path: join(shots, `quick-approved-${width}.png`), fullPage: true });
    await quick.page.getByRole('link', { name: '查看详情', exact: true }).click();
    await quick.page.getByRole('dialog').getByText('已批准', { exact: true }).waitFor();
    await quick.page.goto(`${base}/requests?request=00000000-0000-4000-8000-000000000002&action=reject`);
    await quick.page.getByRole('textbox', { name: '驳回原因', exact: true }).waitFor();
    assert.equal(await quick.page.getByRole('button', { name: '确认驳回' }).isDisabled(), true);
    assert.equal(quick.writes.length, 1, '打开驳回链接不直接修改状态');
    await quick.context.close();
    const failed = await fixture(width);
    failed.setFail(true);
    await failed.context.addInitScript(() => { window.closeCalls = 0; window.close = () => { window.closeCalls++; }; });
    await failed.page.goto(`${base}/requests/${quickId}/approve?token=fixture-signed-action`);
    await failed.page.getByRole('heading', { name: '未完成快捷审批' }).waitFor();
    assert.equal(await failed.page.evaluate(() => window.closeCalls), 0);
    assert.equal(failed.writes.length, 1);
    await failed.page.goto(`${base}/requests/${quickId}/approve`);
    await failed.page.getByText('快捷审批链接不完整，请前往申请详情处理。').waitFor();
    assert.equal(failed.writes.length, 1, '缺少签名不能自动提交');
    await failed.context.addInitScript(() => { localStorage.clear(); });
    await failed.page.goto(`${base}/requests/${quickId}/approve?token=fixture-signed-action`);
    await failed.page.waitForURL('**/login?next=*');
    assert(new URL(failed.page.url()).searchParams.get('next').includes('token=fixture-signed-action'));
    await failed.context.close();
    console.log(`Unified requests UI verified at ${width}px`);
  }
  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${shots}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
