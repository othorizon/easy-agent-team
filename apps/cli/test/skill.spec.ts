import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveExportDir, writeSkillExport, type ExportableSkill } from '../src/commands/skill.js';

const skill = (files: ExportableSkill['files'] = []): ExportableSkill => ({
  slug: 'demo',
  name: '演示 skill',
  version: 3,
  content: '---\nname: demo\n---\n\n正文\n',
  files,
});

describe('resolveExportDir：导出落点', () => {
  const cwd = '/work/my-project';

  it('默认在当前目录下用 slug 建同名目录', () => {
    expect(resolveExportDir('demo', undefined, cwd)).toBe(path.join(cwd, 'demo'));
  });

  it('--out 相对路径按当前目录解析', () => {
    expect(resolveExportDir('demo', 'skills/demo', cwd)).toBe(path.join(cwd, 'skills', 'demo'));
  });

  it('--out 绝对路径原样使用', () => {
    expect(resolveExportDir('demo', '/tmp/x', cwd)).toBe(path.join('/tmp', 'x'));
  });
});

describe('writeSkillExport：写出内容', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-export-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('写出 SKILL.md 与附属文件，恢复可执行位，且不写 .eat-meta.json', () => {
    const dir = path.join(root, 'basic');
    const written = writeSkillExport(
      dir,
      skill([
        { path: 'scripts/run.sh', encoding: 'utf8', content: '#!/bin/sh\necho hi\n', executable: true },
        { path: 'assets/logo.bin', encoding: 'base64', content: Buffer.from([0, 1, 2]).toString('base64'), executable: false },
      ]),
      false,
    );
    expect(written).toEqual(['SKILL.md', 'scripts/run.sh', 'assets/logo.bin']);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('正文');
    expect(fs.readFileSync(path.join(dir, 'scripts/run.sh'), 'utf8')).toContain('echo hi');
    expect(fs.readFileSync(path.join(dir, 'assets/logo.bin'))).toEqual(Buffer.from([0, 1, 2]));
    expect(fs.statSync(path.join(dir, 'scripts/run.sh')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(dir, '.eat-meta.json'))).toBe(false);
  });

  it('目标目录不存在时自动创建，已存在但为空时直接写', () => {
    const dir = path.join(root, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    expect(() => writeSkillExport(dir, skill(), false)).not.toThrow();
  });

  it('目标目录非空时拒绝，--force 覆盖同名文件但保留其他文件', () => {
    const dir = path.join(root, 'busy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '旧内容');
    fs.writeFileSync(path.join(dir, 'notes.md'), '我自己的笔记');
    expect(() => writeSkillExport(dir, skill(), false)).toThrow(/目标目录非空/);
    writeSkillExport(dir, skill(), true);
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('正文');
    expect(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe('我自己的笔记');
  });

  it('--force 覆盖时按新内容重置权限位，且不顺着软链写到目录外', () => {
    const dir = path.join(root, 'overwrite');
    const outside = path.join(root, 'outside.txt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outside, '目录外的文件');
    fs.symlinkSync(outside, path.join(dir, 'SKILL.md'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts/run.sh'), '旧脚本', { mode: 0o644 });

    writeSkillExport(
      dir,
      skill([{ path: 'scripts/run.sh', encoding: 'utf8', content: '#!/bin/sh\n', executable: true }]),
      true,
    );
    expect(fs.lstatSync(path.join(dir, 'SKILL.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('目录外的文件');
    expect(fs.statSync(path.join(dir, 'scripts/run.sh')).mode & 0o111).not.toBe(0);
  });

  it('目标路径是文件时明确报错', () => {
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => writeSkillExport(file, skill(), true)).toThrow(/不是目录/);
  });

  it('附属文件路径越界时拒绝写出（服务端已校验，此处双保险）', () => {
    const dir = path.join(root, 'escape');
    expect(() =>
      writeSkillExport(dir, skill([{ path: '../evil', encoding: 'utf8', content: 'x', executable: false }]), false),
    ).toThrow(/非法文件路径/);
  });
});
