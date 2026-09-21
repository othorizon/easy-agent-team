import * as path from 'node:path';
import {
  type ConfigLocation,
  type EatConfig,
  loadConfigs,
  projectConfigFile,
  readConfigFile,
  removeConfigFile,
  resolveSyncRoots,
  type SyncScope,
  userConfigFile,
  writeConfigFile,
} from '../sync-config.js';
import { defaultLinkStrategy, describeResolution } from './sync.js';
import { clearSyncTarget } from '../update.js';

/**
 * eat config：eat sync 的落点配置（决策 56）。
 *
 * 只开放 sync.scope / sync.dir 两个键——这里要解决的是「裸跑 eat sync 落到哪」，
 * 不是给 CLI 开一个什么都能塞的通用配置面。
 */

const SET_KEYS = ['sync.scope', 'sync.dir'] as const;
const UNSET_KEYS = ['sync', 'sync.scope', 'sync.dir'] as const;

interface FileOpts {
  project?: boolean;
  user?: boolean;
}

/**
 * 决定写哪份配置：project 作用域默认写项目内配置——它按 cwd 解析，
 * 写进用户配置会让换个仓库裸跑 sync 也变成项目级，等于造出新的跑偏路径。
 */
function pickFile(opts: FileOpts, scope: SyncScope | null, cwd: string): { file: string; location: ConfigLocation } {
  if (opts.project && opts.user) throw new Error('--project 与 --user 不能同时使用');
  const location: ConfigLocation = opts.project
    ? 'project'
    : opts.user
      ? 'user'
      : scope === 'project'
        ? 'project'
        : 'user';
  return { file: location === 'project' ? projectConfigFile(cwd) : userConfigFile(), location };
}

/** 任何一条 config 命令都把「现在裸跑 eat sync 会落到哪」重新打一遍——改完立刻看得到结果 */
function printResolution(cwd: string, title = '裸跑 eat sync 的落点：'): void {
  console.log(title);
  try {
    for (const line of describeResolution(resolveSyncRoots({}, cwd), defaultLinkStrategy(), false, '')) {
      console.log(`  ${line}`);
    }
  } catch (err) {
    console.log(`  当前配置无法解析：${(err as Error).message}`);
  }
}

export function configList(): void {
  const cwd = process.cwd();
  printResolution(cwd);

  const configs = loadConfigs(cwd);
  console.log('\n配置文件：');
  if (configs.length === 0) {
    console.log('  （没有任何配置文件，按内置默认落全局目录）');
  }
  for (const c of configs) {
    const sync = c.config.sync;
    const desc = sync?.scope
      ? `sync.scope=${sync.scope}${sync.dir ? `, sync.dir=${sync.dir}` : ''}`
      : '（无 sync 配置）';
    console.log(`  ${c.location === 'project' ? '项目配置' : '用户配置'} ${c.file}: ${desc}`);
  }
  console.log('\n  项目配置优先于用户配置；环境变量 EAT_SYNC_SCOPE / EAT_SYNC_DIR 优先于两者，命令行参数优先于一切。');
}

export function configGet(key: string): void {
  if (!(UNSET_KEYS as readonly string[]).includes(key)) {
    throw new Error(`未知配置项 ${key}，可用：${UNSET_KEYS.join(' / ')}`);
  }
  const cwd = process.cwd();
  for (const c of loadConfigs(cwd)) {
    const value = key === 'sync' ? c.config.sync : key === 'sync.scope' ? c.config.sync?.scope : c.config.sync?.dir;
    if (value === undefined) continue;
    console.log(`${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}  （${c.file}）`);
    return;
  }
  console.log(`${key} 未设置`);
}

export function configSet(key: string, value: string, opts: FileOpts): void {
  if (!(SET_KEYS as readonly string[]).includes(key)) {
    throw new Error(`未知配置项 ${key}，可设置：${SET_KEYS.join(' / ')}`);
  }
  const cwd = process.cwd();
  let scope: SyncScope;
  let dir: string | undefined;

  if (key === 'sync.dir') {
    // 一律存绝对路径：存相对路径换个 cwd 跑就落到别处，比没有配置更难排查
    dir = path.resolve(cwd, value);
    scope = 'dir';
  } else {
    if (value !== 'global' && value !== 'project' && value !== 'dir') {
      throw new Error(`sync.scope 只能是 global / project / dir，收到 "${value}"`);
    }
    scope = value;
    if (scope === 'dir') {
      const existing = loadConfigs(cwd).find((c) => c.config.sync?.dir)?.config.sync?.dir;
      if (!existing) throw new Error('sync.scope=dir 需要先指定目录：eat config set sync.dir <目录>');
      dir = path.resolve(existing);
    }
  }

  const { file, location } = pickFile(opts, scope, cwd);
  const config: EatConfig = readConfigFile(file) ?? {};
  // scope 不是 dir 时丢掉 dir：留着它，以后切回 dir 会悄悄复活一个早就不对的旧目录
  config.sync = scope === 'dir' ? { scope, dir } : { scope };
  writeConfigFile(file, config);
  // 改配置本身就是「我知道落点要变」的授权，不该在下一次 sync 时再被漂移检测拦一道
  clearSyncTarget();

  console.log(`已写入 ${file}${location === 'project' ? '（只在这个目录下生效）' : ''}`);
  printResolution(cwd, '现在裸跑 eat sync 会落到：');
}

export function configUnset(key: string, opts: FileOpts): void {
  if (!(UNSET_KEYS as readonly string[]).includes(key)) {
    throw new Error(`未知配置项 ${key}，可清除：${UNSET_KEYS.join(' / ')}`);
  }
  const cwd = process.cwd();
  const explicit = opts.project === true || opts.user === true;
  // 不指定文件时两份都清：留一份没清掉的才是真正会让人困惑的状态
  const targets = explicit
    ? [pickFile(opts, null, cwd).file]
    : [projectConfigFile(cwd), userConfigFile()];
  const unique = targets.filter((f, i) => targets.findIndex((o) => path.resolve(o) === path.resolve(f)) === i);

  let touched = false;
  for (const file of unique) {
    const config = readConfigFile(file);
    if (!config?.sync) continue;
    if (key === 'sync' || key === 'sync.scope') {
      // scope 没了，dir 就是个无人引用的悬空值，一并清掉
      delete config.sync;
    } else {
      delete config.sync.dir;
      if (config.sync.scope === 'dir') delete config.sync.scope;
      if (Object.keys(config.sync).length === 0) delete config.sync;
    }
    // 清空了就把文件删掉，回到「从没配置过」的状态——留一个 {} 只会让 config list 多两行噪音
    if (Object.keys(config).length === 0) removeConfigFile(file);
    else writeConfigFile(file, config);
    console.log(`已清除 ${key} → ${file}`);
    touched = true;
  }
  if (!touched) {
    console.log(`${key} 本来就没有设置，无需清除`);
    return;
  }
  clearSyncTarget();
  printResolution(cwd, '现在裸跑 eat sync 会落到：');
}
