#!/usr/bin/env node
/**
 * 控制台截图：用 Playwright 把演示环境的每个页面拍下来，输出到 docs/assets/screenshots/。
 *
 * 前置：库 + server 起着，且已跑过 scripts/demo/seed-demo.mjs（应用相关还需 seed-demo-apps.mjs）。
 *
 *   NODE_PATH=$(npm root -g) EAT_SERVER=http://localhost:3001 node scripts/demo/capture-web.mjs
 *   # 只拍某几张： ... node scripts/demo/capture-web.mjs envs apps
 *
 * 截图按 2 倍分辨率拍、再缩到 1440 宽（超采样，字更干净、体积更小）；缩放需要 Pillow：
 *   pip3 install pillow      # 缺了就跳过缩放，直接留 2 倍图
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

// playwright 可能只装在全局（云端会话就是这样）。ESM 的 import 不认 NODE_PATH，CJS 的 require 认，
// 所以这里绕一手 createRequire：NODE_PATH=$(npm root -g) 就能直接用全局那份。
const { chromium } = createRequire(import.meta.url)('playwright');

const SERVER = (process.env.EAT_SERVER ?? 'http://localhost:3000').replace(/\/+$/, '');
const OUT = process.env.EAT_SHOT_DIR ?? path.resolve('docs/assets/screenshots');
const TARGET_WIDTH = Number(process.env.EAT_SHOT_WIDTH ?? 1440);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const ACCOUNTS = {
  admin: { email: process.env.EAT_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.EAT_ADMIN_PASSWORD ?? 'admin12345' },
  liwei: { email: 'liwei@example.com', password: 'demo12345' },
  zhouqi: { email: 'zhouqi@example.com', password: 'demo12345' },
  sunhao: { email: 'sunhao@example.com', password: 'demo12345' },
  wumin: { email: 'wumin@example.com', password: 'demo12345' },
  zhengnan: { email: 'zhengnan@example.com', password: 'demo12345' },
};

async function login(who) {
  const a = ACCOUNTS[who];
  const res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(a),
  });
  if (!res.ok) throw new Error(`${who} 登录失败: ${res.status}`);
  return res.json();
}

/** 点开某个应用的详情弹窗（应用详情是 /apps 页面上的 Dialog，没有独立路由） */
const openApp = (name) => async (page) => {
  await page.getByRole('button', { name }).first().click();
  await page.waitForTimeout(600);
};
const clickTab = (name) => async (page) => {
  await page.getByRole('tab', { name }).click();
  await page.waitForTimeout(600);
};

/** 每张图：谁在看、看哪一页、拍前要不要点两下 */
const SHOTS = [
  { name: 'envs', as: 'admin', url: '/', wait: '内部 API 网关' },
  { name: 'env-detail', as: 'admin', url: '/envs/internal-api', wait: 'INTERNAL_API_TOKEN' },
  { name: 'requests', as: 'liwei', url: '/requests?tab=inbox', wait: 'INTERNAL_API_TOKEN' },
  { name: 'skills', as: 'admin', url: '/skills', wait: 'CRM 数据查询' },
  { name: 'skill-detail', as: 'admin', url: '/skills/crm-data-query', wait: '统计口径' },
  { name: 'mcp', as: 'admin', url: '/mcp', wait: 'CRM 只读数据库' },
  { name: 'templates', as: 'wumin', url: '/templates', wait: '运营同学' },
  { name: 'help', as: 'sunhao', url: '/help', wait: '40008' },
  { name: 'help-detail', as: 'sunhao', url: '/help', wait: '40008', prepare: async (page) => {
      await page.getByText('企业微信机器人发图片一直报 40008').first().click();
      await page.waitForTimeout(800);
    } },
  { name: 'db', as: 'admin', url: '/db?tab=all', wait: 'crm_dashboard' },
  { name: 'db-instances', as: 'admin', url: '/db?tab=instances', wait: '测试 PostgreSQL' },
  { name: 'apps', as: 'admin', url: '/apps', wait: '客户看板' },
  { name: 'app-detail', as: 'admin', url: '/apps', wait: '客户看板', prepare: openApp('客户看板') },
  { name: 'app-deployments', as: 'admin', url: '/apps', wait: '客户看板', prepare: async (page) => {
      await openApp('客户看板')(page);
      await clickTab('部署记录')(page);
    } },
  { name: 'app-build-logs', as: 'admin', url: '/apps', wait: '客户看板', prepare: async (page) => {
      await openApp('客户看板')(page);
      await clickTab('部署记录')(page);
      await page.getByRole('button', { name: '构建日志' }).click();
      await page.waitForTimeout(2500);
    } },
  { name: 'app-env', as: 'sunhao', url: '/apps', wait: '客户看板', prepare: async (page) => {
      await openApp('客户看板')(page);
      await clickTab('环境变量')(page);
    } },
  { name: 'users', as: 'admin', url: '/users', wait: '李维' },
  { name: 'settings', as: 'admin', url: '/settings', wait: '部署后台', fullPage: true },
  { name: 'install', as: 'wumin', url: '/install', wait: 'install.sh' },
  { name: 'login', as: null, url: '/login', wait: '登录' },
  { name: 'mobile-apps', as: 'admin', url: '/apps', wait: '客户看板', viewport: MOBILE },
  { name: 'mobile-nav', as: 'admin', url: '/skills', wait: 'CRM 数据查询', viewport: MOBILE, prepare: async (page) => {
      await page.getByRole('button').first().click();
      await page.waitForTimeout(600);
    } },
  { name: 'mobile-help-detail', as: 'sunhao', url: '/help', wait: '40008', viewport: MOBILE, prepare: async (page) => {
      await page.getByText('企业微信机器人发图片一直报 40008').first().click();
      await page.waitForTimeout(800);
    } },
];

/** 关掉动画与光标闪烁，避免同一页面两次截图不一致 */
const CALM_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}`;

function shrink(file) {
  try {
    execFileSync('python3', ['-c', `
import sys
from PIL import Image
src = sys.argv[1]
target = int(sys.argv[2])
im = Image.open(src)
if im.width > target:
    im = im.resize((target, round(im.height * target / im.width)), Image.LANCZOS)
    im.save(src, optimize=True)
`, file, String(TARGET_WIDTH)], { stdio: 'pipe' });
  } catch (err) {
    console.warn(`  (未缩放，Pillow 不可用: ${String(err.message).split('\n')[0]})`);
  }
}

async function main() {
  const only = process.argv.slice(2);
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  fs.mkdirSync(OUT, { recursive: true });
  const sessions = {};
  for (const who of new Set(shots.map((s) => s.as).filter(Boolean))) sessions[who] = await login(who);

  const browser = await chromium.launch();
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: shot.viewport ?? DESKTOP,
      deviceScaleFactor: 2,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      isMobile: Boolean(shot.viewport),
      hasTouch: Boolean(shot.viewport),
    });
    if (shot.as) {
      const s = sessions[shot.as];
      await context.addInitScript(([token, user]) => {
        localStorage.setItem('eat.token', token);
        localStorage.setItem('eat.user', user);
      }, [s.token, JSON.stringify(s.user)]);
    }
    const page = await context.newPage();
    await page.goto(`${SERVER}${shot.url}`, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: CALM_CSS });
    if (shot.wait) await page.getByText(shot.wait).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    if (shot.prepare) await shot.prepare(page);
    if (!shot.fullPage) {
      const height = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) return Math.ceil(dialog.getBoundingClientRect().height) + 96;
        const main = document.querySelector('main') ?? document.body;
        const needed = Math.ceil(main.getBoundingClientRect().top + main.scrollHeight);
        // 侧边栏是 fixed inset-y-0：视口收得比它还矮，最下面那组导航就会被切掉
        const aside = document.querySelector('aside');
        return Math.max(needed, aside ? Math.ceil(aside.scrollHeight) : 0);
      });
      const vw = (shot.viewport ?? DESKTOP).width;
      const clamped = Math.min(Math.max(height, 480), 1600);
      if (Math.abs(clamped - (shot.viewport ?? DESKTOP).height) > 24) {
        await page.setViewportSize({ width: vw, height: clamped });
        await page.waitForTimeout(400);
      }
    }
    const file = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: Boolean(shot.fullPage) });
    shrink(file);
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  + ${path.relative(process.cwd(), file)}  ${kb}KB`);
    await context.close();
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
