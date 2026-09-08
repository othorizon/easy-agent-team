/**
 * SKILL.md frontmatter 解析（YAML 子集，不引入 YAML 依赖）
 *
 * Agent Skill 的 SKILL.md 以 `---` 包裹的 YAML frontmatter 开头，name / description 是标准字段。
 * description 的写法远不止「一行 key: value」：社区与官方 skill 里大量使用块标量
 * （`description: >-` 折叠、`|` 保留换行）与引号包裹的跨行字符串，早期那版一行一匹配的正则
 * 只能取到 `>-` 这个指示符本身，推上平台的描述就成了 `>-`。这里覆盖实际会遇到的写法：
 *
 * - 纯标量 `key: value`，含缩进续行（YAML 把换行折叠成空格）
 * - 引号标量 `'...'`（`''` 转义）与 `"..."`（反斜杠转义），均可跨行
 * - 块标量 `>` / `|`，带 `-`/`+` 截断指示与可选缩进数字（`>-`、`|2+` 等）
 * - CRLF 换行、BOM、`#` 整行注释、`...` 结束分隔符
 *
 * 有意不做的两件事：不解析嵌套结构（map / 序列的值会被跳过，frontmatter 里的 name/description
 * 用不上），不剥离行内 `#` 注释（描述里出现 `#` 比写注释常见得多，宁可原样保留）。
 */

export interface ParsedFrontmatter {
  /** 是否存在 frontmatter 块 */
  present: boolean;
  /** 顶层标量键值（结构化的值会被跳过）；按 YAML 语义还原，未做 trim */
  fields: Record<string, string>;
  /** frontmatter 之后的正文（换行统一为 \n；无 frontmatter 时为原文） */
  body: string;
}

/** 顶层键：必须顶格（缩进行属于上一个值或嵌套结构） */
const TOP_LEVEL_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?[ \t]*$/;
/** 块标量头：`>`、`|` 加可选的截断指示与缩进数字，两种顺序都认（`>-2` / `>2-`） */
const BLOCK_HEADER = /^([|>])([+-]?)(\d*)([+-]?)[ \t]*$/;
/** 嵌套结构的起始行：`- item` 或 `key: ...` */
const NESTED_START = /^[ \t]*(?:-(?:[ \t]|$)|[A-Za-z0-9_][A-Za-z0-9_.-]*[ \t]*:(?:[ \t]|$))/;
/** 旧版 CLI（≤0.5.5）把块标量指示符本身当值推上来的形态：`>`、`>-`、`|2+` 等 */
const BLOCK_INDICATOR_ONLY = /^[|>][+-]?\d*[+-]?$/;

function splitLines(content: string): string[] {
  return content
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length;
}

/**
 * YAML 折叠：行间单个换行折成空格，空行折成换行，
 * 比块缩进更深的行（more-indented）保留自己的换行。
 */
function foldRows(rows: string[]): string {
  let out = '';
  let started = false;
  let breaks = 0;
  let prevMore = false;
  for (const row of rows) {
    if (row === '') {
      breaks++;
      continue;
    }
    const more = /^[ \t]/.test(row);
    if (!started) {
      out = row;
      started = true;
    } else {
      out += breaks > 0 ? '\n'.repeat(breaks) : more || prevMore ? '\n' : ' ';
      out += row;
    }
    breaks = 0;
    prevMore = more;
  }
  return out;
}

function readBlockScalar(
  style: '|' | '>',
  chomp: string,
  explicitIndent: number,
  lines: string[],
  start: number,
): { value: string; next: number } {
  const rows: string[] = [];
  let indent = explicitIndent;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      rows.push('');
      continue;
    }
    const ind = indentOf(line);
    if (indent === 0) {
      if (ind === 0) break; // 块内容必须比键更深，顶格即块结束
      indent = ind;
    }
    if (ind < indent) break;
    rows.push(line.slice(indent));
  }
  // 结尾空行交给截断指示决定留几个换行
  let trailing = 0;
  while (rows.length > 0 && rows[rows.length - 1] === '') {
    rows.pop();
    trailing++;
  }
  const hasContent = rows.length > 0;
  const body = style === '|' ? rows.join('\n') : foldRows(rows);
  let value: string;
  if (chomp === '-') value = body;
  else if (chomp === '+') value = body + '\n'.repeat(hasContent ? trailing + 1 : trailing);
  else value = hasContent ? body + '\n' : '';
  return { value, next: i };
}

/** 找到闭合引号的位置（-1 表示本行内没有）；单引号 `''`、双引号 `\"` 都算转义 */
function findClosingQuote(text: string, quote: '"' | "'"): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== quote) continue;
    if (quote === "'") {
      if (text[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, esc: string) => {
    if (esc[0] === 'u' || esc[0] === 'x') return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'e':
        return '\u001b';
      case '0':
        return '\0';
      default:
        return esc; // \" \\ \/ 等原样取字符
    }
  });
}

function readQuoted(
  quote: '"' | "'",
  first: string,
  lines: string[],
  start: number,
): { value: string; next: number } {
  const rows: string[] = [];
  let i = start;
  let text = first.slice(1);
  for (;;) {
    const close = findClosingQuote(text, quote);
    if (close >= 0) {
      rows.push(text.slice(0, close));
      break;
    }
    rows.push(text);
    i++;
    if (i >= lines.length) break; // 引号未闭合：宽容地收到文件末尾
    text = lines[i].trim();
  }
  const raw = foldRows(rows);
  return { value: quote === "'" ? raw.replace(/''/g, "'") : unescapeDoubleQuoted(raw), next: i + 1 };
}

function readPlain(first: string, lines: string[], start: number): { value: string; next: number } {
  const rows = [first.trim()];
  let i = start;
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      // 空行后若还有缩进行，整段仍是同一个标量（空行折成换行）
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length || indentOf(lines[j]) === 0) break;
      for (; i < j; i++) rows.push('');
      continue;
    }
    if (indentOf(lines[i]) === 0) break;
    rows.push(lines[i].trim());
    i++;
  }
  return { value: foldRows(rows), next: i };
}

/** 跳过一个缩进块（嵌套 map / 序列的值），返回块结束后的行号 */
function skipIndentedBlock(lines: string[], start: number): number {
  let i = start;
  while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) > 0)) i++;
  return i;
}

function parseFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || /^[ \t]*#/.test(line)) {
      i++;
      continue;
    }
    const m = TOP_LEVEL_KEY.exec(line);
    if (!m) {
      i++; // 无法识别的行（缩进残留等）直接跳过
      continue;
    }
    const key = m[1];
    const rest = (m[2] ?? '').trim();
    const block = BLOCK_HEADER.exec(rest);
    if (block) {
      const [, style, chompA, digits, chompB] = block;
      const r = readBlockScalar(style as '|' | '>', chompA || chompB, digits ? Number(digits) : 0, lines, i + 1);
      fields[key] = r.value;
      i = r.next;
    } else if (rest.startsWith('"') || rest.startsWith("'")) {
      const r = readQuoted(rest[0] as '"' | "'", rest, lines, i);
      fields[key] = r.value;
      i = r.next;
    } else if (rest !== '') {
      const r = readPlain(rest, lines, i + 1);
      fields[key] = r.value;
      i = r.next;
    } else {
      // 值为空：可能是空值、嵌套结构，也可能是下一行才开始的多行纯标量
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length || indentOf(lines[j]) === 0) {
        fields[key] = '';
        i += 1;
      } else if (NESTED_START.test(lines[j])) {
        i = skipIndentedBlock(lines, i + 1); // 结构化的值不解析
      } else {
        const r = readPlain(lines[j].trim(), lines, j + 1);
        fields[key] = r.value;
        i = r.next;
      }
    }
  }
  return fields;
}

/** 解析 SKILL.md 开头的 YAML frontmatter；没有 frontmatter 时 present=false */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = splitLines(content);
  let start = 0;
  while (start < lines.length && isBlank(lines[start])) start++;
  if (lines[start]?.trim() !== '---') return { present: false, fields: {}, body: content };
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) return { present: false, fields: {}, body: content }; // 没有结束分隔符：整篇算正文
  return {
    present: true,
    fields: parseFields(lines.slice(start + 1, end)),
    body: lines.slice(end + 1).join('\n'),
  };
}

/** 取 SKILL.md frontmatter 里的 name / description（空值视作未填） */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const { fields } = parseFrontmatter(content);
  const out: { name?: string; description?: string } = {};
  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (name) out.name = name;
  if (description) out.description = description;
  return out;
}

/**
 * 值是否只是个块标量指示符（`>-`、`|` 等）。
 * 旧版 CLI 解析不了块标量，会把指示符本身当描述推上来，服务端据此回退到正文里的 frontmatter。
 */
export function isBlockScalarIndicator(value: string): boolean {
  return BLOCK_INDICATOR_ONLY.test(value.trim());
}

/** 把字符串写成安全的 YAML 单行标量（生成 frontmatter 用），必要时加双引号转义 */
export function toYamlScalar(value: string): string {
  if (value === '') return "''";
  const needsQuote =
    value !== value.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /[\r\n\t]/.test(value) ||
    /:(?:\s|$)/.test(value) ||
    /\s#/.test(value);
  if (!needsQuote) return value;
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;
}
