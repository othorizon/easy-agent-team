import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { CLI_VERSION, LOG_TAIL_DEFAULT } from '@eat/shared';
import type {
  BuildLogsResult,
  DeploymentInfo,
  PrecheckReport,
  ProjectInfo,
  RunLogsResult,
  SecretFingerprint,
} from '@eat/shared';
import { Api } from '../client.js';
import { scanWorkspace } from '../scan.js';

const STATUS_LABEL: Record<string, string> = { deploying: '部署中', success: '成功', failed: '失败' };
/** Dokploy 构建记录自己的状态取值 */
const BUILD_LABEL: Record<string, string> = { running: '构建中', done: '成功', error: '失败', idle: '空闲' };
const when = (iso: string): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveProject(api: Api, slug?: string): Promise<ProjectInfo> {
  const projects = await api.request<ProjectInfo[]>('GET', '/api/projects');
  if (slug) {
    const p = projects.find((x) => x.slug === slug);
    if (!p) throw new Error(`项目 ${slug} 不存在（eat projects 查看）`);
    return p;
  }
  const deployable = projects.filter((p) => p.canDeploy);
  if (deployable.length === 1) return deployable[0];
  throw new Error(
    deployable.length === 0
      ? '你不是任何项目的成员，找项目 Owner 把你加入项目'
      : `请指定项目: eat deploy <slug>，候选: ${deployable.map((p) => p.slug).join(', ')}`,
  );
}

/** 本地前置检查：密钥扫描（强制）+ 可选预跑命令 */
async function runPrecheck(api: Api, dir: string, checkCmd?: string): Promise<PrecheckReport> {
  console.log(`前置检查: 扫描 ${dir} ...`);
  const fingerprints = await api.request<SecretFingerprint[]>('GET', '/api/secret-fingerprints');
  const { scannedFiles, findings } = scanWorkspace(dir, fingerprints);
  console.log(`  已扫描 ${scannedFiles} 个文件，${findings.length} 个问题`);
  if (scannedFiles === 0) {
    console.warn('  ⚠ 没扫到任何文件，确认目录指向项目代码（部署时用 --dir 指定），否则密钥检查等于没做');
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
  const project = await resolveProject(api, slug);
  if (!project.canDeploy) {
    console.error(`错误: 你不是项目 ${project.slug} 的成员，找 Owner（${project.ownerName}）把你加入`);
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
  console.log(`检查通过，触发部署 ${project.slug} → Dokploy(${project.dokployApplicationId}) ...`);
  let dep = await api.request<DeploymentInfo>('POST', `/api/projects/${project.slug}/deploy`, { report });
  if (dep.status === 'failed') {
    console.error(`部署触发失败: ${dep.error}`);
    process.exitCode = 1;
    return;
  }
  // 短轮询等待结果，超时则交给 status 命令
  const deadline = Date.now() + 60_000;
  while (dep.status === 'deploying' && Date.now() < deadline) {
    await sleep(3000);
    dep = await api.request<DeploymentInfo>('GET', `/api/deployments/${dep.id}`);
    process.stdout.write('.');
  }
  console.log('');
  if (dep.status === 'deploying') {
    console.log(`仍在部署中，稍后查询: eat project status ${project.slug}`);
  } else if (dep.status === 'success') {
    console.log(`部署成功（${dep.id}）`);
  } else {
    console.error(`部署失败: ${dep.error ?? '未知原因'}`);
    console.error(`完整构建日志: eat project build-logs ${project.slug}`);
    process.exitCode = 1;
  }
}

/** 打印一条部署记录（状态 + 失败原因） */
function printDeployment(dep: DeploymentInfo): void {
  console.log(
    `[${STATUS_LABEL[dep.status]}] ${dep.projectSlug}（部署 ${dep.id.slice(0, 8)}，触发人 ${dep.triggeredByName}，${when(dep.createdAt)}）`,
  );
  if (dep.error) console.log(`原因: ${dep.error}`);
  if (dep.status === 'failed') console.log(`完整构建日志: eat project build-logs ${dep.projectSlug}`);
}

/** 项目最近一次部署的状态；--deployment 查指定那次（兼收完整 ID 与 8 位短 ID） */
export async function projectStatus(slug: string, opts: { deployment?: string }): Promise<void> {
  const api = Api.fromSaved();
  const dep = opts.deployment
    ? await api.request<DeploymentInfo>('GET', `/api/deployments/${opts.deployment}`)
    : await api.request<DeploymentInfo>('GET', `/api/projects/${slug}/deployments/latest`);
  printDeployment(dep);
}

/** 老命令 eat deploy-status <id> 的实现，保留一轮 */
export async function deployStatus(id: string): Promise<void> {
  const api = Api.fromSaved();
  printDeployment(await api.request<DeploymentInfo>('GET', `/api/deployments/${id}`));
}

export async function projectDeployments(slug: string): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<DeploymentInfo[]>('GET', `/api/projects/${slug}/deployments`);
  if (rows.length === 0) {
    console.log(`暂无部署记录（eat deploy ${slug} 触发一次）`);
    return;
  }
  for (const d of rows) {
    console.log(
      `${when(d.createdAt)}  [${STATUS_LABEL[d.status]}] ${d.id.slice(0, 8)} by ${d.triggeredByName}${d.error ? ' — ' + d.error.split('\n')[0] : ''}`,
    );
  }
}

export async function projectList(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<ProjectInfo[]>('GET', '/api/projects');
  if (rows.length === 0) {
    console.log('暂无项目（在控制台「项目」页创建）');
    return;
  }
  for (const p of rows) {
    console.log(`${p.canDeploy ? '●' : '○'} ${p.slug}  ${p.name}（Owner: ${p.ownerName}，成员 ${p.members.length}）`);
  }
  console.log('\n● 可部署  ○ 非成员');
}

/** --tail 是字符串进来的，非法值直接交给服务端报错不友好，这里先兜一下 */
function parseTail(raw: string | undefined): number {
  if (raw === undefined) return LOG_TAIL_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--tail 需要正整数，收到 ${raw}`);
  return n;
}

/** 构建日志：部署失败时看这个，能看到 Dokploy 真正的报错 */
export async function buildLogs(
  slug: string,
  opts: { tail?: string; deployment?: string; list?: boolean },
): Promise<void> {
  const api = Api.fromSaved();
  const tail = parseTail(opts.tail);
  const q = new URLSearchParams({ tail: String(tail) });
  if (opts.deployment) q.set('deploymentId', opts.deployment);
  const res = await api.request<BuildLogsResult>('GET', `/api/projects/${slug}/build-logs?${q}`);

  if (opts.list) {
    if (res.recent.length === 0) {
      console.log('Dokploy 上还没有该应用的构建记录');
      return;
    }
    for (const b of res.recent) {
      console.log(`${when(b.createdAt)}  [${BUILD_LABEL[b.status] ?? b.status}] ${b.deploymentId}  ${b.title}`);
    }
    console.log(`\n看某次的日志: eat project build-logs ${slug} --deployment <id>`);
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
  if (res.recent.length > 1) console.log(`\n回看其它构建: eat project build-logs ${slug} --list`);
}

/** 运行日志：应用跑起来之后的容器输出，构建成功但服务不正常时看这个 */
export async function runLogs(
  slug: string,
  opts: { tail?: string; container?: string; list?: boolean },
): Promise<void> {
  const api = Api.fromSaved();
  const tail = parseTail(opts.tail);
  const q = new URLSearchParams({ tail: String(tail) });
  if (opts.container) q.set('containerId', opts.container);
  const res = await api.request<RunLogsResult>('GET', `/api/projects/${slug}/run-logs?${q}`);

  if (opts.list) {
    if (res.containers.length === 0) {
      console.log('该应用当前没有容器');
      return;
    }
    for (const c of res.containers) console.log(`${c.containerId}  [${c.state}] ${c.name}  ${c.status}`);
    console.log(`\n看某个容器: eat project run-logs ${slug} --container <id>`);
    return;
  }
  if (!res.container) {
    console.log(`该应用当前没有运行中的容器——可能还没部署成功，先看: eat project build-logs ${slug}`);
    return;
  }
  const c = res.container;
  console.log(`容器 ${c.containerId} [${c.state}] ${c.name}  ${c.status}`);
  console.log(`--- 运行日志（最后 ${tail} 行）---`);
  console.log(res.logs.trimEnd() || '(日志为空)');
  if (res.containers.length > 1) console.log(`\n其它副本: eat project run-logs ${slug} --list`);
}

export async function scanOnly(dirArg: string | undefined): Promise<void> {
  const api = Api.fromSaved();
  const dir = path.resolve(dirArg ?? process.cwd());
  const report = await runPrecheck(api, dir);
  if (!report.passed) process.exitCode = 1;
  else console.log('通过：未发现密钥泄漏问题');
}
