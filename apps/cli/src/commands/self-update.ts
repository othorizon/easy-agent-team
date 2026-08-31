import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLI_VERSION, CLIENT_HEADER, isNewerVersion } from '@eat/shared';
import { resolveServerUrl } from '../config.js';
import { markCliUpdated } from '../update.js';

/** 安装脚本落地的标准位置；运行路径不可用时回退到这里 */
const DEFAULT_BIN = path.join(os.homedir(), '.eat', 'bin', 'eat.js');

/**
 * 正在运行的 CLI 产物路径。
 * 启动器统一是 `node <bin>/eat.js`，所以 argv[1] 就是要覆盖的目标；
 * 拿不到（少见的嵌入式调用）时回退到安装脚本的默认位置。
 */
export function resolveInstallPath(argv = process.argv): string {
  const running = argv[1];
  if (running && running.endsWith('.js') && fs.existsSync(running)) return path.resolve(running);
  return DEFAULT_BIN;
}

/**
 * 下载内容的合法性校验：平台缺产物时会回 JSON 错误体，代理/门户也可能塞回一张 HTML 页面，
 * 直接覆盖会把 CLI 写坏。产物必带 tsup banner 的 shebang，且不可能只有几百字节。
 */
export function isValidBundle(text: string): boolean {
  return text.startsWith('#!/usr/bin/env node') && text.length > 1000;
}

export interface SelfUpdateOpts {
  server?: string;
  force?: boolean;
}

/**
 * 自更新（决策 26）：重新拉取 /install/eat.js 覆盖本地产物。
 * 单命令跨平台——Agent 不必先判断操作系统再选 install.sh / install.ps1。
 * 只换 eat.js：PATH 与 shim（eat / eat.cmd / eat.ps1）由安装脚本落地，不随版本变化。
 */
export async function selfUpdate(opts: SelfUpdateOpts): Promise<void> {
  const server = resolveServerUrl(opts.server);
  const headers = { [CLIENT_HEADER]: `eat-cli/${CLI_VERSION}` };

  let latest: string | null = null;
  try {
    const res = await fetch(`${server}/install/version.json`, { headers });
    if (res.ok) {
      const info = (await res.json()) as { cli?: string };
      latest = typeof info.cli === 'string' ? info.cli : null;
    }
  } catch {
    // 版本接口拿不到不致命：仍然可以直接覆盖为平台当前产物
  }

  if (latest && !isNewerVersion(latest, CLI_VERSION) && !opts.force) {
    console.log(`已是最新版本（${CLI_VERSION}），无需更新。`);
    markCliUpdated(latest);
    return;
  }

  const target = resolveInstallPath();
  console.log(`从 ${server} 下载 eat CLI${latest ? ` ${latest}` : ''} ...`);

  let res: Response;
  try {
    res = await fetch(`${server}/install/eat.js`, { headers });
  } catch (err) {
    throw new Error(`无法连接平台 ${server}：${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`下载失败（HTTP ${res.status}）：${server}/install/eat.js`);
  }
  const bundle = await res.text();
  if (!isValidBundle(bundle)) {
    throw new Error(`下载内容不是有效的 CLI 产物（${bundle.length} 字节），已放弃更新以免写坏本地 eat`);
  }

  // 先写同目录临时文件再覆盖：下载中断不会留下半截产物。
  // 就地覆盖是安全的——Node 启动时已把源码整份读入内存，不会读到写了一半的文件。
  const tmp = `${target}.download`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, bundle, { mode: 0o755 });
    fs.copyFileSync(tmp, target);
  } catch (err) {
    throw new Error(`写入 ${target} 失败：${(err as Error).message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (latest) markCliUpdated(latest);
  console.log(`✅ eat CLI 已更新${latest ? `：${CLI_VERSION} → ${latest}` : ''}`);
  console.log(`   产物位置: ${target}`);
  console.log('   下一步建议: eat sync（同步团队 Skill 的最新版本）');
}
