import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EAT_MARKER, isEatGenerated, stripEatHeader, writeEnvFile } from '../src/dotenv-file.js';

let dir: string;
const file = (name = '.env'): string => path.join(dir, name);
const read = (name = '.env'): string => fs.readFileSync(file(name), 'utf8');

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eat-dotenv-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeEnvFile：同名文件的处置（决策 63）', () => {
  it('文件不存在时照写，并带上 eat 标记头', () => {
    const r = writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo' });
    expect(r.created).toBe(true);
    expect(r.diff).toBeNull();
    expect(read().startsWith(`${EAT_MARKER} — eat env pull demo @ `)).toBe(true);
    expect(read()).toContain('\nA=1\n');
    expect(isEatGenerated(file())).toBe(true);
  });

  it('命中 eat 标记的文件照常覆盖，并给出 key 级变化（只有 key）', () => {
    writeEnvFile({ file: file(), content: 'A=1\nB=2\nC=3', command: 'eat env pull demo' });
    const r = writeEnvFile({ file: file(), content: 'A=1\nB=changed\nD=4', command: 'eat env pull demo' });
    expect(r.created).toBe(false);
    expect(r.backup).toBeNull();
    expect(r.diff).toMatchObject({ added: ['D'], changed: ['B'], removed: ['C'], unchanged: 1 });
    // 头不会层层累积：仍只有一行标记
    expect(read().split('\n').filter((l) => l.startsWith(EAT_MARKER))).toHaveLength(1);
  });

  it('不是 eat 写的文件：中止、退出前不落任何改动', () => {
    const mine = '# 我自己维护的\nLOCAL_ONLY=keep\n';
    fs.writeFileSync(file(), mine);
    expect(() => writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo' })).toThrow(
      /已存在，且不是 eat 生成的/,
    );
    expect(read()).toBe(mine);
    expect(fs.readdirSync(dir)).toEqual(['.env']); // 没留下临时文件、没留下备份
  });

  it('中止时给出三条可执行出路（--out / --print / --force）', () => {
    fs.writeFileSync(file(), 'LOCAL_ONLY=keep\n');
    let msg = '';
    try {
      writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('--out');
    expect(msg).toContain('--print');
    expect(msg).toContain('--force');
  });

  it('--force 覆盖别人的文件前一定先备份', () => {
    const mine = 'LOCAL_ONLY=keep\n';
    fs.writeFileSync(file(), mine);
    const r = writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo', force: true });
    expect(r.backup).toBeTruthy();
    expect(fs.readFileSync(r.backup as string, 'utf8')).toBe(mine);
    expect(read()).toContain('A=1');
    // 被覆盖掉的 key 也报出来，让人知道刚才丢了什么
    expect(r.diff?.removed).toEqual(['LOCAL_ONLY']);
  });

  it('0.5.20 及以前 eat env pull 写的旧头也认，不用 --force', () => {
    fs.writeFileSync(file(), '# 由 eat env pull demo 生成 — 值受平台审计，请勿提交到代码仓库\nA=1\n');
    expect(isEatGenerated(file())).toBe(true);
    expect(() => writeEnvFile({ file: file(), content: 'A=2', command: 'eat env pull demo' })).not.toThrow();
  });

  it.runIf(process.platform !== 'win32')('覆盖已存在的 0644 文件后权限收紧到 0600', () => {
    fs.writeFileSync(file(), `${EAT_MARKER} — eat env pull demo @ 2026-01-01 00:00\nA=1\n`, { mode: 0o644 });
    fs.chmodSync(file(), 0o644);
    writeEnvFile({ file: file(), content: 'A=2', command: 'eat env pull demo' });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('目标是软链时写穿到真实文件，不把软链换成普通文件', () => {
    const real = path.join(dir, 'shared.env');
    fs.writeFileSync(real, `${EAT_MARKER} — eat env pull demo @ 2026-01-01 00:00\nA=1\n`);
    fs.symlinkSync(real, file());
    writeEnvFile({ file: file(), content: 'A=2', command: 'eat env pull demo' });
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toContain('A=2');
  });

  it('--out 指向不存在的子目录时自动建目录', () => {
    const r = writeEnvFile({ file: file(path.join('a', 'b', '.env')), content: 'A=1', command: 'eat env pull demo' });
    expect(fs.existsSync(r.file)).toBe(true);
  });

  it('被 .gitignore 忽略与否如实回报（不在 git 仓库里时不下结论）', () => {
    expect(writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo' }).gitExposed).toBeNull();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo' }).gitExposed).toBe(true);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    expect(writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo' }).gitExposed).toBe(false);
  });
});

describe('stripEatHeader：pull → push 往返不把标记推回平台', () => {
  it('剥掉标记行与紧随其后的提示行', () => {
    writeEnvFile({ file: file(), content: 'A=1\nB=2', command: 'eat app env pull demo' });
    expect(stripEatHeader(read())).toBe('A=1\nB=2\n');
  });

  it('旧头也剥', () => {
    expect(stripEatHeader('# 由 eat env pull demo 生成 — 值受平台审计\nA=1\n')).toBe('A=1\n');
  });

  it('不是 eat 写的内容一个字不动（用户自己的注释要留着）', () => {
    const text = '# 我的注释\nA=1\n';
    expect(stripEatHeader(text)).toBe(text);
  });
});
