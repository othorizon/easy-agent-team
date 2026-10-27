import { dbCredentialsToEnv, matchDbAssignments, resolveDbInstance } from '@eat/shared';
import type { DbAssignmentInfo, DbCredentials, DbInstanceInfo } from '@eat/shared';
import { Api } from '../client.js';
import { mergeEnvFile, printWriteResult, writeEnvFile } from '../dotenv-file.js';
import { formatDotenvLine, PRINT_FORMATS, renderPrinted, type PrintFormat } from '../dotenv-format.js';

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
  console.log(`申请已提交（${r.dbName} @ ${r.instanceName}），等待管理员批准。批准后用 eat db pull ${r.dbName} 取连接凭证。`);
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
          ? `凭证: eat db pull ${refOf(r, rows)}`
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

/** 库名 / `库名@实例名` 在自己名下找；完整 id 直接放行（管理员可按 id 取别人的，权限由服务端判） */
async function resolveAssignmentId(api: Api, ref: string): Promise<string> {
  if (FULL_UUID.test(ref.trim())) return ref.trim();
  const rows = await api.request<DbAssignmentInfo[]>('GET', '/api/db/assignments/mine');
  const hits = matchDbAssignments(rows, ref);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    throw new Error(
      `有 ${hits.length} 个名为 ${ref} 的库，请写成「库名@实例名」：\n${hits.map((h) => `  eat db pull ${h.dbName}@${h.instanceName}`).join('\n')}`,
    );
  }
  const names = rows.filter((r) => r.status === 'active').map((r) => refOf(r, rows));
  throw new Error(
    `名下没有库 ${ref}。${names.length > 0 ? `可用的有：${names.join('、')}` : '还没有已开通的库，eat db list 查看申请进度'}`,
  );
}

/**
 * 取数据库连接凭证（决策 91）：凭证只在数据库这里取，不在环境变量里。
 * 落盘行为与 `eat env pull` 一致——默认写 ./.env，不是 eat 写的文件就中止（决策 63），
 * 已有手写 .env 的项目用 --merge 只改 DB_* 几行。
 */
export async function dbPull(
  ref: string,
  opts: { out?: string; print?: boolean; force?: boolean; merge?: boolean; format?: string },
): Promise<void> {
  if (opts.format !== undefined && !opts.print) {
    throw new Error('--format 只用于 --print（写文件一律是 dotenv）；导出到当前 shell：eval "$(eat db pull <库> --print --format shell)"');
  }
  const format = (opts.format ?? 'dotenv') as PrintFormat;
  if (!PRINT_FORMATS.includes(format)) throw new Error(`--format 只能是 ${PRINT_FORMATS.join(' / ')}，收到 ${opts.format}`);
  if (opts.merge && opts.print) throw new Error('--merge 是合并进文件，不能和 --print 一起用');
  if (opts.merge && opts.force) throw new Error('--merge 只改同名 key、追加新 key，不会整份覆盖，不需要 --force');

  const api = Api.fromSaved();
  const id = await resolveAssignmentId(api, ref);
  const cred = await api.request<DbCredentials>('POST', `/api/db/assignments/${id}/credentials`);
  const values = dbCredentialsToEnv(cred);
  const command = `eat db pull ${ref.trim()}`;
  const summary = `${cred.database} 的 ${values.length} 个连接变量`;

  if (opts.print) {
    process.stdout.write(renderPrinted(values, format));
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
