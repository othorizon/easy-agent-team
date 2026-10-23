/**
 * dotenv 文本的严格解析与输出格式（`eat env push` / `pull --merge` / `pull --format` / `run`）。
 *
 * shared 里的 `parseDotenv` 是给应用 env 做 key 级比较用的，刻意保守：不反转义、不认多行值。
 * 推送到平台不能这么宽松——`eat env pull` 对复杂值输出的是 JSON 风格的双引号转义，
 * 不还原的话含换行或引号的值 pull 下来再 push 回去就被改坏了。所以这里另写一份：
 * 双引号按 JSON 转义还原（与 docker compose 一致），单引号 / 反引号原样，三种引号都可跨行；
 * 不合法的行报行号，由调用方决定整批拒绝（push）还是原样保留（merge）。
 */

/** 变量名：与平台的 variableKeySchema 一致 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvEntry {
  key: string;
  value: string;
  /** 赋值在文本里占的行（0 起，含首尾），多行值跨多行 */
  start: number;
  end: number;
  /** 原文写了 `export ` 前缀——合并时改值要保留 */
  exported: boolean;
}

export interface EnvParseError {
  /** 1 起的行号，给人看 */
  line: number;
  message: string;
  /** 引号没闭合：之后的内容都无法可靠解析，合并时必须中止 */
  fatal?: boolean;
}

export interface ParsedEnv {
  entries: EnvEntry[];
  /** 同名 key 取最后一次（dotenv 的语义） */
  values: Map<string, string>;
  errors: EnvParseError[];
  /** 出现多次的 key，提醒用 */
  duplicates: string[];
}

const JSON_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/** 双引号内的转义：按 JSON 规则还原；不认识的转义（如正则里的 `\d`）原样保留 */
function unescapeDouble(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (all, esc: string) => {
    if (esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return JSON_ESCAPES[esc] ?? all;
  });
}

/** 从 text[from] 起找收尾引号；双引号跳过反斜杠转义。找不到回 -1 */
function findClosingQuote(text: string, from: number, quote: string): number {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

export function parseEnvText(input: string): ParsedEnv {
  const lines = input.replace(/^﻿/, '').split(/\r?\n/);
  const entries: EnvEntry[] = [];
  const errors: EnvParseError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = /^(export\s+)?([^=\s]+)\s*=(.*)$/.exec(trimmed);
    if (!m) {
      errors.push({ line: i + 1, message: '不是 KEY=VALUE 格式' });
      continue;
    }
    const [, exportPrefix, key] = m;
    const rest = m[3].trimStart();
    const start = i;
    let value: string;
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // 引号值可以跨行：把后续行接上来，直到找到收尾引号
      let text = rest;
      let close = findClosingQuote(text, 1, quote);
      while (close < 0 && i + 1 < lines.length) {
        i++;
        text += `\n${lines[i]}`;
        close = findClosingQuote(text, 1, quote);
      }
      if (close < 0) {
        errors.push({ line: start + 1, message: `${quote} 引号没有闭合`, fatal: true });
        break;
      }
      const tail = text.slice(close + 1).trim();
      if (tail !== '' && !tail.startsWith('#')) {
        errors.push({ line: i + 1, message: '收尾引号后面还有多余内容' });
        continue;
      }
      const inner = text.slice(1, close);
      value = quote === '"' ? unescapeDouble(inner) : inner;
    } else {
      // 不加引号：` #` 起算行尾注释（`KEY= # 注释` 的值是空串，所以在 trimStart 之前的原文上找）
      const raw = m[3];
      const hash = raw.search(/\s#/);
      value = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    }
    if (!KEY_RE.test(key)) {
      errors.push({ line: start + 1, message: `Key「${key}」不合法：仅允许字母、数字、下划线，且不能以数字开头` });
      continue;
    }
    entries.push({ key, value, start, end: i, exported: !!exportPrefix });
  }

  const values = new Map<string, string>();
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.key)) duplicates.add(e.key);
    seen.add(e.key);
    values.set(e.key, e.value);
  }
  return { entries, values, errors, duplicates: [...duplicates].sort() };
}

/**
 * JSON 形式的变量文件（同 wrangler secret bulk）：扁平对象，值为字符串（数字 / 布尔转成字符串）。
 * 不支持 wrangler 的「写 null 表示删除」——删除用 eat env unset 或 push --prune，一个意图一条路。
 */
export function parseEnvJson(input: string): ParsedEnv {
  let obj: unknown;
  try {
    obj = JSON.parse(input.replace(/^﻿/, ''));
  } catch (e) {
    return { entries: [], values: new Map(), errors: [{ line: 1, message: `JSON 解析失败：${(e as Error).message}` }], duplicates: [] };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { entries: [], values: new Map(), errors: [{ line: 1, message: 'JSON 必须是 {"KEY": "value"} 形式的对象' }], duplicates: [] };
  }
  const values = new Map<string, string>();
  const errors: EnvParseError[] = [];
  for (const [key, v] of Object.entries(obj)) {
    if (!KEY_RE.test(key)) errors.push({ line: 1, message: `Key「${key}」不合法：仅允许字母、数字、下划线，且不能以数字开头` });
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values.set(key, String(v));
    else errors.push({ line: 1, message: `${key} 的值必须是字符串（收到 ${v === null ? 'null' : typeof v}）` });
  }
  return { entries: [], values, errors, duplicates: [] };
}

/** 按内容判断格式：去掉空白后以 `{` 开头的是 JSON（合法的 dotenv 不会这样开头），其余按 dotenv */
export function parseEnvInput(input: string): ParsedEnv {
  return input.replace(/^﻿/, '').trimStart().startsWith('{') ? parseEnvJson(input) : parseEnvText(input);
}

/**
 * dotenv 里的值怎么写：简单值裸写；单行且不含单引号的用单引号（各家解析器都按字面量处理，
 * 也不会被 docker compose 当成 `$变量` 展开）；其余（多行、含单引号）用 JSON 风格的双引号转义。
 */
export function formatDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_@:./-]*$/.test(value)) return value;
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
}

export function formatDotenvLine(key: string, value: string): string {
  return `${key}=${formatDotenvValue(value)}`;
}

/** POSIX shell 的单引号转义：`'` 写成 `'\''`；单引号内换行原样有效 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `eval "$(eat env pull <env> --print --format shell)"` 用的一行 */
export function formatShellLine(key: string, value: string): string {
  return `export ${key}=${shellQuote(value)}`;
}
