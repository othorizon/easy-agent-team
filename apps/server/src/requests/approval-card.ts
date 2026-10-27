import { REQUEST_STATUSES, REQUEST_TYPES } from '@eat/shared';

/**
 * 飞书自建应用渠道的审批卡片（决策 92，卡片 JSON 2.0）。
 * 与 Webhook 渠道的区别：同意 / 驳回是卡片回调而不是网页链接；卡片记在 feishu_card 里，
 * 申请状态无论在哪里变化（卡片、网页、撤回、失效）都会被回写成最新样子。
 * 文本一律用 plain_text：申请原因等是用户输入，不能让它被当成 Markdown 渲染出链接。
 */
export interface ApprovalCardRow {
  id: string;
  type: string;
  status: string;
  execution: string | null;
  target_name: string;
  details: Record<string, any> | null;
  reason: string | null;
  rejection_reason: string | null;
  closed_reason: string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  requester_name: string | null;
  requester_email: string | null;
  approver_name: string | null;
}

/**
 * pending = 待审批（同意 / 驳回 按钮）；rejecting = 填写驳回原因；
 * processing = 已在卡片上点了同意、开通耗时超过回调时限，完成后由同步回写；其余按申请状态展示结果
 */
export type ApprovalCardView = 'pending' | 'rejecting' | 'processing' | 'result';

/** 卡片呈现的状态键：与申请当前状态不一致时需要回写 */
export function approvalCardState(r: Pick<ApprovalCardRow, 'status' | 'execution'>): string {
  return `${r.status}:${r.execution ?? ''}`;
}

const beijing = (v: Date | string) =>
  `${new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;
const text = (content: string, extra: Record<string, unknown> = {}) => ({
  tag: 'div',
  text: { tag: 'plain_text', content, ...extra },
});
const button = (content: string, type: string, behavior: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  tag: 'button',
  text: { tag: 'plain_text', content },
  type,
  behaviors: [behavior],
  ...extra,
});
const callback = (requestId: string, action: string) => ({
  type: 'callback',
  value: { eat: 'approval', requestId, action },
});
const row = (...buttons: Record<string, unknown>[]) => ({
  tag: 'column_set',
  flex_mode: 'flow',
  horizontal_spacing: '8px',
  columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
});

export function approvalCardLines(r: ApprovalCardRow, audience: 'approver' | 'requester'): string {
  const details = r.details ?? {};
  return [
    `申请类型：${REQUEST_TYPES[r.type as keyof typeof REQUEST_TYPES] ?? r.type}`,
    `申请资源：${r.target_name}`,
    ...(Array.isArray(details.keys) ? [`申请变量：${details.keys.join('、')}`] : []),
    ...(r.type === 'app' && details.repoUrl ? [`仓库：${details.repoUrl}`, `分支：${details.branch ?? '未记录'}`] : []),
    ...(audience === 'approver' || r.status === 'pending'
      ? [`申请人：${r.requester_name ?? '已删除用户'}${r.requester_email ? `（${r.requester_email}）` : ''}`]
      : []),
    `申请时间：${beijing(r.created_at)}`,
    `申请原因：${r.reason || '未填写'}`,
    ...(r.status !== 'pending' && r.approver_name ? [`审批人：${r.approver_name}`] : []),
    ...(r.status !== 'pending' && r.decided_at ? [`处理时间：${beijing(r.decided_at)}`] : []),
    ...(r.rejection_reason ? [`驳回原因：${r.rejection_reason}`] : []),
    ...(r.closed_reason && r.status !== 'rejected' ? [`说明：${r.closed_reason}`] : []),
    ...(r.status === 'approved' && r.execution === 'provisioning' ? ['审批已通过，资源正在开通。'] : []),
    ...(r.status === 'approved' && r.execution === 'failed' ? ['资源开通失败，请在详情查看处理进度。'] : []),
  ].join('\n');
}

const RESULT_TEMPLATE: Record<string, string> = { approved: 'green', rejected: 'red' };

export function buildApprovalCard(
  r: ApprovalCardRow,
  opts: { view: ApprovalCardView; detailUrl: string; audience?: 'approver' | 'requester'; notice?: string },
): Record<string, unknown> {
  const audience = opts.audience ?? 'approver';
  const view = r.status === 'pending' ? (opts.view === 'result' ? 'pending' : opts.view) : 'result';
  const [template, title] =
    view === 'processing'
      ? ['wathet', '正在处理']
      : view === 'result'
      ? r.status === 'approved' && r.execution === 'provisioning'
        ? ['wathet', '已批准 · 正在开通']
        : [RESULT_TEMPLATE[r.status] ?? 'grey', REQUEST_STATUSES[r.status as keyof typeof REQUEST_STATUSES] ?? r.status]
      : ['blue', view === 'rejecting' ? '驳回申请' : '待审批提醒'];
  const detail = button('查看详情', 'default', { type: 'open_url', default_url: opts.detailUrl });
  const elements: Record<string, unknown>[] = [text(approvalCardLines(r, audience))];
  if (view === 'pending' && audience === 'approver') {
    if (r.type === 'env') {
      elements.push(
        text('同意将授权本次申请的全部变量，不设置到期时间；需要限制有效期请查看详情。', {
          text_size: 'notation',
          text_color: 'grey',
        }),
      );
    }
    elements.push(
      row(
        button('同意', 'primary_filled', callback(r.id, 'approve')),
        button('驳回', 'danger', callback(r.id, 'reject_start')),
        detail,
      ),
    );
  } else if (view === 'rejecting') {
    elements.push({
      tag: 'form',
      name: 'reject_form',
      elements: [
        {
          tag: 'input',
          name: 'reason',
          required: true,
          max_length: 500,
          placeholder: { tag: 'plain_text', content: '驳回原因（必填，申请人会看到）' },
        },
        row(
          button('确认驳回', 'danger_filled', callback(r.id, 'reject'), {
            name: 'reject_submit',
            form_action_type: 'submit',
          }),
        ),
      ],
    });
    elements.push(row(button('返回', 'default', callback(r.id, 'reject_cancel')), detail));
  } else {
    elements.push(row(detail));
  }
  if (opts.notice) elements.push(text(opts.notice, { text_size: 'notation', text_color: 'grey' }));
  elements.push(text('EAT 平台通知', { text_size: 'notation', text_color: 'grey' }));
  const heading = audience === 'requester' && view === 'result' ? `你的申请${title}` : `EAT ${title}`;
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `${heading}：${r.target_name}` } },
    header: { template, title: { tag: 'plain_text', content: heading } },
    body: { elements },
  };
}
