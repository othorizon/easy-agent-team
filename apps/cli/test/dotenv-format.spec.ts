import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  formatDotenvLine,
  formatDotenvValue,
  formatShellLine,
  parseEnvInput,
  parseEnvText,
} from '../src/dotenv-format.js';

const TRICKY = [
  'plain-value_1.2:3/4@x',
  '',
  'has space',
  ' leading and trailing ',
  'dollar $HOME and ${PATH}',
  'hash # not a comment',
  'C:\\Users\\me\\path',
  'regex \\d+\\s*',
  'double "quotes" inside',
  "single 'quotes' inside",
  "both ' and \" and \\ together",
  'line1\nline2\nline3',
  '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
  'tab\there',
  'emoji 🚀 中文',
];

describe('formatDotenvValue ↔ parseEnvText：pull 写出的值 push 回去不变', () => {
  it('各种难缠的值往返一致', () => {
    const text = TRICKY.map((v, i) => formatDotenvLine(`K${i}`, v)).join('\n');
    const parsed = parseEnvText(text);
    expect(parsed.errors).toEqual([]);
    TRICKY.forEach((v, i) => expect(parsed.values.get(`K${i}`)).toBe(v));
  });

  it('简单值裸写，单行且无单引号的用单引号（字面量，不会被当成 $变量展开），其余用双引号转义', () => {
    expect(formatDotenvValue('abc-1.2')).toBe('abc-1.2');
    expect(formatDotenvValue('a $b')).toBe("'a $b'");
    expect(formatDotenvValue("it's")).toBe('"it\'s"');
    expect(formatDotenvValue('a\nb')).toBe('"a\\nb"');
  });
});

describe('parseEnvText：手写文件的常见写法', () => {
  it('注释、空行、export 前缀、行尾注释、各种引号', () => {
    const p = parseEnvText(
      [
        '\uFEFF# 注释',
        '',
        'export A=1',
        'B = two  # 行尾注释',
        'C="x\\ny"  # 注释',
        "D='lit\\n'",
        'E=`back`',
        'F=',
        'G= # 只有注释',
        'H=a#b',
      ].join('\r\n'),
    );
    expect(p.errors).toEqual([]);
    expect(Object.fromEntries(p.values)).toEqual({
      A: '1',
      B: 'two',
      C: 'x\ny',
      D: 'lit\\n',
      E: 'back',
      F: '',
      G: '',
      H: 'a#b',
    });
    expect(p.entries.find((e) => e.key === 'A')?.exported).toBe(true);
  });

  it('引号值可以跨行，记录起止行', () => {
    const p = parseEnvText('A=1\nPEM="-----BEGIN-----\nabc\n-----END-----"\nB=2');
    expect(p.values.get('PEM')).toBe('-----BEGIN-----\nabc\n-----END-----');
    expect(p.entries.find((e) => e.key === 'PEM')).toMatchObject({ start: 1, end: 3 });
    expect(p.values.get('B')).toBe('2');
  });

  it('不合法的行带行号报出来；引号没闭合是致命错误', () => {
    const p = parseEnvText('GOOD=1\nnot a pair\n1BAD=2\nDASH-KEY=3\nX="tail" junk');
    expect(p.values.get('GOOD')).toBe('1');
    expect(p.errors.map((e) => e.line)).toEqual([2, 3, 4, 5]);
    expect(p.errors.some((e) => e.fatal)).toBe(false);

    const open = parseEnvText('A=1\nB="never closed\nC=3');
    expect(open.errors).toEqual([expect.objectContaining({ line: 2, fatal: true })]);
  });

  it('同名 key 取最后一次，并报出重复', () => {
    const p = parseEnvText('A=1\nB=2\nA=3');
    expect(p.values.get('A')).toBe('3');
    expect(p.duplicates).toEqual(['A']);
  });
});

describe('parseEnvInput：JSON 文件（同 wrangler secret bulk）', () => {
  it('扁平对象；数字 / 布尔转字符串', () => {
    const p = parseEnvInput('  {"A": "x\\ny", "PORT": 8080, "ON": true}');
    expect(p.errors).toEqual([]);
    expect(Object.fromEntries(p.values)).toEqual({ A: 'x\ny', PORT: '8080', ON: 'true' });
  });

  it('null、嵌套、非法 key、坏 JSON 都报错', () => {
    expect(parseEnvInput('{"A": null}').errors[0].message).toContain('null');
    expect(parseEnvInput('{"A": {"b": 1}}').errors[0].message).toContain('object');
    expect(parseEnvInput('{"1A": "x"}').errors[0].message).toContain('不合法');
    expect(parseEnvInput('{"A": ').errors[0].message).toContain('JSON');
  });
});

describe('formatShellLine：eval 进 POSIX shell 后值不变', () => {
  it.skipIf(process.platform === 'win32')('含引号、换行、$ 的值经 sh 往返一致', () => {
    const script = TRICKY.map((v, i) => formatShellLine(`K${i}`, v)).join('\n');
    const out = execFileSync('sh', ['-c', `${script}\nfor i in $(seq 0 ${TRICKY.length - 1}); do eval "printf '%s\\0' \\"\\$K$i\\""; done`]);
    expect(out.toString('utf8').split('\0').slice(0, -1)).toEqual(TRICKY);
  });
});
