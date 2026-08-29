import * as fs from 'node:fs';
import type { AccessRequestInfo, EnvironmentInfo, PullValuesResponse, VariableMeta } from '@eat/shared';
import { Api } from '../client.js';

type CatalogEntry = { environment: EnvironmentInfo; variables: VariableMeta[] };

/** 变量清单：AI 与人共用的"认路"入口，展示 key + 备注 + 权限状态 */
export async function envList(envSlug?: string): Promise<void> {
  const api = Api.fromSaved();
  const catalog = await api.request<CatalogEntry[]>('GET', '/api/catalog');
  const entries = envSlug ? catalog.filter((c) => c.environment.slug === envSlug) : catalog;
  if (entries.length === 0) {
    console.log(envSlug ? `环境 ${envSlug} 不存在或不可见` : '暂无环境');
    return;
  }
  for (const { environment, variables } of entries) {
    console.log(`\n${environment.slug}  —  ${environment.name}（Owner: ${environment.ownerName}）`);
    if (environment.description) console.log(`  ${environment.description}`);
    if (variables.length === 0) {
      console.log('  (无可见变量)');
      continue;
    }
    const keyWidth = Math.max(...variables.map((v) => v.key.length), 3);
    for (const v of variables) {
      const access = v.hasAccess ? '✓ 可读取' : '✗ 无权限';
      // 非敏感变量在有权限时清单直接附带明文值
      const valueHint = v.value != null ? `（值: ${v.value}）` : '';
      console.log(`  ${v.key.padEnd(keyWidth)}  ${access}  ${v.description}${valueHint}`);
    }
  }
  console.log('\n提示：eat env pull <env> 拉取值；无权限时 eat env request <env> <KEY> --reason "..." 申请');
}

function dotenvEscape(value: string): string {
  return /^[A-Za-z0-9_@:./-]*$/.test(value) ? value : JSON.stringify(value);
}

export async function envPull(
  envSlug: string,
  opts: { keys?: string; out?: string; print?: boolean },
): Promise<void> {
  const api = Api.fromSaved();
  const keys = opts.keys ? opts.keys.split(',').map((k) => k.trim()).filter(Boolean) : undefined;
  const res = await api.request<PullValuesResponse>('POST', `/api/envs/${envSlug}/values`, { keys });

  const got = Object.entries(res.values);
  if (got.length > 0) {
    if (opts.print) {
      for (const [k, v] of got) console.log(`${k}=${dotenvEscape(v)}`);
    } else {
      const out = opts.out ?? '.env';
      const lines = [
        `# 由 eat env pull ${envSlug} 生成 — 值受平台审计，请勿提交到代码仓库`,
        ...got.map(([k, v]) => `${k}=${dotenvEscape(v)}`),
        '',
      ];
      fs.writeFileSync(out, lines.join('\n'), { mode: 0o600 });
      console.log(`已写入 ${out}（${got.length} 个变量）`);
    }
  }
  if (res.denied.length > 0) {
    console.error(`\n以下变量无权限（${res.denied.length} 个）：`);
    for (const d of res.denied) console.error(`  ${d.key}: ${d.message}`);
    console.error(
      `申请权限: eat env request ${envSlug} ${res.denied.map((d) => d.key).join(' ')} --reason "<用途说明>"`,
    );
    if (got.length === 0) process.exitCode = 1;
  }
}

export async function envRequest(envSlug: string, keys: string[], opts: { reason: string }): Promise<void> {
  const api = Api.fromSaved();
  const res = await api.request<AccessRequestInfo>('POST', '/api/access-requests', {
    environmentSlug: envSlug,
    keys,
    reason: opts.reason,
  });
  console.log(`申请已提交（ID: ${res.id}），等待环境 Owner 审批。`);
  console.log(`查看进度: eat env requests`);
}

export async function envRequests(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<AccessRequestInfo[]>('GET', '/api/access-requests/mine');
  if (rows.length === 0) {
    console.log('暂无权限申请记录');
    return;
  }
  const statusLabel: Record<string, string> = { pending: '待审批', approved: '已批准', rejected: '已驳回' };
  for (const r of rows) {
    console.log(
      `${r.createdAt.slice(0, 16)}  ${statusLabel[r.status] ?? r.status}  ${r.environmentSlug}: ${r.keys.join(', ')}`,
    );
  }
}
