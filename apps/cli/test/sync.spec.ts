import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultLinkStrategy, ensureLink, unlinkIfExists } from '../src/commands/sync.js';

describe('ensureLink：软链维护', () => {
  let root: string;
  let agents: string;
  let claude: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-sync-'));
    agents = path.join(root, '.agents', 'skills');
    claude = path.join(root, '.claude', 'skills');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(claude, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function mkSkillDir(slug: string): string {
    const dir = path.join(agents, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# x\n');
    return dir;
  }

  it('绝对软链：新建后再跑一次是幂等的 ok', () => {
    const dir = mkSkillDir('abs');
    const link = path.join(claude, 'abs');
    expect(ensureLink(link, dir, false, false)).toBe('linked');
    expect(fs.readlinkSync(link)).toBe(dir);
    expect(ensureLink(link, dir, false, false)).toBe('ok');
  });

  it('相对软链（--project）：链接内容是相对路径，且能解析回真实目录', () => {
    const dir = mkSkillDir('rel');
    const link = path.join(claude, 'rel');
    expect(ensureLink(link, dir, false, true)).toBe('linked');
    const raw = fs.readlinkSync(link);
    expect(path.isAbsolute(raw)).toBe(false);
    expect(path.resolve(claude, raw)).toBe(dir);
    expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe('# x\n');
    // 已存在的相对链接同样幂等
    expect(ensureLink(link, dir, false, true)).toBe('ok');
    // 相对/绝对写法互认：现有相对链接指向同一目录时不重建
    expect(ensureLink(link, dir, false, false)).toBe('ok');
  });

  it('历史受管真实目录被迁移为软链', () => {
    const dir = mkSkillDir('migrate');
    const legacy = path.join(claude, 'migrate');
    fs.mkdirSync(legacy);
    fs.writeFileSync(
      path.join(legacy, '.eat-meta.json'),
      JSON.stringify({ slug: 'migrate', managed: true }),
    );
    expect(ensureLink(legacy, dir, false, false)).toBe('linked');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
  });

  it('非 eat 管理的同名目录：默认 conflict，--force 才覆盖', () => {
    const dir = mkSkillDir('occupied');
    const link = path.join(claude, 'occupied');
    fs.mkdirSync(link);
    fs.writeFileSync(path.join(link, 'SKILL.md'), '# 用户自己的\n');
    expect(ensureLink(link, dir, false, false)).toBe('conflict');
    expect(fs.lstatSync(link).isDirectory()).toBe(true);
    expect(ensureLink(link, dir, true, false)).toBe('linked');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('指向别处的软链被改指到当前目录，旧目标目录原样保留', () => {
    const dir = mkSkillDir('moved');
    const elsewhere = path.join(root, 'elsewhere', 'moved');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), '# 旧位置\n');
    const link = path.join(claude, 'moved');
    fs.symlinkSync(elsewhere, link, 'dir');
    expect(ensureLink(link, dir, false, false)).toBe('ok');
    expect(fs.readlinkSync(link)).toBe(dir);
    expect(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf8')).toBe('# 旧位置\n');
  });

  it('悬空软链（旧目标已不存在）同样被改指', () => {
    const dir = mkSkillDir('dangling');
    const link = path.join(claude, 'dangling');
    fs.symlinkSync(path.join(root, 'gone', 'dangling'), link, 'dir');
    expect(ensureLink(link, dir, false, false)).toBe('ok');
    expect(fs.readlinkSync(link)).toBe(dir);
  });
});

describe('unlinkIfExists：只删链接本身，不跟随', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-unlink-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Node 23 ~ 24.13.0 / 25.0 ~ 25.3 的 fs.rmSync 会跟随软链判断类型：指向目录的软链报
  // 「Path is a directory」、悬空软链被当成不存在而静默留下（nodejs/node#61040）
  it('指向目录的软链：删掉链接，目标目录与内容不动', () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'SKILL.md'), '# x\n');
    const link = path.join(root, 'to-dir');
    fs.symlinkSync(target, link, 'dir');
    unlinkIfExists(link);
    expect(fs.existsSync(link)).toBe(false);
    expect(() => fs.lstatSync(link)).toThrow();
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('# x\n');
  });

  it('悬空软链：确实被删掉，而不是当成不存在跳过', () => {
    const link = path.join(root, 'dangling');
    fs.symlinkSync(path.join(root, 'nowhere'), link, 'dir');
    unlinkIfExists(link);
    expect(() => fs.lstatSync(link)).toThrow();
  });

  it('普通文件照删，路径不存在时静默', () => {
    const file = path.join(root, 'plain.txt');
    fs.writeFileSync(file, 'x');
    unlinkIfExists(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => unlinkIfExists(path.join(root, 'missing'))).not.toThrow();
  });
});

describe('defaultLinkStrategy：按平台选同步方式（决策 24）', () => {
  it('Windows 用复制，其余平台用软链', () => {
    expect(defaultLinkStrategy('win32')).toBe('copy');
    expect(defaultLinkStrategy('darwin')).toBe('symlink');
    expect(defaultLinkStrategy('linux')).toBe('symlink');
  });
});

describe('ensureLink copy 策略：Windows 上复制实文件', () => {
  let root: string;
  let agents: string;
  let claude: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-sync-copy-'));
    agents = path.join(root, '.agents', 'skills');
    claude = path.join(root, '.claude', 'skills');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(claude, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** 造一个受管 skill 目录（含 .eat-meta.json，与 writeSkill 落地的结构一致） */
  function mkManagedSkill(slug: string, version: number, syncedAt: string): string {
    const dir = path.join(agents, slug);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${slug} v${version}\n`);
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n');
    fs.writeFileSync(
      path.join(dir, '.eat-meta.json'),
      JSON.stringify({ slug, name: slug, version, managed: true, syncedAt }),
    );
    return dir;
  }

  it('首次复制整棵目录（含子目录），再跑一次是幂等的 ok', () => {
    const dir = mkManagedSkill('copied', 1, '2026-01-01T00:00:00.000Z');
    const dest = path.join(claude, 'copied');
    expect(ensureLink(dest, dir, false, false, 'copy')).toBe('copied');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# copied v1\n');
    expect(fs.readFileSync(path.join(dest, 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
    expect(ensureLink(dest, dir, false, false, 'copy')).toBe('ok');
  });

  it('源被重新落地（版本或 syncedAt 变化）时副本随之更新', () => {
    const dir = mkManagedSkill('bumped', 1, '2026-01-01T00:00:00.000Z');
    const dest = path.join(claude, 'bumped');
    expect(ensureLink(dest, dir, false, false, 'copy')).toBe('copied');
    mkManagedSkill('bumped', 2, '2026-02-02T00:00:00.000Z');
    expect(ensureLink(dest, dir, false, false, 'copy')).toBe('copied');
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# bumped v2\n');
  });

  it('非 eat 管理的同名目录：默认 conflict 且原样保留，--force 才覆盖', () => {
    const dir = mkManagedSkill('taken', 1, '2026-01-01T00:00:00.000Z');
    const dest = path.join(claude, 'taken');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '# 用户自己的\n');
    expect(ensureLink(dest, dir, false, false, 'copy')).toBe('conflict');
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# 用户自己的\n');
    expect(ensureLink(dest, dir, true, false, 'copy')).toBe('copied');
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# taken v1\n');
  });

  it('历史遗留的软链被替换为副本（换平台/换策略后的迁移）', () => {
    const dir = mkManagedSkill('waslink', 1, '2026-01-01T00:00:00.000Z');
    const dest = path.join(claude, 'waslink');
    fs.symlinkSync(dir, dest, 'dir');
    expect(ensureLink(dest, dir, false, false, 'copy')).toBe('copied');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# waslink v1\n');
    // 源目录没被连带删除
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
  });

  it('遗留的悬空软链同样被替换为副本', () => {
    const dir = mkManagedSkill('wasdangling', 1, '2026-01-01T00:00:00.000Z');
    const dest = path.join(claude, 'wasdangling');
    fs.symlinkSync(path.join(root, 'gone', 'wasdangling'), dest, 'dir');
    expect(ensureLink(dest, dir, false, false, 'copy')).toBe('copied');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# wasdangling v1\n');
  });
});
