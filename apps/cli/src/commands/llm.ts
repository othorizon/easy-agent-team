import { randomUUID } from 'node:crypto';
import { fchmodSync, closeSync, openSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  formatDateTime,
  llmDisplayQuota,
  type LlmGatewayInfo,
  type LlmModelInfo,
  type LlmUsagePage,
} from '@eat/shared';
import { Api } from '../client.js';

const ROOT = '/api/llm-gateway';
export function printLlmStatus(info: LlmGatewayInfo): void {
  if (!info.configured) {
    console.log('LLM API 网关尚未配置，请联系管理员。');
    return;
  }
  console.log(`Key：${info.key ? `${info.key.status} ${info.key.maskedKey}` : '未申请'}`);
  console.log(`总额度：${llmDisplayQuota(info.totalQuota, info.currency)}`);
  console.log(`已用额度：${llmDisplayQuota(info.usedQuota, info.currency)}`);
  console.log(`剩余额度：${llmDisplayQuota(info.remainingQuota, info.currency)}`);
  console.log(`接入地址：${info.apiBaseUrl}`);
  if (!info.giftClaimed) console.log(`首次申请赠送：${llmDisplayQuota(info.initialQuotaEffective, info.currency)}`);
  if (info.disabled) console.log('网关权限已禁用，请联系管理员。');
  if (info.pending) console.log('操作正在同步，可运行 eat llm retry 查询并重试。');
  if (info.error) console.log(`同步信息：${info.error}`);
  if (info.updatedAt) console.log(`额度更新时间：${formatDateTime(info.updatedAt)}`);
}
export async function llmStatus() {
  printLlmStatus(await Api.fromSaved().request<LlmGatewayInfo>('GET', ROOT));
}
export async function llmKeyShow(opts: { reveal?: boolean }) {
  if (!opts.reveal) return llmStatus();
  const value = await Api.fromSaved().request<{ key: string }>('POST', ROOT + '/key/reveal', {});
  console.log(value.key);
}
export async function llmModels() {
  const models = await Api.fromSaved().request<LlmModelInfo[]>('GET', ROOT + '/models');
  for (const m of models) console.log(m.id);
  if (!models.length) console.log('暂无可用模型。');
}
export async function llmUsage(opts: { page?: string; key?: string }) {
  const page = Number(opts.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('--page 必须是正整数');
  const api = Api.fromSaved();
  const info = await api.request<LlmGatewayInfo>('GET', ROOT);
  const logs = await api.request<LlmUsagePage>(
    'GET',
    `${ROOT}/usage?page=${page}&pageSize=20${opts.key ? `&keyId=${encodeURIComponent(opts.key)}` : ''}`,
  );
  for (const r of logs.items)
    console.log(
      `${formatDateTime(new Date(r.createdAt * 1000))}  ${r.model || '—'}  ${r.promptTokens}/${r.completionTokens} tokens  ${llmDisplayQuota(r.quota, info.currency)}`,
    );
  console.log(`第 ${logs.page} 页，共 ${logs.total} 条。历史 Key 可通过 eat llm key history 查询。`);
}
export async function llmAction(action: string, opts: { requestId?: string } = {}) {
  const requestId = opts.requestId ?? randomUUID();
  const api = Api.fromSaved();
  try {
    const result =
      action === 'retry'
        ? await api.request<LlmGatewayInfo>('POST', ROOT + '/retry', {})
        : await api.request<LlmGatewayInfo>(
            action === 'delete' ? 'DELETE' : action === 'create' ? 'POST' : 'PUT',
            ROOT + (action === 'create' || action === 'delete' ? '/key' : '/key/status'),
            { requestId, ...(['enable', 'disable'].includes(action) ? { enabled: action === 'enable' } : {}) },
          );
    printLlmStatus(result);
    if (result.pending) process.exitCode = 2;
  } catch (e) {
    console.error(`本次操作标识：${requestId}。网络中断后可用 --request-id ${requestId} 重试同一操作。`);
    throw e;
  }
}
export async function llmExport(opts: { out: string }) {
  const file = resolve(opts.out);
  // Reserve a new regular file before retrieving a secret. Never follow symlinks or overwrite an existing config.
  const fd = openSync(file, 'wx', 0o600);
  let complete = false;
  try {
    const value = await Api.fromSaved().request<{ key: string; apiBaseUrl: string }>('POST', ROOT + '/key/reveal', {});
    writeFileSync(fd, JSON.stringify({ apiBaseUrl: value.apiBaseUrl, apiKey: value.key }, null, 2) + '\n');
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) unlinkSync(file);
  }
  console.log(`连接配置已写入 ${file}（包含 API Key，请仅用于可信客户端）。`);
}
export function registerLlmCommands(program: Command) {
  const llm = program.command('llm').description('LLM API 网关：个人 Key、额度、模型与用量');
  llm.command('status').description('查看我的 Key 状态、总额度、已用与剩余').action(llmStatus);
  llm.command('models').description('列出可用模型').action(llmModels);
  llm
    .command('usage')
    .description('查看我的调用与额度消耗记录')
    .option('--page <n>', '页码', '1')
    .option('--key <id>', '历史 Key 的 EAT ID')
    .action(llmUsage);
  llm
    .command('retry')
    .description('重试自己尚未完成的网关操作')
    .action(() => llmAction('retry'));
  const key = llm.command('key').description('管理自己的模型 API Key（最多一把有效 Key）');
  key
    .command('show')
    .description('查看 Key 状态与掩码；使用 --reveal 输出完整 Key')
    .option('--reveal', '仅输出完整 Key（明文），便于脚本读取')
    .action(llmKeyShow);
  key
    .command('history')
    .description('查看历史 Key ID 与消耗，供 usage --key 使用')
    .action(async () => {
      const rows = await Api.fromSaved().request<Array<{ id: string; state: string; createdAt: string }>>(
        'GET',
        ROOT + '/keys/history',
      );
      for (const row of rows) console.log(`${row.id}  ${row.state}  ${formatDateTime(row.createdAt)}`);
    });
  for (const [action, description] of [
    ['create', '申请自己的 Key（重建保留余额，不重复赠送）'],
    ['enable', '启用自己的 Key'],
    ['disable', '停用自己的 Key'],
    ['delete', '撤销自己的 Key，保留额度与历史'],
  ] as const) {
    key
      .command(action)
      .description(description)
      .option('--request-id <uuid>', '重试此前操作的幂等标识')
      .action((opts) => llmAction(action, opts));
  }
  key
    .command('export')
    .description('将 Key 与接入地址导出到新文件（0600，不输出明文）')
    .requiredOption('--out <file>', '新文件路径，已存在则拒绝覆盖')
    .action(llmExport);
}
