#!/usr/bin/env node
/**
 * 求助飞书卡片效果测试脚本：向指定的飞书群自定义机器人 webhook 发送
 * 「新求助」与「求助有新回复」两张样例卡片，用于人工确认卡片效果。
 *
 * 卡片构建逻辑与 server 出站通知共用（@eat/shared 的 buildHelpFeishuCard），
 * 这里看到的效果即真实推送的效果。需先构建 shared：pnpm --filter @eat/shared build
 *
 * 用法：
 *   node scripts/test-feishu-card.mjs <webhook-url> [选项]
 *
 * 选项：
 *   --secret <s>   机器人「加签」密钥（开启签名校验时必填）
 *   --type <t>     request | reply | both（默认 both）
 *   --base <url>   平台地址，用于「查看请求」按钮链接（默认 http://localhost:3000）
 */
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sharedDist = path.resolve(fileURLToPath(import.meta.url), '../../packages/shared/dist/index.js');
if (!existsSync(sharedDist)) {
  console.error('未找到 @eat/shared 构建产物，请先执行：pnpm --filter @eat/shared build');
  process.exit(1);
}
const { buildHelpFeishuCard } = await import(pathToFileURL(sharedDist).href);

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
let webhookUrl = '';
let secret = '';
let type = 'both';
let base = 'http://localhost:3000';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--secret') secret = args[++i] ?? '';
  else if (a === '--type') type = args[++i] ?? 'both';
  else if (a === '--base') base = args[++i] ?? base;
  else if (!a.startsWith('--') && !webhookUrl) webhookUrl = a;
  else {
    console.error(`未知参数: ${a}`);
    process.exit(1);
  }
}
if (!webhookUrl || !['request', 'reply', 'both'].includes(type)) {
  console.error('用法: node scripts/test-feishu-card.mjs <webhook-url> [--secret <加签密钥>] [--type request|reply|both] [--base <平台地址>]');
  process.exit(1);
}

// ---------- 样例数据（假 ID，「查看请求」会 404，仅看卡片效果） ----------
const requestId = '3f2c9b1e-0000-4000-8000-000000000000';
const samples = {
  request: buildHelpFeishuCard({
    kind: 'request',
    requestId,
    title: '对账单里的差异字段是什么意思',
    excerpt:
      'AI 在处理对账时问我 diff_type 字段的含义，我不懂。这段描述特意写得比较长，用来验证卡片里的截断效果是否符合预期：按平台约定描述超过一百个字符时只展示前一百个字符，剩下的部分应当被一个省略号替代，避免卡片被撑得过长影响群里阅读。',
    from: '运营B',
    url: `${base}/help/${requestId}`,
  }),
  reply: buildHelpFeishuCard({
    kind: 'reply',
    requestId,
    title: '对账单里的差异字段是什么意思',
    excerpt: 'diff_type 是差异类型：1 金额差异 2 状态差异。状态差异先核对流水号，再看是否退款单。',
    from: '资深同事D',
    url: `${base}/help/${requestId}`,
  }),
};

// ---------- 发送（与 server 相同的加签方式） ----------
async function send(kind, card) {
  const msg = { msg_type: 'interactive', card };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    msg.timestamp = timestamp;
    msg.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  }
  let res;
  try {
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(`❌ ${kind === 'request' ? '新求助卡片' : '回复卡片'} → 请求失败: ${err.cause?.message ?? err.message}`);
    process.exitCode = 1;
    return;
  }
  const body = await res.text();
  let ok = res.ok;
  try {
    const parsed = JSON.parse(body);
    const code = parsed.code ?? parsed.StatusCode;
    if (typeof code === 'number' && code !== 0) ok = false;
  } catch {
    ok = false;
  }
  console.log(`${ok ? '✅' : '❌'} ${kind === 'request' ? '新求助卡片' : '回复卡片'} → HTTP ${res.status} ${body}`);
  if (!ok) process.exitCode = 1;
}

for (const kind of type === 'both' ? ['request', 'reply'] : [type]) {
  await send(kind, samples[kind]);
}
