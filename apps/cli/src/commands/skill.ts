import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PushSkillRequest, SkillDetail, SkillFile, SkillInfo } from '@eat/shared';
import { Api } from '../client.js';

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
