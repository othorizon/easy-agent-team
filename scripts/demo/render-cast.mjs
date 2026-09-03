#!/usr/bin/env node
/**
 * 把 record-cli.mjs 录下的 cast 渲染成 GIF：
 * 用 Playwright 在一个「终端窗口」的 HTML 里逐帧截图，再用 Pillow 合成动图。
 *
 *   NODE_PATH=$(npm root -g) node scripts/demo/render-cast.mjs onboard
 *   NODE_PATH=$(npm root -g) node scripts/demo/render-cast.mjs        # 渲染 .demo-casts 里全部
 *
 * 依赖：playwright（可以只装在全局，见 capture-web.mjs 里的说明）+ Pillow（pip3 install pillow）。
 * 为什么不用 ffmpeg：Playwright 自带的那份是裁剪版编译，只有 webm/vp8，没有 gif 编码器。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAST_DIR = process.env.EAT_CAST_DIR ?? path.resolve('.demo-casts');
const OUT_DIR = process.env.EAT_GIF_DIR ?? path.resolve('docs/assets/demos');
const WIDTH = Number(process.env.EAT_GIF_WIDTH ?? 900);
const FONT_SIZE = Number(process.env.EAT_GIF_FONT ?? 13);

/** 打字速度与各处停顿（毫秒）：按「看得清但不磨人」调的 */
const TYPE_MS = 40;
const TYPE_CHARS = 2;
const PROMPT_PAUSE = 260;
const ENTER_PAUSE = 360;
const STEP_PAUSE = 620;
const OUTPUT_MAX_GAP = 850;
const FINAL_HOLD = 2400;

const ANSI = /\[[0-9;?]*[A-Za-z]/g;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** CLI 本身不上色，保险起见剥一层 ANSI；\r 当换行处理 */
const clean = (s) => s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');

/** 一帧 = 屏幕上的完整 HTML + 停留时长 */
function buildFrames(cast) {
  const frames = [];
  const push = (html, duration) => {
    const last = frames.at(-1);
    if (last && last.html === html) last.duration += duration;
    else frames.push({ html, duration });
  };
  const line = (cwd, typed, cursor) =>
    `<div class="line"><span class="cwd">${esc(cwd)}</span><span class="sigil"> $ </span>` +
    `<span class="cmd">${esc(typed)}</span>${cursor ? '<span class="cur"> </span>' : ''}</div>`;

  let screen = '';
  for (const step of cast.steps) {
    const base = screen;
    push(base + line(step.cwd, '', true), PROMPT_PAUSE);
    for (let i = TYPE_CHARS; i < step.cmd.length; i += TYPE_CHARS) {
      push(base + line(step.cwd, step.cmd.slice(0, i), true), TYPE_MS);
    }
    const typed = base + line(step.cwd, step.cmd, false);
    push(base + line(step.cwd, step.cmd, true), TYPE_MS);
    push(typed, ENTER_PAUSE);

    let out = '';
    step.chunks.forEach(([t, s], i) => {
      out += clean(s);
      const next = step.chunks[i + 1]?.[0] ?? t + 120;
      const gap = Math.min(Math.max(next - t, 55), OUTPUT_MAX_GAP);
      push(`${typed}<div class="out">${esc(out.replace(/\n+$/, ''))}</div>`, gap);
    });
    screen = out.trim() ? `${typed}<div class="out">${esc(out.replace(/\n+$/, ''))}</div>` : typed;
    push(screen, STEP_PAUSE);
  }
  frames.at(-1).duration = FINAL_HOLD;
  return frames;
}

const PAGE = (cast) => `<!doctype html><meta charset="utf-8"><style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; background: #f4f4f5 }
  .win { width: ${WIDTH}px; background: #14141a; border-radius: 10px; overflow: hidden;
         font-family: "JetBrains Mono", "DejaVu Sans Mono", "Noto Sans CJK SC", monospace }
  .bar { height: 30px; background: #1f1f27; display: flex; align-items: center; gap: 6px;
         padding: 0 12px; border-bottom: 1px solid #2a2a35 }
  .dot { width: 10px; height: 10px; border-radius: 50% }
  .title { flex: 1; text-align: center; color: #8b8b99; font-size: 11.5px; margin-right: 42px }
  .screen, .measure { padding: 12px 16px 14px; font-size: ${FONT_SIZE}px; line-height: 1.55;
            color: #d7d7de; width: ${WIDTH}px }
  /* 窗口高度按最高的一帧定，所以正常情况内容从上往下长、不会溢出；
     真的超出上限时改为贴底（像真终端那样滚上去）并让顶部淡出，避免把一行切成两半 */
  .screen { height: ${cast.rows * Math.round(FONT_SIZE * 1.55)}px;
            display: flex; flex-direction: column; justify-content: flex-start; overflow: hidden }
  .screen.clipped { justify-content: flex-end; mask-image: linear-gradient(#0000 0, #000 22px) }
  .measure { position: absolute; left: -9999px; top: 0; visibility: hidden }
  .line { white-space: pre-wrap; word-break: break-all; margin-top: 7px }
  .line:first-child { margin-top: 0 }
  .cwd { color: #67c9a5 }
  .sigil { color: #6b7280 }
  .cmd { color: #f4f4f5 }
  .cur { background: #d7d7de }
  .out { white-space: pre-wrap; word-break: break-all; color: #b9b9c4 }
</style>
<div class="win">
  <div class="bar">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="title">${esc(cast.title ?? cast.name)}</span>
  </div>
  <div class="screen" id="screen"></div>
</div>
<div class="measure" id="measure"></div>`;

async function render(name) {
  const cast = JSON.parse(fs.readFileSync(path.join(CAST_DIR, `${name}.json`), 'utf8'));
  const frames = buildFrames(cast);
  const seconds = (frames.reduce((a, f) => a + f.duration, 0) / 1000).toFixed(1);
  console.log(`\n== ${name}: ${frames.length} 帧 / 约 ${seconds}s`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cast-${name}-`));
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH + 40, height: 1400 },
    deviceScaleFactor: 2,
  });
  await page.setContent(PAGE(cast));
  // 窗口高度按「最高的那一帧」定，避免整段留白，也避免顶部把一行切成两半
  const fitted = await page.evaluate((htmls) => {
    const measure = document.getElementById('measure');
    const screen = document.getElementById('screen');
    let needed = 0;
    for (const html of htmls) {
      measure.innerHTML = html;
      needed = Math.max(needed, measure.scrollHeight);
    }
    const cap = screen.getBoundingClientRect().height;
    // +6：scrollHeight 偶尔会少算最后一行的下边距，缺这几像素最后一行就被削掉半截
    const height = Math.min(needed + 6, cap);
    screen.style.height = `${height}px`;
    if (needed > cap) screen.classList.add('clipped');
    return { needed, cap, height, clipped: needed > cap };
  }, frames.map((f) => f.html));
  console.log(`  窗口高度 ${Math.round(fitted.height)}px${fitted.clipped ? '（内容超出，顶部淡出）' : ''}`);
  const win = page.locator('.win');
  const files = [];
  for (const [i, frame] of frames.entries()) {
    await page.evaluate((html) => {
      document.getElementById('screen').innerHTML = html;
    }, frame.html);
    const file = path.join(tmp, `f${String(i).padStart(4, '0')}.png`);
    await win.screenshot({ path: file });
    files.push(file);
    if (i % 25 === 0) process.stdout.write(`  ${i}/${frames.length}\r`);
  }
  await browser.close();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const gif = path.join(OUT_DIR, `${name}.gif`);
  const durations = JSON.stringify(frames.map((f) => Math.max(20, Math.round(f.duration))));
  execFileSync('python3', [path.join(HERE, 'gif.py'), gif, String(WIDTH), durations, ...files], {
    stdio: 'inherit',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  → ${path.relative(process.cwd(), gif)}  ${Math.round(fs.statSync(gif).size / 1024)}KB`);
}

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs
      .readdirSync(CAST_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
for (const n of names) await render(n);
