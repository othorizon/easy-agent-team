import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { CLI_VERSION } from '@eat/shared';
import type { DeploymentInfo, PrecheckReport, ProjectInfo, SecretFingerprint } from '@eat/shared';
import { Api } from '../client.js';
import { scanWorkspace } from '../scan.js';

const STATUS_LABEL: Record<string, string> = { deploying: '部署中', success: '成功', failed: '失败' };
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
    console.log(`仍在部署中，稍后查询: eat deploy-status ${dep.id}`);
  } else if (dep.status === 'success') {
    console.log(`部署成功（${dep.id}）`);
  } else {
    console.error(`部署失败: ${dep.error ?? '未知原因'}`);
    process.exitCode = 1;
  }
}

export async function deployStatus(id: string): Promise<void> {
  const api = Api.fromSaved();
  const dep = await api.request<DeploymentInfo>('GET', `/api/deployments/${id}`);
  console.log(`[${STATUS_LABEL[dep.status]}] ${dep.projectSlug}（${dep.id}，触发人 ${dep.triggeredByName}）`);
  if (dep.error) console.log(`原因: ${dep.error}`);
}

export async function deployList(slug: string): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<DeploymentInfo[]>('GET', `/api/projects/${slug}/deployments`);
  if (rows.length === 0) {
    console.log('暂无部署记录');
    return;
  }
  for (const d of rows) {
    console.log(`${d.createdAt.slice(0, 16).replace('T', ' ')}  [${STATUS_LABEL[d.status]}] ${d.id.slice(0, 8)} by ${d.triggeredByName}${d.error ? ' — ' + d.error : ''}`);
  }
}

export async function projectsList(): Promise<void> {
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

export async function scanOnly(dirArg: string | undefined): Promise<void> {
  const api = Api.fromSaved();
  const dir = path.resolve(dirArg ?? process.cwd());
  const report = await runPrecheck(api, dir);
  if (!report.passed) process.exitCode = 1;
  else console.log('通过：未发现密钥泄漏问题');
}
