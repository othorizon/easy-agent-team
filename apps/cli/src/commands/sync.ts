import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RenderedMcpConfig, SyncSkill } from '@eat/shared';
import { Api } from '../client.js';

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
function safeJoin(base: string, rel: string): string {
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
 * 把 linkPath 维护成指向 dir 的软链接（~/.claude/skills/<slug> → ~/.agents/skills/<slug>）。
 * 历史版本直接落地在 .claude 的受管真实目录会被替换为链接（迁移）；非 eat 管理的占位仅 --force 才覆盖。
 */
function ensureLink(linkPath: string, dir: string, force: boolean): 'ok' | 'linked' | 'conflict' {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(linkPath);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink()) {
    if (fs.readlinkSync(linkPath) === dir) return 'ok';
    fs.rmSync(linkPath, { force: true });
  } else if (st) {
    if (!readMeta(linkPath) && !force) return 'conflict';
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(dir, linkPath, 'dir');
  return st?.isSymbolicLink() ? 'ok' : 'linked';
}

export async function sync(opts: { dir?: string; force?: boolean }): Promise<void> {
  // 实际文件落 ~/.agents/skills（跨 Agent 工具共用），~/.claude/skills 里只放软链接；
  // 指定 --dir 时直接落该目录，不建链接（保持可预期）。
  const defaultMode = !opts.dir;
  const target = path.resolve(opts.dir ?? path.join(os.homedir(), '.agents', 'skills'));
  const linkRoot = path.join(os.homedir(), '.claude', 'skills');
  fs.mkdirSync(target, { recursive: true });
  if (defaultMode) fs.mkdirSync(linkRoot, { recursive: true });
  const api = Api.fromSaved();
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
      writeSkill(dir, skill);
      added.push(skill.slug);
    } else if (!meta && !opts.force) {
      conflicts.push(skill.slug);
      continue;
    } else if (meta && meta.version === skill.version && !opts.force) {
      upToDate.push(skill.slug);
    } else {
      writeSkill(dir, skill);
      updated.push(`${skill.slug}（v${meta?.version ?? '?'} → v${skill.version}）`);
    }
    if (defaultMode) {
      try {
        if (ensureLink(path.join(linkRoot, skill.slug), dir, opts.force ?? false) === 'conflict') {
          linkConflicts.push(skill.slug);
        }
      } catch (err) {
        linkFailed = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // 清理：受管但已不在同步范围（退订/删除/不可见）的 skill，连同 .claude 里的软链接/历史落地
  const bundleSlugs = new Set(bundle.map((s) => s.slug));
  const removed: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(target, entry.name);
    const meta = readMeta(dir);
    if (meta && !bundleSlugs.has(meta.slug)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(meta.slug);
    }
  }
  if (defaultMode) {
    for (const entry of fs.readdirSync(linkRoot, { withFileTypes: true })) {
      const p = path.join(linkRoot, entry.name);
      if (entry.isSymbolicLink()) {
        // 指向 target 内但源已被清理的悬空链接
        const to = fs.readlinkSync(p);
        if (to.startsWith(target + path.sep) && !fs.existsSync(to)) fs.rmSync(p, { force: true });
      } else if (entry.isDirectory()) {
        // 历史版本直接落地在 .claude 的受管目录：不在同步范围则一并清理
        const meta = readMeta(p);
        if (meta && !bundleSlugs.has(meta.slug)) fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }

  console.log(`Skill 同步完成 → ${target}${defaultMode ? `（已软链到 ${linkRoot}）` : ''}`);
  if (added.length) console.log(`  新增: ${added.join(', ')}`);
  if (updated.length) console.log(`  更新: ${updated.join(', ')}`);
  if (removed.length) console.log(`  移除(退订/已删除): ${removed.join(', ')}`);
  if (upToDate.length) console.log(`  已是最新: ${upToDate.length} 个`);
  if (conflicts.length) {
    console.log(`  跳过(目录已存在但非 eat 管理): ${conflicts.join(', ')}`);
    console.log('  如确认覆盖这些目录，重新运行: eat sync --force');
  }
  if (linkConflicts.length) {
    console.log(`  未建软链(.claude 下同名目录非 eat 管理): ${linkConflicts.join(', ')}，--force 可覆盖`);
  }
  if (linkFailed) {
    console.log(`  软链接创建失败（${linkFailed}）；skill 已落地 ${target}，请把该目录加入你的 Agent skill 搜索路径`);
  }
  if (bundle.length === 0) console.log('  （没有订阅任何 skill；eat skill list 看看团队里有什么）');

  await syncMcpConfigs(api);
}

/** MCP 配置：按权限渲染后写入 ~/.eat/mcp.generated.json，由用户合并进自己的 MCP 配置 */
async function syncMcpConfigs(api: Api): Promise<void> {
  const rendered = await api.request<RenderedMcpConfig[]>('GET', '/api/mcp-configs/sync-bundle');
  if (rendered.length === 0) return;
  const outPath = path.join(os.homedir(), '.eat', 'mcp.generated.json');
  const mcpServers = Object.fromEntries(rendered.map((r) => [r.slug, r.server]));
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  console.log(`\nMCP 配置已渲染 → ${outPath}（${rendered.length} 个）`);
  console.log('  合并到 Claude Code: 对每个条目执行 claude mcp add-json <名称> \'<配置 JSON>\'，或复制进项目 .mcp.json');
  const unresolved = rendered.filter((r) => r.unresolved.length > 0);
  for (const r of unresolved) {
    console.log(`  注意: ${r.slug} 有 ${r.unresolved.length} 个引用因无权限未解析：`);
    for (const u of r.unresolved) {
      console.log(`    ${u.ref} → eat env request ${u.environment} ${u.key} --reason "<用途>"`);
    }
  }
}
