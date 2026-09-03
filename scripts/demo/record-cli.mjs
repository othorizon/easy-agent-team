#!/usr/bin/env node
/**
 * 录制 CLI 演示：把 scripts/demo/casts.mjs 里的命令**真的跑一遍**，连输出带时间戳记下来。
 *
 *   EAT_DEMO_PLATFORM=http://eat.internal.example.com node scripts/demo/record-cli.mjs onboard
 *   node scripts/demo/record-cli.mjs            # 录全部
 *
 * 产物是 cast JSON（默认写 .demo-casts/，不入库），再用 render-cast.mjs 渲成 GIF。
 * 命令行里写的就是执行的，输出一个字都不改——录出来的东西必须是真的。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CASTS } from './casts.mjs';

const PLATFORM = process.env.EAT_DEMO_PLATFORM ?? 'http://eat.internal.example.com';
const CAST_DIR = process.env.EAT_CAST_DIR ?? path.resolve('.demo-casts');
const PASSWORDS = { admin: process.env.EAT_ADMIN_PASSWORD ?? 'admin12345' };
const EMAILS = {
  admin: process.env.EAT_ADMIN_EMAIL ?? 'admin@example.com',
  liwei: 'liwei@example.com',
  zhouqi: 'zhouqi@example.com',
  sunhao: 'sunhao@example.com',
  wumin: 'wumin@example.com',
  zhengnan: 'zhengnan@example.com',
};

async function api(method, p, { body, token } = {}) {
  const res = await fetch(`${PLATFORM}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${data?.message ?? text}`);
  return data;
}
const tokenCache = new Map();
async function tokenOf(who) {
  if (!tokenCache.has(who)) {
    const r = await api('POST', '/api/auth/login', {
      body: { email: EMAILS[who], password: PASSWORDS[who] ?? 'demo12345' },
    });
    tokenCache.set(who, r.token);
  }
  return tokenCache.get(who);
}

/** 录制过程中「另一个人」的动作：都是真的调平台接口，只是这个人不在镜头里 */
const ACTIONS = {
  /** 浏览器里点「同意授权」 */
  async approveDevice({ as }, ctx) {
    const code = /输入代码\s+([A-Z0-9-]+)/.exec(ctx.output())?.[1];
    if (!code) throw new Error('没能从输出里取到设备码');
    await api('POST', '/api/auth/device/approve', {
      token: await tokenOf(as),
      body: { userCode: code, tokenName: `${as} 的笔记本` },
    });
    console.log(`    · ${as} 在浏览器里同意了设备码 ${code}`);
  },
  /** Owner 批准最新的一条待审批权限申请（可用 environment 限定，别批到别人的那条） */
  async approveAccessRequest({ as, environment }) {
    const token = await tokenOf(as);
    const inbox = await api('GET', '/api/access-requests/inbox', { token });
    const pending = inbox
      .filter((r) => r.status === 'pending' && (!environment || r.environmentSlug === environment))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .at(-1);
    if (!pending) throw new Error(`收件箱里没有待审批的申请${environment ? `（${environment}）` : ''}`);
    await api('POST', `/api/access-requests/${pending.id}/decision`, { token, body: { decision: 'approved' } });
    console.log(`    · ${as} 批了 ${pending.environmentSlug} / ${pending.keys.join(',')}`);
  },
  /** 被求助者回复最新的一条求助 */
  async replyHelp({ as, message }) {
    const token = await tokenOf(as);
    const inbox = await api('GET', '/api/help-requests/inbox', { token });
    const target = inbox.at(0);
    if (!target) throw new Error('没有收到的求助');
    await api('POST', `/api/help-requests/${target.id}/reply`, { token, body: { content: message } });
    console.log(`    · ${as} 回复了「${target.title}」`);
  },
};

function runStep(cmd, { cwd, home }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks = [];
    const child = spawn('bash', ['-c', `${cmd} 2>&1`], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        COLUMNS: '96',
        TERM: 'dumb',
        NO_COLOR: '1',
        PATH: process.env.PATH,
      },
    });
    child.stdout.on('data', (d) => chunks.push([Date.now() - startedAt, d.toString('utf8')]));
    child.on('close', (code) => resolve({ chunks, exit: code ?? 0, ms: Date.now() - startedAt }));
    runStep.current = { child, chunks };
  });
}

/** 录制前的准备：不进画面，只把这条 cast 需要的前置状态摆好 */
async function setup(cast) {
  if (cast.resetCredentials) fs.rmSync(path.join(cast.home, '.eat'), { recursive: true, force: true });
  if (!cast.setup) return;
  if (cast.setup.loginAs) {
    // 等价于这个人早先自己 eat login 过一次（录屏里不重复演登录）
    const who = cast.setup.loginAs;
    const r = await api('POST', '/api/auth/login', {
      body: { email: EMAILS[who], password: PASSWORDS[who] ?? 'demo12345' },
    });
    fs.mkdirSync(path.join(cast.home, '.eat'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cast.home, '.eat', 'credentials.json'),
      JSON.stringify({ serverUrl: PLATFORM, token: r.token, user: r.user }, null, 2),
      { mode: 0o600 },
    );
    console.log(`  · 准备：${who} 已登录`);
  }
  for (const cmd of cast.setup.run ?? []) {
    await runStep(cmd, { cwd: cast.cwd, home: cast.home });
    console.log(`  · 准备：${cmd}`);
  }
}

async function record(name) {
  const cast = CASTS[name];
  if (!cast) throw new Error(`未知 cast: ${name}（可选: ${Object.keys(CASTS).join(', ')}）`);
  console.log(`\n== 录制 ${name}`);
  await setup(cast);
  let cwd = cast.cwd;
  const out = { name, title: cast.title, rows: cast.rows ?? 24, home: cast.home, steps: [] };

  for (const step of cast.steps) {
    // `cd` 只改工作目录，没有输出，但要出现在画面里
    const cdTarget = /^cd\s+(\S+)$/.exec(step.cmd)?.[1];
    if (cdTarget) {
      cwd = path.resolve(cwd, cdTarget.replace(/^~/, cast.home));
      out.steps.push({ cmd: step.cmd, cwd: display(cwd, cast.home), chunks: [], exit: 0 });
      continue;
    }
    console.log(`  $ ${step.cmd.length > 110 ? `${step.cmd.slice(0, 110)}…` : step.cmd}`);
    const pending = [];
    const result = runStep(step.cmd, { cwd, home: cast.home });
    if (step.during) {
      const live = runStep.current;
      pending.push(
        new Promise((r) =>
          setTimeout(async () => {
            try {
              await ACTIONS[step.during.action](step.during, { output: () => live.chunks.map((c) => c[1]).join('') });
            } catch (err) {
              console.warn(`    ! during ${step.during.action}: ${err.message}`);
            }
            r();
          }, step.during.at ?? 2000),
        ),
      );
    }
    const done = await result;
    await Promise.all(pending);
    out.steps.push({ cmd: step.cmd, cwd: display(cwd, cast.home), ...done });
    if (done.exit !== 0) console.log(`    (退出码 ${done.exit})`);
    if (step.after) {
      try {
        await ACTIONS[step.after.action](step.after, {});
      } catch (err) {
        console.warn(`    ! after ${step.after.action}: ${err.message}`);
      }
    }
  }
  fs.mkdirSync(CAST_DIR, { recursive: true });
  const file = path.join(CAST_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`  → ${file}`);
}

const display = (dir, home) => (dir === home ? '~' : dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir);

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASTS);
for (const n of names) await record(n);
