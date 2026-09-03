/**
 * dotenv 文本的最小解析与差异比较（决策 31：应用 env 的推送/拉取）。
 *
 * Dokploy 把应用的运行时 env 与构建时 buildArgs 都存成 dotenv 风格的多行文本，平台侧不改它的格式，
 * 只在推送前后做 key 级比较，让 CLI / 控制台能报出「新增 / 删除 / 修改了哪些 key」而不打印值。
 *
 * 解析规则刻意保守：`KEY=value` 一行一条，支持 `export KEY=`、`#` 注释行、单/双引号包裹；
 * 不做变量展开、不处理多行值——这些 Dokploy 侧也不支持，解析得更「聪明」只会让比较结果与实际不符。
 * 同时被浏览器端引用，不能用 Node 内置模块。
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else {
      // 未加引号的值：行尾 `# 注释` 去掉
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out.set(m[1], value);
  }
  return out;
}

export interface DotenvDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

/** 比较两份 dotenv 文本，只回 key 级结论，不带值 */
export function diffDotenv(before: string, after: string): DotenvDiff {
  const a = parseDotenv(before);
  const b = parseDotenv(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k);
    else if (a.get(k) !== v) changed.push(k);
    else unchanged++;
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged };
}
