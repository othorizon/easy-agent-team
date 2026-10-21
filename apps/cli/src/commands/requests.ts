import type { Command } from 'commander';
import {
  REQUEST_TYPES,
  REQUEST_STATUSES,
  requestListSchema,
  type ApprovalRequestPage,
  type ApprovalRequestDetail,
} from '@eat/shared';
import { Api } from '../client.js';

export function registerRequestCommands(program: Command) {
  const requests = program.command('requests').description('统一申请：查看进度、驳回原因及历次记录');
  requests
    .command('list')
    .description('查看我发起的各类申请')
    .option('--status <status>', 'all / ongoing / pending / approved / rejected / withdrawn / invalid', 'all')
    .option('--type <type>', 'env / mcp / db / oss / app')
    .option('--page <page>', '页码', '1')
    .option('--json', '输出 JSON')
    .action(async (opts) => {
      const q = requestListSchema.parse({ scope: 'mine', status: opts.status, type: opts.type, page: opts.page });
      const params = new URLSearchParams({
        scope: 'mine',
        status: q.status,
        page: String(q.page),
        pageSize: String(q.pageSize),
      });
      if (q.type) params.set('type', q.type);
      const result = await Api.fromSaved().request<ApprovalRequestPage>('GET', '/api/requests?' + params);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.items.length) console.log('暂无符合条件的申请');
      for (const r of result.items) {
        console.log(`${r.id}  [${REQUEST_STATUSES[r.status]}] ${REQUEST_TYPES[r.type]} · ${r.targetName}`);
        if (r.rejectionReason) console.log(`  驳回原因：${r.rejectionReason}`);
        if (r.closedReason) console.log(`  结束原因：${r.closedReason}`);
        if (r.execution) console.log(`  执行状态：${r.execution}${r.executionError ? ' · ' + r.executionError : ''}`);
      }
      console.log(`第 ${result.page} 页，共 ${result.total} 条。详情：eat requests show <申请ID>`);
    });
  requests
    .command('show <id>')
    .description('查看完整驳回原因、审批人和历史轮次')
    .option('--json', '输出 JSON')
    .action(async (id, opts) => {
      const result = await Api.fromSaved().request<ApprovalRequestDetail>(
        'GET',
        `/api/requests/${encodeURIComponent(id)}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const r = result.request;
      console.log(
        `${REQUEST_TYPES[r.type]} · ${r.targetName}\n状态：${REQUEST_STATUSES[r.status]}\n申请说明：${r.reason}\n审批人：${r.decidedByName ?? '未记录'}\n处理时间：${r.decidedAt ?? '未记录'}`,
      );
      if (r.status === 'rejected') console.log(`驳回原因：${r.rejectionReason ?? '旧记录未保存'}`);
      if (r.closedReason) console.log(`结束原因：${r.closedReason}`);
      if (r.execution) console.log(`执行状态：${r.execution}${r.executionError ? ' · ' + r.executionError : ''}`);
      if (result.rounds.length > 1) {
        console.log('\n历次申请：');
        for (const x of result.rounds)
          console.log(
            `  第 ${x.round} 次 [${REQUEST_STATUSES[x.status]}] ${x.rejectionReason ?? x.closedReason ?? x.reason}`,
          );
      }
    });
  requests
    .command('withdraw <id>')
    .description('撤回自己的待审批申请')
    .action(async (id) => {
      await Api.fromSaved().request('POST', `/api/requests/${encodeURIComponent(id)}/withdraw`, {});
      console.log('申请已撤回');
    });
  requests
    .command('resubmit <id>')
    .description('被驳回或撤回后，说明修改并重新申请')
    .requiredOption('--reason <reason>', '本次申请说明')
    .action(async (id, opts) => {
      const result = await Api.fromSaved().request<ApprovalRequestDetail>(
        'POST',
        `/api/requests/${encodeURIComponent(id)}/resubmit`,
        { reason: opts.reason },
      );
      console.log(`申请已提交：${result.request.id}`);
    });
}
