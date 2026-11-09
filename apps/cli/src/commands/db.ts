import { requestDbAccessSchema, dbCredentialsToEnv, matchDbAssignments, matchDbCredentialTargets, resolveDbInstance } from '@eat/shared';
import type { DbAccessRequestResult, DbAccessCredentials, DbAccessGrantInfo, DbAssignmentInfo, DbCredentials, DbCredentialTarget, DbCatalogInfo, DbPersonalPasswordReset, DbInstanceInfo } from '@eat/shared';
import { Api } from '../client.js';
import { mergeEnvFile, printWriteResult, writeEnvFile } from '../dotenv-file.js';
import { formatDotenvLine, PRINT_FORMATS, renderPrinted, type PrintFormat } from '../dotenv-format.js';
import { runWithEnv } from '../run-with-env.js';

const STATUS_LABEL: Record<string, string> = {
  pending: '待批准',
  active: '可用',
  provisioning: '开通中',
  failed: '执行失败',
  rejected: '已驳回',
  withdrawn: '已撤回',
  disabled: '已禁用',
  deleted: '已删除',
};

export async function dbInstances(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<DbInstanceInfo[]>('GET', '/api/db/instances');
  if (rows.length === 0) {
    console.log('暂无数据库实例（由管理员在控制台登记）');
    return;
  }
  for (const r of rows) {
    console.log(`${r.id}  ${r.name}（${r.engine} ${r.host}:${r.port}，已分配 ${r.assignmentCount}）${r.note ? ' — ' + r.note : ''}`);
  }
}

export async function dbRequest(dbName: string, opts: { instance: string; purpose: string }): Promise<void> {
  const api = Api.fromSaved();
  const instances = await api.request<DbInstanceInfo[]>('GET', '/api/db/instances');
  const inst = resolveDbInstance(instances, opts.instance);
  if (!inst) {
    console.error(`错误: 找不到实例 ${opts.instance}（eat db instances 查看）`);
    process.exitCode = 1;
    return;
  }
  const r = await api.request<DbAssignmentInfo>('POST', '/api/db/assignments', {
    instanceId: inst.id,
    dbName,
    purpose: opts.purpose,
  });
  console.log(`申请已提交（${r.dbName} @ ${r.instanceName}），等待管理员批准。批准后用 eat db credentials pull ${r.dbName} 取连接凭证。`);
}

export async function dbList(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<DbAssignmentInfo[]>('GET', '/api/db/assignments/mine');
  if (rows.length === 0) {
    console.log('暂无数据库分配。申请: eat db request <库名> --instance <实例> --purpose "<用途>"');
    return;
  }
  for (const r of rows) {
    const hint =
      r.status === 'active'
        ? r.hasCredentials
          ? `凭证: eat db credentials pull ${refOf(r, rows)}`
          : '平台上没有这个账号的密码，请管理员在实例上重置'
        : r.error
          ? `错误: ${r.error}`
          : '';
    console.log(`[${STATUS_LABEL[r.status] ?? r.status}] ${r.dbName} @ ${r.instanceName}（${r.dbUser}） ${hint}${r.rejectionReason ? `\n  驳回原因：${r.rejectionReason}` : ''}`);
  }
}

/** 命令里怎么指这条分配：库名够用就写库名，同名库分在两台实例上时写 `库名@实例名` */
function refOf(r: DbAssignmentInfo, rows: DbAssignmentInfo[]): string {
  return matchDbAssignments(rows, r.dbName).length > 1 ? `${r.dbName}@${r.instanceName}` : r.dbName;
}

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 完整分配 UUID 保留旧管理员入口；名字只从本人的有效分配与授权中选择。 */
async function resolveCredentialTarget(api: Api, ref: string): Promise<Pick<DbCredentialTarget, 'kind' | 'id'>> {
  if (FULL_UUID.test(ref.trim())) return { kind: 'owner', id: ref.trim() };
  const [rows, grants] = await Promise.all([
    api.request<DbAssignmentInfo[]>('GET', '/api/db/assignments/mine'),
    api.request<DbAccessGrantInfo[]>('GET', '/api/db/access/grants?scope=mine'),
  ]);
  const hits = matchDbCredentialTargets(rows, grants, ref);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`有 ${hits.length} 个名为 ${ref} 的库，请写成「库名@实例名」：\n${hits.map(h => `  ${h.dbName}@${h.instanceName}`).join('\n')}`);
  const names = [...new Set([...rows.filter(r => r.status === 'active'), ...grants.filter(g => g.state === 'active')].map(r => {
    return matchDbCredentialTargets(rows, grants, r.dbName).length > 1 ? `${r.dbName}@${r.instanceName}` : r.dbName;
  }))];
  throw new Error(`没有库 ${ref} 的有效分配或授权。${names.length ? `可用的有：${names.join('、')}。` : ''}用 eat db access list 查看开放申请的库，在控制台数据库权限页向 Owner 申请。`);
}

/** `--print` 的格式：在 dotenv / shell / json 之外多一个 url——只输出连接串，`psql "$(…)"` 一行连上 */
const CREDENTIAL_PRINT_FORMATS = [...PRINT_FORMATS, 'url'] as const;
type CredentialPrintFormat = (typeof CREDENTIAL_PRINT_FORMATS)[number];

async function fetchCredentials(ref: string): Promise<DbCredentials | DbAccessCredentials> {
  const api = Api.fromSaved();
  const target = await resolveCredentialTarget(api, ref);
  return api.request('POST', target.kind === 'owner' ? `/api/db/assignments/${target.id}/credentials` : `/api/db/access/catalog/${target.id}/credentials`);
}

/**
 * 取数据库连接凭证写进本地文件（决策 91）：凭证只在数据库这里取，不在环境变量里。
 * 落盘行为与 `eat env pull` 一致——默认写 ./.env，不是 eat 写的文件就中止（决策 63），
 * 已有手写 .env 的项目用 --merge 只改 DB_* 几行；--print 只打印。
 */
export async function dbCredentialsPull(
  ref: string,
  opts: { out?: string; print?: boolean; force?: boolean; merge?: boolean; format?: string },
): Promise<void> {
  if (opts.format !== undefined && !opts.print) {
    throw new Error(
      '--format 只用于 --print（写文件一律是 dotenv）；连接串：eat db credentials pull <库> --print --format url',
    );
  }
  const format = (opts.format ?? 'dotenv') as CredentialPrintFormat;
  if (!CREDENTIAL_PRINT_FORMATS.includes(format)) {
    throw new Error(`--format 只能是 ${CREDENTIAL_PRINT_FORMATS.join(' / ')}，收到 ${opts.format}`);
  }
  if (opts.merge && opts.print) throw new Error('--merge 是合并进文件，不能和 --print 一起用');
  if (opts.merge && opts.force) throw new Error('--merge 只改同名 key、追加新 key，不会整份覆盖，不需要 --force');

  const cred = await fetchCredentials(ref);
  const values = dbCredentialsToEnv(cred);
  const command = `eat db credentials pull ${ref.trim()}`;
  const summary = `${cred.database} 的 ${values.length} 个连接变量`;

  if (opts.print) {
    process.stdout.write(format === 'url' ? `${cred.url}\n` : renderPrinted(values, format as PrintFormat));
  } else if (opts.merge) {
    printWriteResult(mergeEnvFile({ file: opts.out ?? '.env', values, command }), `合并 ${summary}，其余内容原样保留`);
  } else {
    const written = writeEnvFile({
      file: opts.out ?? '.env',
      content: values.map(([k, v]) => formatDotenvLine(k, v)).join('\n'),
      command,
      force: opts.force,
      mergeHint: true,
    });
    printWriteResult(written, summary);
  }
}

/**
 * 把连接凭证注入子进程后运行命令：值只进这一个子进程、不落盘（同 `eat env run`）。
 * 要和环境变量一起用就嵌套：eat env run <环境> -- eat db credentials run <库> -- <命令>
 */
export async function dbCredentialsRun(ref: string, command: string[]): Promise<void> {
  if (command.length === 0) throw new Error('缺少要运行的命令：eat db credentials run <库> -- <命令...>');
  const cred = await fetchCredentials(ref);
  await runWithEnv(command, new Map(dbCredentialsToEnv(cred)));
}

/** 与 credentials run 使用同一个函数，参数与执行语义完全一致。 */
export const dbRun = dbCredentialsRun;

export async function dbAccessList(): Promise<void> {
  const api = Api.fromSaved();
  const [catalog, grants] = await Promise.all([
    api.request<DbCatalogInfo[]>('GET', '/api/db/access/catalog'),
    api.request<DbAccessGrantInfo[]>('GET', '/api/db/access/grants?scope=mine'),
  ]);
  console.log('开放申请的库：');
  for (const c of catalog.filter(c => c.open)) console.log(`  ${c.dbName}@${c.instanceName} · Owner ${c.ownerName}`);
  console.log('我的授权：');
  for (const g of grants) console.log(`  [${g.state}] ${g.dbName}@${g.instanceName} · ${g.level === 'read' ? '只读' : '读写'}${g.error ? ` · ${g.error}` : ''}`);
  console.log('申请：eat db access request <库@实例> --level read|write --reason "用途"。个人凭证只供本人临时使用，不要配进线上服务。');
}

async function resolveOwnGrant(api: Api, ref: string, activeOnly: boolean): Promise<DbAccessGrantInfo> {
  const rows = await api.request<DbAccessGrantInfo[]>('GET', '/api/db/access/grants?scope=mine');
  const eligible = rows.filter(g => activeOnly ? g.state === 'active' : g.state !== 'revoked');
  const hits = matchDbCredentialTargets([], eligible.map(g => ({ ...g, state: 'active' })), ref);
  if (hits.length > 1) throw new Error(`有多个同名库，请写成「库名@实例名」：${hits.map(h => `${h.dbName}@${h.instanceName}`).join('、')}`);
  if (!hits.length) throw new Error(`没有库 ${ref} 的${activeOnly ? '有效' : ''}个人授权。用 eat db access list 查看，在控制台数据库权限页申请。`);
  return eligible.find(g => g.catalogId === hits[0].id)!;
}
export async function dbAccessRevoke(ref: string): Promise<void> {
  const api = Api.fromSaved();
  const grant = await resolveOwnGrant(api, ref, false);
  const result = await api.request<DbAccessGrantInfo>('POST', `/api/db/access/grants/${grant.id}/relinquish`);
  if (result.state !== 'revoked') throw new Error(`放弃授权尚未完成：${result.error ?? result.state}。请在控制台重试。`);
  console.log(`已放弃 ${grant.dbName}@${grant.instanceName} 的授权`);
}
export async function dbAccessResetPassword(ref: string): Promise<void> {
  const api = Api.fromSaved();
  const grant = await resolveOwnGrant(api, ref, true);
  console.error(`提示：同一实例 ${grant.instanceName} 上其他库的授权也会使用新密码。个人凭证不要配进线上服务。`);
  const result = await api.request<DbPersonalPasswordReset>('POST', `/api/db/access/catalog/${grant.catalogId}/reset-password`);
  if (result.state !== 'complete') throw new Error(`个人密码重置待完成：${result.error ?? '平台将自动重试'}。请稍后用 eat db run 重试。`);
  console.log('个人密码已重置。下次 eat db run 将自动使用新密码。');
}

export async function dbAccessRequest(ref: string, opts: { level: string; reason: string }): Promise<void> {
  const dto = requestDbAccessSchema.parse(opts);
  const api = Api.fromSaved();
  const rows = await api.request<DbCatalogInfo[]>('GET', '/api/db/access/catalog');
  const hits = matchDbAssignments(rows.filter(c => c.id && c.open && c.state === 'active').map(c => ({ ...c, id: c.id!, status: 'active' })), ref);
  if (hits.length > 1) throw new Error(`有多个同名库，请写成「库名@实例名」：${hits.map(c => `${c.dbName}@${c.instanceName}`).join('、')}`);
  if (!hits.length) throw new Error(`未找到开放申请的库 ${ref}，用 eat db access list 查看`);
  const result = await api.request<DbAccessRequestResult>('POST', `/api/db/access/catalog/${hits[0].id}/requests`, dto);
  if (result.requestId) console.log(`申请已提交：${result.requestId}。用 eat requests show ${result.requestId} 查看审批与执行状态。`);
  else if (result.grant?.state === 'active') console.log('数据库权限已生效（Owner 或管理员自己申请直接授予）。');
  else console.log(`已授予，执行尚未完成：${result.grant?.error ?? result.grant?.state}。请在控制台重试，无需重新申请。`);
}
