import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_BUILD_TYPE_LABEL, APP_ENV_TARGET_LABEL, CLI_VERSION, LOG_TAIL_DEFAULT, appBuildTypeSchema } from '@eat/shared';
import type {
  AppBuildType,
  AppEnv,
  AppEnvChange,
  AppEnvTarget,
  AppInfo,
  BuildLogsResult,
  CreateAppRequest,
  DeploymentInfo,
  PrecheckReport,
  RunLogsResult,
  SecretFingerprint,
  UpdateAppRequest,
} from '@eat/shared';
import { Api } from '../client.js';
import { scanWorkspace } from '../scan.js';

/** 部署记录状态（决策 30：queued/archived 是平台补的，其余直接是 Dokploy 构建记录的取值） */
const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '构建中',
  done: '成功',
  error: '失败',
  cancelled: '已取消',
  archived: '已归档',
};
/** 已经跑完、再查也不会变的状态 */
const SETTLED = new Set(['done', 'error', 'cancelled']);
/** Dokploy 构建记录自己的状态取值（build-logs 用） */
const BUILD_LABEL: Record<string, string> = { running: '构建中', done: '成功', error: '失败', cancelled: '已取消' };
const when = (iso: string): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveApp(api: Api, slug?: string): Promise<AppInfo> {
  const rows = await api.request<AppInfo[]>('GET', '/api/apps');
  if (slug) {
    const a = rows.find((x) => x.slug === slug);
    if (!a) throw new Error(`应用 ${slug} 不存在（eat app list 查看）`);
    return a;
  }
  const mine = rows.filter((a) => a.isMember);
  if (mine.length === 1) return mine[0];
  throw new Error(
    mine.length === 0
      ? '你不是任何应用的成员：eat app create 创建一个，或找应用 Owner 把你加入'
      : `请指定应用: eat deploy <slug>，候选: ${mine.map((a) => a.slug).join(', ')}`,
  );
}

/** 本地前置检查：密钥扫描（强制）+ 可选预跑命令 */
async function runPrecheck(api: Api, dir: string, checkCmd?: string): Promise<PrecheckReport> {
  console.log(`前置检查: 扫描 ${dir} ...`);
  const fingerprints = await api.request<SecretFingerprint[]>('GET', '/api/secret-fingerprints');
  const { scannedFiles, findings } = scanWorkspace(dir, fingerprints);
  console.log(`  已扫描 ${scannedFiles} 个文件，${findings.length} 个问题`);
  if (scannedFiles === 0) {
    console.warn('  ⚠ 没扫到任何文件，确认目录指向应用代码（部署时用 --dir 指定），否则密钥检查等于没做');
  }
  for (const f of findings) {
    console.error(`  ✗ [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.note}`);
  }

  let localCheck: PrecheckReport['localCheck'];
  if (checkCmd && findings.length === 0) {
    console.log(`本地预跑: ${checkCmd}`);
    const res = spawnSync(checkCmd, { shell: true, cwd: dir, stdio: 'inherit' });
    localCheck = { command: checkCmd, passed: res.status === 0 };
    if (res.status !== 0) console.error(`  ✗ 预跑命令退出码 ${res.status}`);
  }

  return {
    passed: findings.length === 0 && (localCheck?.passed ?? true),
    scannedFiles,
    findings,
    localCheck,
    cliVersion: CLI_VERSION,
    ranAt: new Date().toISOString(),
  };
}

export async function deployRun(slug: string | undefined, opts: { dir?: string; check?: string }): Promise<void> {
  const api = Api.fromSaved();
  const app = await resolveApp(api, slug);
  if (!app.isMember) {
    console.error(`错误: 你不是应用 ${app.slug} 的成员，找 Owner（${app.ownerName}）把你加入`);
    process.exitCode = 1;
    return;
  }
  if (!app.deployApproved) {
    console.error(`错误: 应用 ${app.slug} 尚未获管理员授权部署。请联系管理员在控制台「应用」页点「授权部署」（只需一次，之后不再拦）`);
    process.exitCode = 1;
    return;
  }
  const dir = path.resolve(opts.dir ?? process.cwd());
  const report = await runPrecheck(api, dir, opts.check);
  if (!report.passed) {
    console.error('\n前置检查未通过，已阻止部署。修复以上问题后重试（密钥应通过 eat env pull 在运行时读取）。');
    process.exitCode = 1;
    return;
  }
  console.log(`检查通过，触发部署 ${app.slug} → Dokploy(${app.dokployApplicationId}) ...`);
  let dep = await api.request<DeploymentInfo>('POST', `/api/apps/${app.slug}/deploy`, { report });
  // 触发失败服务端直接报错，走不到这里；这里拿到的必然是「已排进 Dokploy 队列」
  const metaId = dep.platform?.id;
  // 短轮询等待结果：按平台元数据 id 查，服务端会把它跟 Dokploy 的构建记录对上（决策 30）
  const deadline = Date.now() + 60_000;
  while (!SETTLED.has(dep.status) && metaId && Date.now() < deadline) {
    await sleep(3000);
    dep = await api.request<DeploymentInfo>('GET', `/api/apps/${app.slug}/deployments/${metaId}`);
    process.stdout.write('.');
  }
  console.log('');
  if (dep.status === 'done') {
    console.log(`部署成功（构建 ${dep.deploymentId ?? '-'}）`);
  } else if (dep.status === 'error') {
    console.error(`部署失败: ${dep.error ?? '未知原因'}`);
    console.error(`完整构建日志: eat app build-logs ${app.slug}`);
    process.exitCode = 1;
  } else if (dep.status === 'cancelled') {
    console.error('部署已被取消');
    process.exitCode = 1;
  } else {
    console.log(`仍在${STATUS_LABEL[dep.status] ?? dep.status}，稍后查询: eat app status ${app.slug}`);
  }
}

/** 一行里说清这次部署是谁发起的、有没有过平台的密钥扫描门禁（决策 30 / 31） */
function originNote(dep: DeploymentInfo): string {
  if (!dep.platform) return 'Dokploy 侧触发 ⚠ 未经平台密钥扫描';
  const who = `${dep.platform.triggeredByName}（${dep.platform.source === 'console' ? '控制台 ⚠ 未做密钥扫描' : 'eat 平台'}）`;
  return dep.platform.claim === 'inferred' ? `${who} ⚠ 归属按时间推断，未必准确` : who;
}

/** 打印一条部署记录（状态 + 来源 + 失败原因） */
function printDeployment(dep: DeploymentInfo): void {
  const id = dep.deploymentId ?? dep.platform?.id ?? '-';
  console.log(`[${STATUS_LABEL[dep.status] ?? dep.status}] ${dep.appSlug}（${id}，${when(dep.createdAt)}）`);
  console.log(`来源: ${originNote(dep)}`);
  const report = dep.platform?.report;
  if (report) console.log(`检查: 扫描 ${report.scannedFiles} 个文件 / ${report.findings.length} 个问题`);
  if (dep.status === 'archived') {
    console.log('说明: Dokploy 已清理掉这次的构建记录（每个应用只留最近 10 次），只剩平台侧元数据');
  }
  if (dep.error) console.log(`原因: ${dep.error}`);
  if (dep.status === 'error') console.log(`完整构建日志: eat app build-logs ${dep.appSlug}`);
}

/** 应用最近一次部署的状态；--deployment 查指定那次（兼收 Dokploy 构建 id 与平台元数据 id，支持前缀） */
export async function appStatus(slug: string, opts: { deployment?: string }): Promise<void> {
  const api = Api.fromSaved();
  const path = opts.deployment
    ? `/api/apps/${slug}/deployments/${encodeURIComponent(opts.deployment)}`
    : `/api/apps/${slug}/deployments/latest`;
  printDeployment(await api.request<DeploymentInfo>('GET', path));
}

export async function appDeployments(slug: string, opts: { all?: boolean }): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<DeploymentInfo[]>('GET', `/api/apps/${slug}/deployments${opts.all ? '?all=1' : ''}`);
  if (rows.length === 0) {
    console.log(`暂无部署记录（eat deploy ${slug} 触发一次）`);
    return;
  }
  for (const d of rows) {
    const id = (d.deploymentId ?? d.platform?.id ?? '-').slice(0, 8);
    const err = d.error ? ` — ${d.error.split('\n')[0]}` : '';
    console.log(`${when(d.createdAt)}  [${STATUS_LABEL[d.status] ?? d.status}] ${id.padEnd(8)}  ${originNote(d)}${err}`);
  }
  console.log(
    opts.all
      ? '\n已归档 = Dokploy 那边的构建记录已被清理，只剩平台侧元数据（谁触发的、扫描报告）'
      : `\n共 ${rows.length} 条。Dokploy 每个应用只保留最近 10 次构建；看平台完整历史用: eat app deployments ${slug} --all`,
  );
}

// ---------- 应用清单 / 详情 / 创建 / 更新 / 删除（决策 31） ----------

function approvalNote(a: AppInfo): string {
  if (a.deployApproved) return '已授权部署';
  return a.approvalRequestedAt ? '待管理员授权（已有人尝试部署）' : '待管理员授权';
}

export async function appList(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<AppInfo[]>('GET', '/api/apps');
  if (rows.length === 0) {
    console.log('暂无应用（eat app create <slug> --repo <git 地址> --build dockerfile|static 创建一个）');
    return;
  }
  for (const a of rows) {
    const mark = a.canDeploy ? '●' : a.isMember ? '◐' : '○';
    const build = a.buildType ? APP_BUILD_TYPE_LABEL[a.buildType] : '挂载';
    console.log(`${mark} ${a.slug}  ${a.name}（${build}，Owner: ${a.ownerName}，成员 ${a.members.length}，${approvalNote(a)}）${a.url ? `  ${a.url}` : ''}`);
  }
  console.log('\n● 可部署  ◐ 成员但应用未获授权  ○ 非成员');
}

function printApp(a: AppInfo): void {
  console.log(`${a.slug}  ${a.name}`);
  if (a.description) console.log(`说明: ${a.description}`);
  console.log(`Owner: ${a.ownerName}；成员: ${a.members.map((m) => m.name).join('、') || '（无）'}`);
  console.log(`Git: ${a.repoUrl || '（未填）'}${a.managed ? `  分支: ${a.branch}` : ''}`);
  if (a.managed && a.buildType) {
    const cfg =
      a.buildType === 'dockerfile'
        ? `Dockerfile: ${a.dockerfile}，构建上下文: ${a.dockerContextPath || '（仓库根）'}，容器端口: ${a.port}`
        : `发布目录: ${a.publishDirectory}，SPA 模式: ${a.staticSpa ? '开' : '关'}`;
    console.log(`构建: ${APP_BUILD_TYPE_LABEL[a.buildType]}（${cfg}）`);
  } else {
    console.log('构建: 管理员挂载的既有 Dokploy 应用，构建配置在 Dokploy 侧维护');
  }
  if (a.url) console.log(`域名: ${a.url}`);
  else if (a.managed) console.log('域名: 未分配（管理员未在「系统设置 → Dokploy」配置自动域名后缀）');
  console.log(`Dokploy application: ${a.dokployApplicationId}`);
  const approval = a.deployApproved
    ? `已授权（${a.approvedByName ?? '-'}，${when(a.approvedAt ?? '')}）`
    : `${approvalNote(a)}——找管理员在控制台「应用」页点「授权部署」`;
  console.log(`部署授权: ${approval}`);
  console.log(`我: ${a.canDeploy ? '可部署' : a.isMember ? '成员（等授权）' : '非成员'}`);
}

export async function appShow(slug: string): Promise<void> {
  const api = Api.fromSaved();
  printApp(await resolveApp(api, slug));
}

/** --port：1-65535 的整数（commander 传进来的是字符串） */
function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port 需为 1-65535 的整数，收到 ${raw}`);
  return n;
}

function parseBuildType(raw: string | undefined): AppBuildType | undefined {
  if (raw === undefined) return undefined;
  const r = appBuildTypeSchema.safeParse(raw);
  if (!r.success) throw new Error(`--build 只支持 static / dockerfile，收到 ${raw}`);
  return r.data;
}

export interface AppCreateOpts {
  name?: string;
  repo: string;
  branch?: string;
  build: string;
  dockerfile?: string;
  context?: string;
  publishDir?: string;
  spa?: boolean;
  port?: string;
  description?: string;
}

export async function appCreate(slug: string, opts: AppCreateOpts): Promise<void> {
  const api = Api.fromSaved();
  const buildType = parseBuildType(opts.build);
  if (!buildType) throw new Error('--build 必填：static（静态托管，仓库里直接放产物）或 dockerfile');
  const body: Partial<CreateAppRequest> = {
    slug,
    name: opts.name ?? slug,
    repoUrl: opts.repo,
    buildType,
    description: opts.description ?? '',
  };
  if (opts.branch) body.branch = opts.branch;
  if (opts.dockerfile) body.dockerfile = opts.dockerfile;
  if (opts.context !== undefined) body.dockerContextPath = opts.context;
  if (opts.publishDir) body.publishDirectory = opts.publishDir;
  if (opts.spa) body.staticSpa = true;
  if (opts.port !== undefined) body.port = parsePort(opts.port);
  console.log(`在 Dokploy 上创建应用 ${slug}（${APP_BUILD_TYPE_LABEL[buildType]}，${opts.repo}）...`);
  const app = await api.request<AppInfo>('POST', '/api/apps', body);
  console.log('已创建。');
  printApp(app);
  if (app.url) {
    console.log(`\n访问地址: ${app.url}（首次部署成功后可访问；DNS 由管理员配置，域名流量转发到容器端口 ${buildType === 'static' ? 80 : app.port}）`);
  }
  if (buildType === 'static') {
    console.log('\n提示: 静态托管不跑任何构建命令，只把发布目录原样交给 nginx——仓库里得直接有构建产物；要先 build 的请改用 dockerfile。');
  }
  if (!app.deployApproved) console.log('\n首次部署前需要管理员授权一次：找管理员在控制台「应用」页点「授权部署」。');
}

export interface AppUpdateOpts {
  name?: string;
  repo?: string;
  branch?: string;
  build?: string;
  dockerfile?: string;
  context?: string;
  publishDir?: string;
  /** commander 的 --spa / --no-spa：没传时是 undefined */
  spa?: boolean;
  port?: string;
  description?: string;
}

export async function appUpdate(slug: string, opts: AppUpdateOpts): Promise<void> {
  const api = Api.fromSaved();
  const body: UpdateAppRequest = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.repo !== undefined) body.repoUrl = opts.repo;
  if (opts.branch !== undefined) body.branch = opts.branch;
  const buildType = parseBuildType(opts.build);
  if (buildType) body.buildType = buildType;
  if (opts.dockerfile !== undefined) body.dockerfile = opts.dockerfile;
  if (opts.context !== undefined) body.dockerContextPath = opts.context;
  if (opts.publishDir !== undefined) body.publishDirectory = opts.publishDir;
  if (opts.spa !== undefined) body.staticSpa = opts.spa;
  if (opts.port !== undefined) body.port = parsePort(opts.port);
  if (opts.description !== undefined) body.description = opts.description;
  if (Object.keys(body).length === 0) throw new Error('没有要改的字段（eat app update --help 查看可选项）');
  const app = await api.request<AppInfo>('PATCH', `/api/apps/${slug}`, body);
  console.log('已更新，下次部署生效。');
  printApp(app);
}

export async function appDelete(slug: string, opts: { yes?: boolean }): Promise<void> {
  const api = Api.fromSaved();
  const app = await resolveApp(api, slug);
  if (!opts.yes) {
    console.error(
      app.managed
        ? `将删除应用 ${slug}，并连同 Dokploy 上的应用（${app.dokployApplicationId}）一起删除，容器与部署记录不可恢复。确认请加 --yes`
        : `将把挂载的应用 ${slug} 从平台解绑（不影响 Dokploy 上的应用本身）。确认请加 --yes`,
    );
    process.exitCode = 1;
    return;
  }
  const r = await api.request<{ ok: boolean; dokployDeleted: boolean }>('DELETE', `/api/apps/${slug}`);
  console.log(r.dokployDeleted ? `已删除 ${slug}（含 Dokploy 上的应用）` : `已解绑 ${slug}（Dokploy 上的应用保留）`);
}

// ---------- 应用 env 的拉取与推送（决策 31） ----------

const targetOf = (build?: boolean): AppEnvTarget => (build ? 'build' : 'runtime');
const defaultEnvFile = (target: AppEnvTarget): string => (target === 'build' ? '.env.build' : '.env');

export async function appEnvPull(slug: string, opts: { build?: boolean; out?: string; print?: boolean }): Promise<void> {
  const api = Api.fromSaved();
  const target = targetOf(opts.build);
  const env = await api.request<AppEnv>('GET', `/api/apps/${slug}/env`);
  const content = target === 'build' ? env.build : env.runtime;
  if (opts.print) {
    process.stdout.write(content.endsWith('\n') || content === '' ? content : `${content}\n`);
    return;
  }
  const out = opts.out ?? defaultEnvFile(target);
  fs.writeFileSync(out, content, { mode: 0o600 });
  const keys = content.split('\n').filter((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)).length;
  console.log(`已写入 ${out}（${slug} 的${APP_ENV_TARGET_LABEL[target]} env，${keys} 个变量）——值受平台审计，请勿提交到代码仓库`);
}

export async function appEnvPush(slug: string, opts: { build?: boolean; file?: string }): Promise<void> {
  const api = Api.fromSaved();
  const target = targetOf(opts.build);
  const file = opts.file ?? defaultEnvFile(target);
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}（--file 指定要推送的 dotenv 文件）`);
  const content = fs.readFileSync(file, 'utf8');
  const r = await api.request<AppEnvChange>('PUT', `/api/apps/${slug}/env`, { target, content });
  console.log(`已用 ${file} 整体覆盖 ${slug} 的${APP_ENV_TARGET_LABEL[target]} env（Dokploy 侧下次部署生效）`);
  const line = (label: string, keys: string[]) => keys.length && console.log(`  ${label}: ${keys.join(', ')}`);
  line('新增', r.added);
  line('修改', r.changed);
  line('删除', r.removed);
  if (!r.added.length && !r.changed.length && !r.removed.length) console.log('  没有变化');
  else if (r.unchanged) console.log(`  未变: ${r.unchanged} 个`);
}

// ---------- 日志 ----------

/** --tail 是字符串进来的，非法值直接交给服务端报错不友好，这里先兜一下 */
function parseTail(raw: string | undefined): number {
  if (raw === undefined) return LOG_TAIL_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--tail 需要正整数，收到 ${raw}`);
  return n;
}

/** 构建日志：部署失败时看这个，能看到 Dokploy 真正的报错 */
export async function buildLogs(slug: string, opts: { tail?: string; deployment?: string; list?: boolean }): Promise<void> {
  const api = Api.fromSaved();
  const tail = parseTail(opts.tail);
  const q = new URLSearchParams({ tail: String(tail) });
  if (opts.deployment) q.set('deploymentId', opts.deployment);
  const res = await api.request<BuildLogsResult>('GET', `/api/apps/${slug}/build-logs?${q}`);

  if (opts.list) {
    if (res.recent.length === 0) {
      console.log('Dokploy 上还没有该应用的构建记录');
      return;
    }
    for (const b of res.recent) {
      console.log(`${when(b.createdAt)}  [${BUILD_LABEL[b.status] ?? b.status}] ${b.deploymentId}  ${b.title}`);
    }
    console.log(`\n看某次的日志: eat app build-logs ${slug} --deployment <id>`);
    return;
  }
  if (!res.deployment) {
    console.log(`Dokploy 上还没有该应用的构建记录（eat deploy ${slug} 触发一次）`);
    return;
  }
  const d = res.deployment;
  console.log(`构建 ${d.deploymentId} [${BUILD_LABEL[d.status] ?? d.status}] ${when(d.createdAt)}  ${d.title}`);
  console.log(`--- 构建日志（最后 ${tail} 行）---`);
  console.log(res.logs.trimEnd() || '(日志为空)');
  if (res.recent.length > 1) console.log(`\n回看其它构建: eat app build-logs ${slug} --list`);
}

/** 运行日志：应用跑起来之后的容器输出，构建成功但服务不正常时看这个 */
export async function runLogs(slug: string, opts: { tail?: string; container?: string; list?: boolean }): Promise<void> {
  const api = Api.fromSaved();
  const tail = parseTail(opts.tail);
  const q = new URLSearchParams({ tail: String(tail) });
  if (opts.container) q.set('containerId', opts.container);
  const res = await api.request<RunLogsResult>('GET', `/api/apps/${slug}/run-logs?${q}`);

  if (opts.list) {
    if (res.containers.length === 0) {
      console.log('该应用当前没有容器');
      return;
    }
    for (const c of res.containers) console.log(`${c.containerId}  [${c.state}] ${c.name}  ${c.status}`);
    console.log(`\n看某个容器: eat app run-logs ${slug} --container <id>`);
    return;
  }
  if (!res.container) {
    console.log(`该应用当前没有运行中的容器——可能还没部署成功，先看: eat app build-logs ${slug}`);
    return;
  }
  const c = res.container;
  console.log(`容器 ${c.containerId} [${c.state}] ${c.name}  ${c.status}`);
  console.log(`--- 运行日志（最后 ${tail} 行）---`);
  console.log(res.logs.trimEnd() || '(日志为空)');
  if (res.containers.length > 1) console.log(`\n其它副本: eat app run-logs ${slug} --list`);
}

export async function scanOnly(dirArg: string | undefined): Promise<void> {
  const api = Api.fromSaved();
  const dir = path.resolve(dirArg ?? process.cwd());
  const report = await runPrecheck(api, dir);
  if (!report.passed) process.exitCode = 1;
  else console.log('通过：未发现密钥泄漏问题');
}
