import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLI_VERSION, CLI_VERSION_HEADER, isNewerVersion, SKILL_VERSION_HEADER, skillBundleVersion } from '@eat/shared';

/**
 * CLI / Skill 更新提示（决策 26）。
 *
 * 检测不额外发请求：服务端把「平台分发的 CLI 版本」和「该用户的 Skill 集合指纹」搭在
 * 每个 CLI 请求的响应头上（见 client.ts），这里只负责落盘、比对与提示。
 *
 * 面向 Agent 的三条约束（与面向人的 update-notifier 不同）：
 *   1. 提示只走 stderr，stdout 永远保持干净可解析——Agent 常把 stdout 当结构化输出解析；
 *      也因此不做 TTY 判断：Agent 调用时本就不是 TTY，按 TTY 静默等于对目标用户永不提示。
 *   2. 按版本去重：一个任务里可能连跑十几条 eat 命令，同一个目标版本只提示一次，
 *      避免持续污染 Agent 上下文、也避免它反复纠结要不要中断手上的活去更新。
 *   3. 只提示不自动更新，且任何环节失败都静默——绝不改变命令的输出与退出码。
 */

const STATE_FILE = path.join(os.homedir(), '.eat', 'state.json');
/** eat sync 的默认落地目录，用于「装过但没有基线」时反推指纹 */
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills');

export interface UpdateState {
  /** 状态归属的平台地址：换平台时整体重置，避免两套版本号来回打架 */
  serverUrl?: string;
  /** 服务端回传：平台当前分发的 CLI 版本 */
  latestCliVersion?: string;
  /** 服务端回传：该用户当前应有的 Skill 集合指纹 */
  serverSkillVersion?: string;
  /** 本地上次 eat sync 实际落地的指纹 */
  syncedSkillVersion?: string;
  /** 已经就该版本 / 该指纹提示过，不再重复 */
  notifiedCliVersion?: string;
  notifiedSkillVersion?: string;
}

export function loadState(): UpdateState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as UpdateState) : {};
  } catch {
    return {};
  }
}

function saveState(state: UpdateState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // 状态盘不可写不该影响任何命令
  }
}

/** EAT_NO_UPDATE_NOTIFIER 优先，同时兼容 update-notifier 生态的 NO_UPDATE_NOTIFIER 惯例 */
export function notifierDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.EAT_NO_UPDATE_NOTIFIER ?? env.NO_UPDATE_NOTIFIER;
  return flag !== undefined && flag !== '' && flag !== '0' && flag !== 'false';
}

/**
 * 纯函数：把响应头合进状态，返回需要落盘的新状态；无变化返回 null。
 * 必须返回新对象——就地改 state 会让「有变化才落盘」的比较恒为假，等于状态永远停在第一次。
 */
export function mergeServerVersions(
  state: UpdateState,
  serverUrl: string,
  cli: string | null,
  skill: string | null,
): UpdateState | null {
  if (!cli && !skill) return null;
  // 换了平台：旧平台的版本号与指纹一律作废
  const next: UpdateState = state.serverUrl === serverUrl ? { ...state } : { serverUrl };
  next.serverUrl = serverUrl;
  if (cli) next.latestCliVersion = cli;
  if (skill) next.serverSkillVersion = skill;
  const changed =
    next.serverUrl !== state.serverUrl ||
    next.latestCliVersion !== state.latestCliVersion ||
    next.serverSkillVersion !== state.serverSkillVersion;
  return changed ? next : null;
}

/** 记录服务端回传的版本头。仅在值有变化时落盘，避免每个请求都写一次文件 */
export function recordServerVersions(serverUrl: string, headers: Headers): void {
  if (notifierDisabled()) return;
  try {
    const next = mergeServerVersions(
      loadState(),
      serverUrl,
      headers.get(CLI_VERSION_HEADER),
      headers.get(SKILL_VERSION_HEADER),
    );
    if (next) saveState(next);
  } catch {
    // 同上：更新检测不能影响业务命令
  }
}

/** eat sync 成功后调用：把服务端最新指纹记为本地基线 */
export function markSkillsSynced(): void {
  try {
    const state = loadState();
    if (!state.serverSkillVersion) return;
    state.syncedSkillVersion = state.serverSkillVersion;
    state.notifiedSkillVersion = undefined;
    saveState(state);
  } catch {
    // ignore
  }
}

/** eat self-update 成功后调用：抑制「刚更新完又提示更新」 */
export function markCliUpdated(version: string): void {
  try {
    const state = loadState();
    state.latestCliVersion = version;
    state.notifiedCliVersion = version;
    saveState(state);
  } catch {
    // ignore
  }
}

/**
 * 「装过 Skill 但状态里没有基线」时的兜底：从 ~/.agents/skills 的 .eat-meta.json 反推指纹。
 * 覆盖本功能上线前就装好的老客户端——否则它们要先跑一次 eat sync 才可能收到 Skill 更新提示。
 * 只看默认的全局目录；--project 落地的用户跑一次 sync 后走基线，不再依赖这里。
 */
export function localSkillVersion(dir: string = GLOBAL_SKILLS_DIR): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // 目录不存在 = 从没同步过（新装、或只登录没 sync），这正是最该提示 eat sync 的人；
    // 其余错误（权限等）说明本地状态无从判断，宁可漏提示也不误报。
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? skillBundleVersion([]) : null;
  }
  try {
    const items: Array<{ slug: string; version: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, entry.name, '.eat-meta.json'), 'utf8')) as {
          slug?: string;
          version?: number;
          managed?: boolean;
        };
        if (meta.managed && typeof meta.slug === 'string' && typeof meta.version === 'number') {
          items.push({ slug: meta.slug, version: meta.version });
        }
      } catch {
        continue;
      }
    }
    return skillBundleVersion(items);
  } catch {
    return null;
  }
}

export interface UpdateNotice {
  lines: string[];
  /** 本次提示覆盖的版本 / 指纹，供调用方写入去重标记 */
  cliVersion?: string;
  skillVersion?: string;
}

/**
 * 纯函数：根据状态算出该不该提示、提示什么。
 * localSkills 传 null 表示无法确定本地 Skill 状态（此时不提示 Skill 更新，宁可漏也不误报）。
 */
export function buildUpdateNotice(
  state: UpdateState,
  localCliVersion: string,
  localSkills: string | null,
): UpdateNotice | null {
  const items: string[] = [];
  const notice: UpdateNotice = { lines: [] };

  const latest = state.latestCliVersion;
  if (latest && isNewerVersion(latest, localCliVersion) && state.notifiedCliVersion !== latest) {
    items.push(`CLI ${localCliVersion} → ${latest} —— 更新: eat self-update`);
    notice.cliVersion = latest;
  }

  const server = state.serverSkillVersion;
  const local = state.syncedSkillVersion ?? localSkills;
  if (server && local !== null && local !== undefined && server !== local && state.notifiedSkillVersion !== server) {
    items.push('团队 Skill 有变更 —— 更新: eat sync');
    notice.skillVersion = server;
  }

  if (items.length === 0) return null;
  notice.lines = [
    '[eat] 有可用更新（不影响本次命令结果，可稍后处理）：',
    ...items.map((i) => `      ${i}`),
    '      不再提示: 设置环境变量 EAT_NO_UPDATE_NOTIFIER=1',
  ];
  return notice;
}

let flushed = false;

/**
 * 命令收尾时输出提示（由 index.ts 挂在 process exit 上，覆盖正常结束与 process.exit 两条路径）。
 * 必须全同步：exit 回调里跑不了异步。
 */
export function flushUpdateNotice(): void {
  if (flushed || notifierDisabled()) return;
  flushed = true;
  try {
    const state = loadState();
    const notice = buildUpdateNotice(state, CLI_VERSION, state.syncedSkillVersion ? null : localSkillVersion());
    if (!notice) return;
    console.error(notice.lines.join('\n'));
    if (notice.cliVersion) state.notifiedCliVersion = notice.cliVersion;
    if (notice.skillVersion) state.notifiedSkillVersion = notice.skillVersion;
    saveState(state);
  } catch {
    // ignore
  }
}

/**
 * MCP 场景的提示（决策 26）：stdio server 的 stderr 通常只进客户端日志，Agent 看不见，
 * 所以改成挂在工具返回内容里。同样按版本去重，一个 server 生命周期内也只附一次。
 */
export function takeUpdateNoticeForMcp(): string | null {
  if (flushed || notifierDisabled()) return null;
  try {
    const state = loadState();
    const notice = buildUpdateNotice(state, CLI_VERSION, state.syncedSkillVersion ? null : localSkillVersion());
    if (!notice) return null;
    flushed = true;
    if (notice.cliVersion) state.notifiedCliVersion = notice.cliVersion;
    if (notice.skillVersion) state.notifiedSkillVersion = notice.skillVersion;
    saveState(state);
    return notice.lines.join('\n');
  } catch {
    return null;
  }
}

/** 单测用：重置一次性输出的闸门 */
export function resetNoticeGate(): void {
  flushed = false;
}
