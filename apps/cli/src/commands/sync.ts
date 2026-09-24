import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RenderedMcpConfig, SyncSkill } from '@eat/shared';
import { Api } from '../client.js';
import { loadState, markSkillsSynced, recordSyncTarget } from '../update.js';
import {
  persistSyncChoice,
  resolveSyncRoots,
  type SyncOpts,
  type SyncResolution,
  type SyncSource,
} from '../sync-config.js';

interface EatMeta {
  slug: string;
  name: string;
  version: number;
  source: string;
  relation: string;
  syncedAt: string;
  managed: true;
  files: string[];
}

function readMeta(dir: string): EatMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.eat-meta.json'), 'utf8')) as EatMeta;
    return meta.managed ? meta : null;
  } catch {
    return null;
  }
}

/** 防御性校验：落地路径必须在 skill 目录内（服务端已校验，此处双保险） */
export function safeJoin(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`非法文件路径: ${rel}`);
  }
  return target;
}

function writeSkill(dir: string, skill: SyncSkill): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.content);
  const written: string[] = ['SKILL.md'];
  let hasExecutable = false;
  for (const f of skill.files) {
    const target = safeJoin(dir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content, {
      mode: f.executable ? 0o755 : 0o644,
    });
    if (f.executable) hasExecutable = true;
    written.push(f.path);
  }
  const meta: EatMeta = {
    slug: skill.slug,
    name: skill.name,
    version: skill.version,
    source: skill.source,
    relation: skill.relation,
    syncedAt: new Date().toISOString(),
    managed: true,
    files: written,
  };
  fs.writeFileSync(path.join(dir, '.eat-meta.json'), JSON.stringify(meta, null, 2));
  if (hasExecutable) {
    console.log(`  注意：${skill.slug} 包含可执行脚本，将在你本地以你的权限运行`);
  }
}

/**
 * 删掉路径本身（软链或普通文件），不跟随软链；不存在时静默。
 * 删软链别用 fs.rmSync：Node 23 ~ 24.13.0 / 25.0 ~ 25.3 的 C++ 实现按跟随软链后的类型判断
 * （nodejs/node#61040），指向目录的软链 / junction 报「Path is a directory」，悬空软链被当成
 * 不存在而静默留下。unlink 在 Windows 上同样能删目录软链与 junction：libuv 以不跟随的方式打开，
 * 且可删的范围与 lstat 报 isSymbolicLink() 的范围一致，不需要 rmdir 兜底。
 */
export function unlinkIfExists(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export type LinkStrategy = 'symlink' | 'copy';

/**
 * .claude/skills 的同步方式：类 Unix 用软链，Windows 用复制（决策 24）。
 * Windows 上建符号链接需要管理员或开发者模式，junction 又只支持绝对目标（--project 的相对链接用不了）；
 * skill 是 KB 级文本且 eat sync 是唯一写入方，复制实文件行为等价且零权限依赖。
 */
export function defaultLinkStrategy(platform: string = process.platform): LinkStrategy {
  return platform === 'win32' ? 'copy' : 'symlink';
}

/** 递归复制目录（不用 fs.cpSync：它在 Node 18/20 上仍是 experimental） */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * 把 linkPath 维护成 dir 的镜像（.claude/skills/<slug> → .agents/skills/<slug>）：
 * symlink 策略建软链（relative 时写相对链接，项目目录随仓库移动/克隆后仍有效），copy 策略复制实文件。
 * 历史版本直接落地在 .claude 的受管真实目录会被替换（迁移）；非 eat 管理的占位仅 --force 才覆盖。
 */
export function ensureLink(
  linkPath: string,
  dir: string,
  force: boolean,
  relative: boolean,
  strategy: LinkStrategy = defaultLinkStrategy(),
): 'ok' | 'linked' | 'copied' | 'conflict' {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(linkPath);
  } catch {
    st = undefined;
  }

  if (strategy === 'copy') {
    if (st?.isSymbolicLink()) {
      unlinkIfExists(linkPath); // 换平台/换策略后残留的软链
    } else if (st) {
      const existing = readMeta(linkPath);
      if (!existing && !force) return 'conflict';
      // 受管副本与源同版本、同一次落地（syncedAt 由 writeSkill 刷新）时无需重复复制
      const source = readMeta(dir);
      if (
        !force &&
        existing &&
        source &&
        existing.version === source.version &&
        existing.syncedAt === source.syncedAt
      ) {
        return 'ok';
      }
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
    copyDir(dir, linkPath);
    return 'copied';
  }

  if (st?.isSymbolicLink()) {
    if (path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === dir) return 'ok';
    unlinkIfExists(linkPath);
  } else if (st) {
    if (!readMeta(linkPath) && !force) return 'conflict';
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(relative ? path.relative(path.dirname(linkPath), dir) : dir, linkPath, 'dir');
  return st?.isSymbolicLink() ? 'ok' : 'linked';
}

/**
 * .claude 下同名目录是否会挡住本次同步。判定与 ensureLink 里完全一致（两种策略同一条件），
 * 抽出来是为了 --dry-run 能在不写任何文件的前提下报出同样的冲突。
 */
export function wouldConflict(linkPath: string, force: boolean): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(linkPath);
  } catch {
    return false;
  }
  return !st.isSymbolicLink() && !readMeta(linkPath) && !force;
}

/**
 * 落点漂移检测（决策 56）：**只在回落到内置默认时**拦——上次装在别处，这次却没有任何东西
 * 指定落点，说明配置丢了 / 换了机器 / 有人手删了它，再跑下去就会把 skill 装进
 * ~/.agents/skills，原落点从此不再更新，而 markSkillsSynced() 还会把基线刷成最新，
 * 连「有更新」的提示都一并消失。
 *
 * 判定刻意不含「配置给出的落点和上次不一样」：在项目目录与自定义目录之间来回同步是正常用法，
 * 配置是可见、可查（eat config list）、刻意写下的东西，拦它只会变成次次误报，
 * 而次次误报的拦截等于没有拦截——用的人会固定加上 --yes。
 *
 * 命令行与环境变量显式指定时同样不拦：那本来就是「我现在就要装到这里」。
 * 预演也不拦：它正是排查「这次会装到哪」的手段，拦掉等于把中止信息里给的排查办法堵死。
 */
export function syncTargetDrifted(
  lastTarget: string | undefined,
  target: string,
  source: SyncSource,
  confirmed: boolean,
  dryRun = false,
): boolean {
  if (!lastTarget || lastTarget === target || confirmed || dryRun) return false;
  return source.kind === 'default';
}

/** 决议先于动作打印：中途失败也看得见这次要落到哪，而不是只在成功的末尾打一行 */
export function describeResolution(
  res: SyncResolution,
  strategy: LinkStrategy,
  dryRun: boolean,
  lead = '本次同步：',
): string[] {
  const linkWord = strategy === 'copy' ? '复制' : '软链';
  return [
    `${dryRun ? '[预演] ' : ''}${lead}作用域 ${res.scope}（来源：${res.source.label}）`,
    `  落地目录：${res.target}`,
    `  .claude 同步：${res.linkRoot ? `${res.linkRoot}（${linkWord}）` : '不启用（自定义目录模式）'}`,
  ];
}

export async function sync(opts: SyncOpts): Promise<void> {
  // 实际文件落 .agents/skills（跨 Agent 工具共用），.claude/skills 里放软链（Windows 上放副本）；
  // 落点按 命令行 > 环境变量 > 项目配置 > 用户配置 > 内置默认 解析（决策 56），
  // 自定义目录（--dir / sync.scope=dir）直接落该目录、不建任何链接。
  const cwd = process.cwd();
  const res = resolveSyncRoots(opts, cwd);
  const { target, linkRoot, relativeLinks, source } = res;
  const strategy = defaultLinkStrategy();
  const linkWord = strategy === 'copy' ? '复制' : '软链';
  const dryRun = opts.dryRun ?? false;

  for (const line of describeResolution(res, strategy, dryRun)) console.log(line);

  const lastTarget = loadState().lastSyncTarget;
  if (syncTargetDrifted(lastTarget, target, source, opts.yes ?? false, dryRun)) {
    const hint = [
      '没有任何配置指定落点，而上次同步装在别处，已中止（继续跑会把 skill 装到默认目录，原落点从此不再更新）',
      `      上次落点：${lastTarget}`,
      `      本次落点：${target}（来源：${source.label}）`,
      `      装回上次的位置（并记住它）：eat sync --dir ${lastTarget}`,
      '      确实要改用默认目录：eat sync --yes',
      '      先看看会发生什么：eat sync --dry-run',
    ].join('\n');
    throw new Error(hint);
  }
  if (dryRun && lastTarget && lastTarget !== target) {
    console.log(`  注意：上次同步落在 ${lastTarget}，与本次不同`);
  }

  const api = Api.fromSaved();
  if (!dryRun) {
    fs.mkdirSync(target, { recursive: true });
    if (linkRoot) fs.mkdirSync(linkRoot, { recursive: true });
  }
  const bundle = await api.request<SyncSkill[]>('GET', '/api/skills/sync-bundle');

  const added: string[] = [];
  const updated: string[] = [];
  const upToDate: string[] = [];
  const conflicts: string[] = [];
  const linkConflicts: string[] = [];
  let linkFailed: string | null = null;

  for (const skill of bundle) {
    const dir = path.join(target, skill.slug);
    const meta = fs.existsSync(dir) ? readMeta(dir) : null;
    if (!fs.existsSync(dir)) {
      if (!dryRun) writeSkill(dir, skill);
      added.push(skill.slug);
    } else if (!meta && !opts.force) {
      conflicts.push(skill.slug);
      continue;
    } else if (meta && meta.version === skill.version && !opts.force) {
      upToDate.push(skill.slug);
    } else {
      if (!dryRun) writeSkill(dir, skill);
      updated.push(`${skill.slug}（v${meta?.version ?? '?'} → v${skill.version}）`);
    }
    if (!linkRoot) continue;
    const linkPath = path.join(linkRoot, skill.slug);
    if (dryRun) {
      if (wouldConflict(linkPath, opts.force ?? false)) linkConflicts.push(skill.slug);
      continue;
    }
    try {
      if (ensureLink(linkPath, dir, opts.force ?? false, relativeLinks, strategy) === 'conflict') {
        linkConflicts.push(skill.slug);
      }
    } catch (err) {
      linkFailed = err instanceof Error ? err.message : String(err);
    }
  }

  // 清理：受管但已不在同步范围（退订/删除/不可见）的 skill，连同 .claude 里的软链/副本/历史落地
  const bundleSlugs = new Set(bundle.map((s) => s.slug));
  const removed: string[] = [];
  if (fs.existsSync(target)) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(target, entry.name);
      const meta = readMeta(dir);
      if (meta && !bundleSlugs.has(meta.slug)) {
        if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
        removed.push(meta.slug);
      }
    }
  }
  if (linkRoot && !dryRun) {
    for (const entry of fs.readdirSync(linkRoot, { withFileTypes: true })) {
      const p = path.join(linkRoot, entry.name);
      if (entry.isSymbolicLink()) {
        // 指向 target 内但源已被清理的悬空链接（相对链接先解析回绝对路径）
        const to = path.resolve(linkRoot, fs.readlinkSync(p));
        if (to.startsWith(target + path.sep) && !fs.existsSync(to)) unlinkIfExists(p);
      } else if (entry.isDirectory()) {
        // Windows 副本、以及历史版本直接落地在 .claude 的受管目录：不在同步范围则一并清理
        const meta = readMeta(p);
        if (meta && !bundleSlugs.has(meta.slug)) fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }

  const verb = dryRun ? '将同步' : '同步完成';
  console.log(`Skill ${verb} → ${target}${linkRoot ? `（${dryRun ? '并' : '已'}${linkWord}到 ${linkRoot}）` : ''}`);
  if (added.length) console.log(`  ${dryRun ? '将新增' : '新增'}: ${added.join(', ')}`);
  if (updated.length) console.log(`  ${dryRun ? '将更新' : '更新'}: ${updated.join(', ')}`);
  if (removed.length) console.log(`  ${dryRun ? '将移除' : '移除'}(退订/已删除): ${removed.join(', ')}`);
  if (upToDate.length) console.log(`  已是最新: ${upToDate.length} 个`);
  if (conflicts.length) {
    console.log(`  跳过(目录已存在但非 eat 管理): ${conflicts.join(', ')}`);
    console.log('  如确认覆盖这些目录，重新运行: eat sync --force');
  }
  if (linkConflicts.length) {
    console.log(`  未${linkWord}(.claude 下同名目录非 eat 管理): ${linkConflicts.join(', ')}，--force 可覆盖`);
  }
  if (linkFailed) {
    console.log(`  ${linkWord}到 ${linkRoot} 失败（${linkFailed}）；skill 已落地 ${target}，请把该目录加入你的 Agent skill 搜索路径`);
  }
  if (bundle.length === 0) console.log('  （没有订阅任何 skill；eat skill list 看看团队里有什么）');

  await syncMcpConfigs(api, dryRun);

  if (dryRun) {
    console.log('\n以上为预演，未写入任何文件。确认无误后去掉 --dry-run 执行。');
    return;
  }

  // 本次落地的指纹记为基线：后续任何命令的响应头与它不一致即说明本地落后（决策 26）
  markSkillsSynced();
  recordSyncTarget(target);

  // 显式指定过的落点记进配置，让之后裸跑的 eat sync（更新提示里写的就是它）落到同一个地方。
  // 环境变量不落盘：它是本进程的一次性设定，持久化会让人意外。
  if (source.kind === 'flag' && opts.save !== false) {
    const saved = persistSyncChoice(res.scope, target, cwd);
    console.log(`\n已记住本次落点：后续 eat sync 继续同步到 ${target}`);
    console.log(
      `  写入 ${saved.file}${saved.location === 'project' ? '（只在这个目录下生效）' : ''}；恢复默认执行 eat config unset sync，本次不记用 --no-save`,
    );
  }
}

/** MCP 配置：按权限渲染后写入 ~/.eat/mcp.generated.json，由用户合并进自己的 MCP 配置 */
async function syncMcpConfigs(api: Api, dryRun = false): Promise<void> {
  const rendered = await api.request<RenderedMcpConfig[]>('GET', '/api/mcp-configs/sync-bundle');
  if (rendered.length === 0) return;
  const outPath = path.join(os.homedir(), '.eat', 'mcp.generated.json');
  if (dryRun) {
    console.log(`\nMCP 配置将渲染 → ${outPath}（${rendered.length} 个）`);
    return;
  }
  const mcpServers = Object.fromEntries(rendered.map((r) => [r.slug, r.server]));
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  console.log(`\nMCP 配置已渲染 → ${outPath}（${rendered.length} 个）`);
  console.log('  合并到 Claude Code: 对每个条目执行 claude mcp add-json <名称> \'<配置 JSON>\'，或复制进项目 .mcp.json');
  const viaGateway = rendered.filter((r) => r.viaGateway);
  if (viaGateway.length > 0) {
    console.log(`  其中 ${viaGateway.length} 个经平台分发，配置里是只属于你的接入地址（${viaGateway.map((r) => r.slug).join('、')}）`);
    console.log('  这个地址等同于密钥：别提交进仓库、别贴进公开渠道；疑似泄漏就在控制台重新生成，旧地址立即作废');
  }
  const unresolved = rendered.filter((r) => r.unresolved.length > 0);
  for (const r of unresolved) {
    console.log(`  注意: ${r.slug} 有 ${r.unresolved.length} 个引用因无权限未解析：`);
    for (const u of r.unresolved) {
      console.log(`    ${u.ref} → eat env request ${u.environment} ${u.key} --reason "<用途>"`);
    }
  }
}
