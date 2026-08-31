/**
 * CLI 版本与更新检测契约（决策 26）。
 *
 * CLI_VERSION 是 CLI 版本的唯一事实源：apps/cli/package.json 由 CLI 单测断言与此一致，
 * 服务端也从这里取「平台当前分发的 CLI 版本」——避免版本号散落在四处各写一遍。
 *
 * 更新检测走响应头搭车（决策 26）：CLI 的联网命令本就要请求平台，服务端在响应里
 * 顺带回传当前 CLI 版本与该用户的 Skill 集合指纹，不额外发探测请求、不需要检查节流。
 */
export const CLI_VERSION = '0.2.0';

/** CLI 在请求里自报身份，服务端据此决定是否附带更新头（控制台请求不必付这份开销） */
export const CLIENT_HEADER = 'x-eat-client';
/** 平台当前分发的 CLI 版本 */
export const CLI_VERSION_HEADER = 'x-eat-cli-version';
/** 该用户当前应有的整套 Skill 的指纹 */
export const SKILL_VERSION_HEADER = 'x-eat-skill-version';

export interface SkillBundleItem {
  slug: string;
  version: number;
}

/**
 * 用户当前应有的整套 Skill 的指纹：sorted(slug@version) 的 FNV-1a 64 位哈希。
 *
 * 平台没有全局的 Skill 版本号——每个 Skill 各自递增 currentVersion，而每个用户该同步哪些
 * 又不同（订阅 + 角色模板 − 排除项 + 内置指南）。对整个集合取指纹才能同时覆盖三类变化：
 * 已有 Skill 出新版本、订阅/模板新增、退订或删除。单看「最大版本号」或「数量」都会漏。
 *
 * 只做等值判定（本地是否落后），不可比较大小，也不是安全边界，因此用纯 JS 哈希而非
 * node:crypto —— packages/shared 同时被浏览器端的控制台引用，不能引入 Node 内置模块。
 * 极小概率的碰撞只会漏掉一次提示，且下一次变更即自愈。
 */
export function skillBundleVersion(items: SkillBundleItem[]): string {
  const payload = items
    .map((i) => `${i.slug}@${i.version}`)
    .sort()
    .join('\n');
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash ^ BigInt(payload.charCodeAt(i))) * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 语义版本比较：remote 是否比 local 新。
 * 解析失败一律返回 false——宁可漏提示，也不能对着看不懂的版本号反复提示。
 */
export function isNewerVersion(remote: string, local: string): boolean {
  const parse = (v: string): number[] | null => {
    const base = v.trim().replace(/^v/, '').split('-')[0];
    const parts = base.split('.');
    if (parts.length === 0 || parts.length > 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    if (nums.some((n) => Number.isNaN(n))) return null;
    while (nums.length < 3) nums.push(0);
    return nums;
  };
  const r = parse(remote);
  const l = parse(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] !== l[i]) return r[i] > l[i];
  }
  return false;
}
