import type { DbAssignmentInfo, DbInstanceInfo } from '@eat/shared';
import { Api } from '../client.js';

const STATUS_LABEL: Record<string, string> = {
  pending: '待批准',
  active: '可用',
  failed: '执行失败',
  rejected: '已驳回',
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
  const inst = instances.find((i) => i.id === opts.instance || i.name === opts.instance);
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
  console.log(`申请已提交（${r.dbName} @ ${r.instanceName}），等待管理员批准。批准后 eat db list 可见凭证环境。`);
}

export async function dbList(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<DbAssignmentInfo[]>('GET', '/api/db/assignments/mine');
  if (rows.length === 0) {
    console.log('暂无数据库分配。申请: eat db request <库名> --instance <实例> --purpose "<用途>"');
    return;
  }
  for (const r of rows) {
    const env = r.environmentSlug ? `凭证: eat env pull ${r.environmentSlug}` : (r.error ? `错误: ${r.error}` : '');
    console.log(`[${STATUS_LABEL[r.status] ?? r.status}] ${r.dbName} @ ${r.instanceName}（${r.dbUser}） ${env}`);
  }
}
