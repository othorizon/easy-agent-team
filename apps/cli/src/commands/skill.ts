import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PLATFORM_GUIDE_SLUG,
  type PushSkillRequest,
  type SkillDetail,
  type SkillFile,
  type SkillInfo,
  type SyncSkill,
} from '@eat/shared';
import { Api } from '../client.js';
import { safeJoin } from './sync.js';

const IGNORED = new Set(['node_modules', '.git', '.eat-meta.json']);

/** 简单 frontmatter 解析：仅取 name / description 两个键 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^(name|description):\s*(.+)$/);
    if (m) out[m[1] as 'name' | 'description'] = m[2].trim();
  }
  return out;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function collectFiles(root: string, rel = ''): SkillFile[] {
  const out: SkillFile[] = [];
  const abs = path.join(root, rel);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectFiles(root, childRel));
    } else if (entry.isFile() && childRel !== 'SKILL.md') {
      const buf = fs.readFileSync(path.join(root, childRel));
      const isBinary = buf.includes(0);
      const mode = fs.statSync(path.join(root, childRel)).mode;
      out.push({
        path: childRel,
        encoding: isBinary ? 'base64' : 'utf8',
        content: isBinary ? buf.toString('base64') : buf.toString('utf8'),
        executable: (mode & 0o111) !== 0,
      });
    }
  }
  return out;
}

export async function skillPush(
  dir: string,
  opts: { slug?: string; name?: string; description?: string; changelog?: string; private?: boolean },
): Promise<void> {
  const root = path.resolve(dir);
  const skillMd = path.join(root, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    console.error(`错误: ${root} 下没有 SKILL.md——skill 目录必须包含 SKILL.md`);
    process.exitCode = 1;
    return;
  }
  const content = fs.readFileSync(skillMd, 'utf8');
  const fm = parseFrontmatter(content);
  const name = opts.name ?? fm.name ?? path.basename(root);
  const slug = opts.slug ?? slugify(fm.name ?? path.basename(root));
  if (!slug) {
    console.error('错误: 无法从目录名/名称推导 slug（可能是纯中文），请用 --slug 指定');
    process.exitCode = 1;
    return;
  }
  const payload: PushSkillRequest = {
    slug,
    name,
    description: opts.description ?? fm.description ?? '',
    content,
    files: collectFiles(root),
    changelog: opts.changelog ?? '',
    ...(opts.private ? { visibility: 'private' as const } : {}),
  };
  const api = Api.fromSaved();
  const res = await api.request<SkillDetail>('POST', '/api/skills/push', payload);
  console.log(
    `已推送 ${res.slug} v${res.currentVersion}（${res.files.length} 个附属文件，可见性: ${res.visibility}）`,
  );
  if (res.currentVersion === 1) {
    console.log('这是新建的 skill，团队成员现在可以在控制台或 eat skill list 里看到并订阅它。');
  }
}

export async function skillList(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<SkillInfo[]>('GET', '/api/skills');
  if (rows.length === 0) {
    console.log('平台上还没有可见的 skill。用 eat skill push <目录> 上传第一个。');
    return;
  }
  for (const s of rows) {
    const mark = s.subscribed ? '●' : '○';
    const vis = s.visibility === 'private' ? ' [私有]' : '';
    console.log(`${mark} ${s.slug} v${s.currentVersion}${vis}  ${s.name} — ${s.description}（作者: ${s.ownerName}）`);
  }
  console.log('\n● 已订阅（eat sync 会落地到本地）  ○ 未订阅（eat skill subscribe <slug> 订阅）');
}

export async function skillSubscribe(slug: string): Promise<void> {
  await Api.fromSaved().request('POST', `/api/skills/${slug}/subscribe`);
  console.log(`已订阅 ${slug}，运行 eat sync 落地到本地`);
}

export async function skillUnsubscribe(slug: string): Promise<void> {
  await Api.fromSaved().request('DELETE', `/api/skills/${slug}/subscribe`);
  console.log(`已退订 ${slug}，下次 eat sync 时会从本地移除`);
}

export interface SkillExportOpts {
  out?: string;
  force?: boolean;
}

/** 导出落点：--out 优先（相对当前目录解析），否则在当前目录下建与 slug 同名的目录 */
export function resolveExportDir(slug: string, out: string | undefined, cwd = process.cwd()): string {
  return path.resolve(cwd, out ?? slug);
}

/** 导出用的 skill 内容视图：平台 skill 与内置指南的公共部分 */
export interface ExportableSkill {
  slug: string;
  name: string;
  version: number;
  content: string;
  files: SkillFile[];
}

/**
 * 先删后写：--force 覆盖时目标可能是一个软链（写进去会顺着链接改到目录外的文件），
 * 也可能带着旧的权限位（mode 只在创建时生效，原地覆盖恢复不了可执行位）。
 */
function writeFile(target: string, content: string | Buffer, executable: boolean): void {
  fs.rmSync(target, { force: true });
  fs.writeFileSync(target, content, { mode: executable ? 0o755 : 0o644 });
}

/**
 * 把 skill 内容写到 dir，返回写出的相对路径列表。
 *
 * 与 eat sync 的落地有两点刻意不同：① 不写 .eat-meta.json——导出的是可自由编辑、
 * 可再 push 的工作副本，不该被 sync 当成受管目录接管；② 目标目录非空时必须显式 --force，
 * 且 --force 也只覆盖同名文件、不清空目录（导出路径由用户随手指定，不能像受管目录那样整个删掉重建）。
 */
export function writeSkillExport(dir: string, skill: ExportableSkill, force: boolean): string[] {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(dir);
  } catch {
    st = undefined;
  }
  if (st && !st.isDirectory()) {
    throw new Error(`目标路径已存在且不是目录: ${dir}`);
  }
  if (st && fs.readdirSync(dir).length > 0 && !force) {
    throw new Error(`目标目录非空: ${dir}；换一个 --out，或用 --force 覆盖其中的同名文件`);
  }

  const written: string[] = [];
  fs.mkdirSync(dir, { recursive: true });
  writeFile(path.join(dir, 'SKILL.md'), skill.content, false);
  written.push('SKILL.md');
  for (const f of skill.files) {
    const target = safeJoin(dir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFile(target, f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content, f.executable);
    written.push(f.path);
  }
  return written;
}

async function fetchExportable(slug: string): Promise<ExportableSkill> {
  const api = Api.fromSaved();
  if (slug === PLATFORM_GUIDE_SLUG) {
    // 内置指南不落库，GET /api/skills/:slug 查不到；从 sync-bundle 取（每个用户都有这一条）
    const bundle = await api.request<SyncSkill[]>('GET', '/api/skills/sync-bundle');
    const guide = bundle.find((s) => s.slug === PLATFORM_GUIDE_SLUG);
    if (!guide) throw new Error(`平台未提供内置 skill ${slug}`);
    return { slug: guide.slug, name: guide.name, version: guide.version, content: guide.content, files: guide.files };
  }
  const d = await api.request<SkillDetail>('GET', `/api/skills/${slug}`);
  return { slug: d.slug, name: d.name, version: d.currentVersion, content: d.content, files: d.files };
}

export async function skillExport(slug: string, opts: SkillExportOpts): Promise<void> {
  const dir = resolveExportDir(slug, opts.out);
  const skill = await fetchExportable(slug);
  const written = writeSkillExport(dir, skill, opts.force ?? false);
  console.log(`已导出 ${skill.slug} v${skill.version}「${skill.name}」→ ${dir}（${written.length} 个文件）`);
  if (skill.files.some((f) => f.executable)) {
    console.log('  注意：其中包含可执行脚本，运行前先读一遍内容');
  }
  if (slug === PLATFORM_GUIDE_SLUG) {
    console.log('  这是平台内置指南的只读副本：它由 eat sync 自动分发与更新，改了也推不回平台。');
  } else {
    const rel = path.relative(process.cwd(), dir) || '.';
    console.log(`  改完推回平台：eat skill push ${rel}（仅作者可推新版本）`);
    console.log(`  想基于它做自己的一份：eat skill push ${rel} --slug <你的 slug>，并改掉 SKILL.md 里的 name`);
  }
}
