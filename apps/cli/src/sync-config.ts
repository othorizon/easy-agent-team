import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * eat sync 的落点配置（决策 56）。
 *
 * 要解决的问题：更新提示里写的是裸 `eat sync`（update.ts），而裸 `eat sync` 此前恒等于
 * `--global`。于是用 `--dir` 装好的环境，一收到「团队 Skill 有变更」就会被同步到
 * `~/.agents/skills`，原落点从此不再更新——更糟的是 markSkillsSynced() 会把基线刷成最新，
 * 提示随之消失，整条链路静默且自我掩盖。
 *
 * 所以落点必须是「CLI 自己记得住」的东西：显式指定过一次就写进配置，之后裸 `eat sync` 落对。
 *
 * 配置查找顺序（决策 56 选乙）：项目配置 ./.eat/config.json > 用户配置 ~/.eat/config.json。
 * 项目级作用域天然是「跟着目录走」的，写进用户配置会让换个仓库裸跑 sync 也变成项目级，
 * 等于制造新的跑偏路径；给它一份项目内配置才是自洽的。
 */

export type SyncScope = 'global' | 'project' | 'dir';

const SCOPES: readonly SyncScope[] = ['global', 'project', 'dir'];

export interface SyncSettings {
  scope?: SyncScope;
  /** scope='dir' 时的落地目录。写入时一律存绝对路径——存相对路径换个 cwd 跑就落到别处 */
  dir?: string;
}

export interface EatConfig {
  /**
   * 记住的平台地址（决策 59）。放这里而不是凭证文件里：
   * 凭证会随 logout / 过期消失，地址不该跟着一起丢，否则裸跑 eat login 会回落到 localhost。
   */
  server?: string;
  sync?: SyncSettings;
}

export type ConfigLocation = 'project' | 'user';

export interface LoadedConfig {
  location: ConfigLocation;
  file: string;
  config: EatConfig;
}

export function userConfigFile(home: string = os.homedir()): string {
  return path.join(home, '.eat', 'config.json');
}

export function projectConfigFile(cwd: string = process.cwd()): string {
  return path.join(cwd, '.eat', 'config.json');
}

/** `<root>/.eat/config.json` → `<root>`：配置里的相对路径按它解析 */
function configBase(file: string): string {
  return path.dirname(path.dirname(file));
}

export function readConfigFile(file: string): EatConfig | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as EatConfig) : null;
  } catch {
    return null;
  }
}

export function writeConfigFile(file: string, config: EatConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function removeConfigFile(file: string): void {
  fs.rmSync(file, { force: true });
}

/**
 * 按优先级返回存在的配置文件。cwd 就是 home 时两者是同一个文件，只算一次
 * （否则同一份配置会以「项目配置」的名义出现在输出里，误导人以为项目里另有一份）。
 */
export function loadConfigs(cwd: string = process.cwd(), home: string = os.homedir()): LoadedConfig[] {
  const projectFile = projectConfigFile(cwd);
  const userFile = userConfigFile(home);
  const out: LoadedConfig[] = [];
  if (path.resolve(projectFile) !== path.resolve(userFile)) {
    const config = readConfigFile(projectFile);
    if (config) out.push({ location: 'project', file: projectFile, config });
  }
  const userConfig = readConfigFile(userFile);
  if (userConfig) out.push({ location: 'user', file: userFile, config: userConfig });
  return out;
}

export interface SyncOpts {
  dir?: string;
  force?: boolean;
  global?: boolean;
  project?: boolean;
  dryRun?: boolean;
  /** commander 的 --no-save：默认 true，显式 --no-save 时为 false */
  save?: boolean;
  /** 确认本次落点与上次不同 */
  yes?: boolean;
}

export type SyncSourceKind = 'flag' | 'env' | 'project-config' | 'user-config' | 'default';

export interface SyncSource {
  kind: SyncSourceKind;
  /** 来源是配置文件时的路径 */
  file?: string;
  /** 给人看的一句话来源说明 */
  label: string;
}

export interface SyncResolution {
  scope: SyncScope;
  target: string;
  /** null = 自定义目录模式，不建 .claude 链接 */
  linkRoot: string | null;
  relativeLinks: boolean;
  source: SyncSource;
}

export interface ResolveContext {
  configs?: LoadedConfig[];
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function parseScope(raw: string, origin: string): SyncScope {
  const scope = raw.trim() as SyncScope;
  if (!SCOPES.includes(scope)) {
    throw new Error(`${origin} 的值 "${raw}" 无效，只能是 ${SCOPES.join(' / ')}`);
  }
  return scope;
}

function buildRoots(
  scope: SyncScope,
  dir: string | undefined,
  cwd: string,
  home: string,
  source: SyncSource,
): SyncResolution {
  if (scope === 'dir') {
    if (!dir) throw new Error(`${source.label} 指定了 dir 作用域却没有给出目录`);
    return { scope, target: dir, linkRoot: null, relativeLinks: false, source };
  }
  const root = scope === 'project' ? cwd : home;
  return {
    scope,
    target: path.join(root, '.agents', 'skills'),
    linkRoot: path.join(root, '.claude', 'skills'),
    relativeLinks: scope === 'project',
    source,
  };
}

/**
 * 落点解析：命令行 > 环境变量 > 项目配置 > 用户配置 > 内置默认（与 resolveServerUrl 的惯例一致）。
 *
 * 作用域是**整体覆盖**而不是按字段合并：命令行给了 --project，配置里的 scope 与 dir 一并让位。
 * 按字段合并会让配置里的 dir 和命令行的 project 撞上「三者互斥」那条校验，报一个用户没法理解的错。
 */
export function resolveSyncRoots(
  opts: SyncOpts,
  cwd: string = process.cwd(),
  ctx: ResolveContext = {},
): SyncResolution {
  const home = ctx.home ?? os.homedir();
  const env = ctx.env ?? process.env;

  const picked = [
    opts.global ? '--global' : null,
    opts.project ? '--project' : null,
    opts.dir !== undefined ? '--dir' : null,
  ].filter((f): f is string => f !== null);
  if (picked.length > 1) {
    throw new Error(`${picked.join(' 与 ')} 不能同时使用，请只指定一种安装范围`);
  }
  if (picked.length === 1) {
    const source: SyncSource = { kind: 'flag', label: `命令行参数 ${picked[0]}` };
    const scope: SyncScope = opts.dir !== undefined ? 'dir' : opts.project ? 'project' : 'global';
    return buildRoots(scope, opts.dir === undefined ? undefined : path.resolve(cwd, opts.dir), cwd, home, source);
  }

  const envScope = env.EAT_SYNC_SCOPE?.trim();
  const envDir = env.EAT_SYNC_DIR?.trim();
  if (envScope || envDir) {
    const scope = envScope ? parseScope(envScope, '环境变量 EAT_SYNC_SCOPE') : 'dir';
    const source: SyncSource = {
      kind: 'env',
      label: `环境变量 ${envScope && !envDir ? 'EAT_SYNC_SCOPE' : envScope ? 'EAT_SYNC_SCOPE + EAT_SYNC_DIR' : 'EAT_SYNC_DIR'}`,
    };
    if (scope === 'dir' && !envDir) {
      throw new Error('环境变量 EAT_SYNC_SCOPE=dir 需要同时设置 EAT_SYNC_DIR');
    }
    return buildRoots(scope, envDir ? path.resolve(cwd, envDir) : undefined, cwd, home, source);
  }

  const configs = ctx.configs ?? loadConfigs(cwd, home);
  for (const loaded of configs) {
    const raw = loaded.config.sync?.scope;
    if (!raw) continue;
    const scope = parseScope(String(raw), `配置文件 ${loaded.file} 的 sync.scope`);
    const source: SyncSource = {
      kind: loaded.location === 'project' ? 'project-config' : 'user-config',
      file: loaded.file,
      label: `${loaded.location === 'project' ? '项目配置' : '用户配置'} ${loaded.file}`,
    };
    const dir = loaded.config.sync?.dir;
    if (scope === 'dir' && !dir) {
      throw new Error(`${source.label} 里 sync.scope=dir 却没有 sync.dir，请执行 eat config set sync.dir <目录> 修正`);
    }
    // 手改过的相对路径按配置文件所在的根目录解析（eat config set 写入的一律是绝对路径）
    return buildRoots(scope, dir ? path.resolve(configBase(loaded.file), dir) : undefined, cwd, home, source);
  }

  return buildRoots('global', undefined, cwd, home, { kind: 'default', label: '内置默认' });
}

export interface PersistResult {
  file: string;
  location: ConfigLocation;
}

/**
 * 把这次显式选择的落点记下来，让之后的裸 `eat sync` 落对——这是决策 56 的核心。
 *
 * 只给一条 `eat config set` 让人手动敲是不够的：安装往往由 AI 代跑，它装完就走，
 * 没人会补那一条，坑原样留着。
 *
 * project 作用域写进**项目内**配置：它按 cwd 解析，写进用户配置会让换个仓库裸跑 sync
 * 也变成项目级。global / dir 与目录无关，写用户配置。
 */
export function persistSyncChoice(
  scope: SyncScope,
  dir: string | undefined,
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): PersistResult {
  const location: ConfigLocation = scope === 'project' ? 'project' : 'user';
  const file = location === 'project' ? projectConfigFile(cwd) : userConfigFile(home);
  const config = readConfigFile(file) ?? {};
  // scope 不是 dir 时必须丢掉 dir，否则以后切回 dir 会悄悄复活一个早就不对的旧目录
  config.sync = scope === 'dir' ? { scope, dir } : { scope };
  writeConfigFile(file, config);
  return { file, location };
}
