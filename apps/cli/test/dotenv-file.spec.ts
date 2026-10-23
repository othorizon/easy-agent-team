import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EAT_MARKER, isEatGenerated, mergeEnvFile, stripEatHeader, writeEnvFile } from '../src/dotenv-file.js';
import { parseEnvText } from '../src/dotenv-format.js';

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

describe('mergeEnvFile：pull --merge 合并进已有文件', () => {
  const merge = (values: Record<string, string>) =>
    mergeEnvFile({ file: file(), values: Object.entries(values), command: 'eat env pull demo' });

  it('同名 key 原地改值、新 key 追加到末尾，其余行与注释一字不动；不加 eat 标记', () => {
    const mine = '# 我的本地配置\nexport DB_HOST=localhost\nLOCAL_ONLY=keep  # 留着\n\nAPI_URL=old\n\n';
    fs.writeFileSync(file(), mine);
    const r = merge({ API_URL: 'https://new', TOKEN: 'a b', DB_HOST: 'localhost' });
    expect(r).toMatchObject({ written: true, created: false });
    expect(r.diff).toEqual({ added: ['TOKEN'], changed: ['API_URL'], removed: [], unchanged: 1 });
    const out = read();
    expect(out.startsWith('# 我的本地配置\nexport DB_HOST=localhost\nLOCAL_ONLY=keep  # 留着\n\nAPI_URL=https://new\n')).toBe(true);
    expect(out).toMatch(/\n\n# 以下由 eat env pull demo 追加 @ [^\n]+\nTOKEN='a b'\n$/);
    expect(isEatGenerated(file())).toBe(false);
    expect(Object.fromEntries(parseEnvText(out).values)).toEqual({
      DB_HOST: 'localhost',
      LOCAL_ONLY: 'keep',
      API_URL: 'https://new',
      TOKEN: 'a b',
    });
  });

  it('改了别人文件里已有的值先备份；只追加新 key 不备份', () => {
    fs.writeFileSync(file(), 'A=1\n');
    expect(merge({ B: '2' }).backup).toBeNull();
    const before = read();
    const r = merge({ A: 'changed' });
    expect(r.backup).toBeTruthy();
    expect(fs.readFileSync(r.backup as string, 'utf8')).toBe(before);
  });

  it('eat 写的文件合并时不备份，原有标记保留', () => {
    writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo' });
    const r = merge({ A: '2', B: '3' });
    expect(r.backup).toBeNull();
    expect(isEatGenerated(file())).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['.env']);
  });

  it('值全都一致时不动文件', () => {
    fs.writeFileSync(file(), 'A=1\nB="x y"\n');
    const mtime = fs.statSync(file()).mtimeMs;
    const r = merge({ A: '1', B: 'x y' });
    expect(r).toMatchObject({ written: false, backup: null });
    expect(r.diff).toMatchObject({ added: [], changed: [], unchanged: 2 });
    expect(fs.statSync(file()).mtimeMs).toBe(mtime);
  });

  it('多行值整段替换；同名出现多次时改最后一处（dotenv 取最后一次）', () => {
    fs.writeFileSync(file(), 'PEM="line1\nline2"\nA=first\nA=second\nZ=end\n');
    merge({ PEM: 'new\npem', A: 'third' });
    const p = parseEnvText(read());
    expect(p.values.get('PEM')).toBe('new\npem');
    expect(read()).toContain('A=first\nA=third\nZ=end');
  });

  it('保留 CRLF 换行风格', () => {
    fs.writeFileSync(file(), 'A=1\r\nB=2\r\n');
    merge({ B: '3', C: '4' });
    expect(read()).toMatch(/^A=1\r\nB=3\r\n\r\n# 以下由 [^\r\n]+\r\nC=4\r\n$/);
  });

  it('引号没闭合时中止，文件不动', () => {
    const broken = 'A=1\nB="open\nC=3\n';
    fs.writeFileSync(file(), broken);
    expect(() => merge({ A: '2' })).toThrow(/第 2 行.*已中止合并/);
    expect(read()).toBe(broken);
  });

  it('文件不存在时就是一次普通写入（带标记）', () => {
    const r = merge({ A: '1' });
    expect(r.created).toBe(true);
    expect(isEatGenerated(file())).toBe(true);
  });
});

describe('writeEnvFile 中止时给 env pull 多一条 --merge 出路', () => {
  it('mergeHint 时提示 --merge', () => {
    fs.writeFileSync(file(), 'LOCAL_ONLY=keep\n');
    expect(() => writeEnvFile({ file: file(), content: 'A=1', command: 'eat env pull demo', mergeHint: true })).toThrow(
      /eat env pull demo --merge/,
    );
  });
});
