/**
 * 求助通知的飞书卡片消息（msg_type=interactive，§10 决策 17）。
 *
 * server 出站通知与 scripts/test-feishu-card.mjs 测试脚本共用这份构建逻辑，
 * 保证测试看到的卡片与真实推送完全一致。
 *
 * 飞书群自定义机器人的卡片按钮只支持 URL 跳转（callback 需要应用机器人），
 * 没有「复制到剪贴板」行为，因此“复制给 Agent”落地为卡片内的代码块——
 * 飞书客户端的代码块自带复制按钮，效果等价。
 */
import { buildReplyRedirectUrl } from './reply-callback.js';

export type HelpCardKind = 'request' | 'reply';

export interface HelpFeishuCardInput {
  kind: HelpCardKind;
  requestId: string;
  title: string;
  /** request：问题描述；reply：回复内容。构建时会截断 */
  excerpt: string;
  /** 求助者 / 回复者姓名 */
  from: string;
  /** 请求详情页地址 */
  url: string;
  /** 仅发给求助发起人的回复通知携带。 */
  replyCallbackUrl?: string | null;
}

/** 卡片里描述/回复的最大展示字数，超出截断加省略号 */
export const HELP_CARD_EXCERPT_LIMIT = 100;
/** 为飞书消息封装、加签及平台落款预留空间，与通用通知保持相同的卡片预算。 */
export const HELP_CARD_MAX_BYTES = 25000;

function truncate(text: string, limit = HELP_CARD_EXCERPT_LIMIT): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/** 代码块内不能再出现 ``` 围栏，标题等插值统一去掉反引号 */
function plain(text: string): string {
  return text.replace(/`/g, "'");
}

/** 「发送给 Agent」的文本：用户整段复制发给自己的 Agent，Agent 即可通过 MCP/CLI 接手 */
export function helpAgentPrompt(kind: HelpCardKind, requestId: string, title: string): string {
  if (kind === 'request') {
    return [
      `我在 easy-agent-team 平台收到一个求助请求，请代我处理。请求 ID：${requestId}，标题：${plain(title)}。`,
      `请先用 MCP 工具 get_help_request 查看完整问题（或运行：eat ask show ${requestId}），`,
      `根据你掌握的信息用 reply_help_request 提交回复（或运行：eat ask reply ${requestId} --message "回复内容"）。`,
    ].join('');
  }
  return [
    `我在 easy-agent-team 平台发起的求助有新回复。请求 ID：${requestId}，标题：${plain(title)}。`,
    `请用 MCP 工具 get_help_request 查看最新回复（或运行：eat ask show ${requestId}），结合回复继续处理手头任务；`,
    `仍有疑问就用 reply_help_request 追问，确认解决后运行：eat ask resolve ${requestId}。`,
  ].join('');
}

/** 构建卡片 JSON（不含加签字段；timestamp/sign 由发送方按飞书规范附加） */
export function buildHelpFeishuCard(input: HelpFeishuCardInput): Record<string, unknown> {
  if (input.kind === 'reply' && input.replyCallbackUrl) {
    try { return buildCallbackCard(input); } catch {
      // 存量模板、平台地址或文本变化不能中断回复通知，退回原卡片。
    }
  }
  return buildCard(input, null);
}

function buildCallbackCard(input: HelpFeishuCardInput): Record<string, unknown> {
  const prompt = helpAgentPrompt('reply', input.requestId, input.title);
  const returnUrl = buildReplyRedirectUrl(new URL('../', input.url).toString(), input.replyCallbackUrl!, prompt);
  const card = buildCard(input, returnUrl);
  if (new TextEncoder().encode(JSON.stringify(card)).length > HELP_CARD_MAX_BYTES) {
    throw new Error('回复回调 URL 展开后导致通知卡片过大，请减少消息占位符或缩短链接');
  }
  return card;
}

/** 创建前验证未来回复卡片；UUID 长度固定，并为姓名和回复摘要预留最大 JSON 编码空间。 */
export function assertHelpReplyCallbackFits(template: string, title: string, baseUrl = 'https://eat.invalid'): void {
  const requestId = '00000000-0000-4000-8000-000000000000';
  buildCallbackCard({ kind: 'reply', requestId, title, replyCallbackUrl: template,
    url: `${baseUrl.replace(/\/$/, '')}/help/${requestId}`,
    // 每个 UTF-16 单元最多被 JSON 编码为 6 字节（例如 \u0000）。姓名上限 100，摘要另含省略号。
    from: '\u0000'.repeat(100), excerpt: '\u0000'.repeat(HELP_CARD_EXCERPT_LIMIT + 1) });
}

function buildCard(input: HelpFeishuCardInput, returnUrl: string | null): Record<string, unknown> {
  const isRequest = input.kind === 'request';
  const excerptLabel = isRequest ? '描述' : '回复';
  const agentPrompt = helpAgentPrompt(input.kind, input.requestId, input.title);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: isRequest ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: isRequest ? '🙋 新求助' : '💬 求助有新回复' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**请求 ID**：${input.requestId}`,
          `**标题**：${input.title}`,
          `**${excerptLabel}**：${truncate(input.excerpt)}`,
          `**来自**：${input.from}`,
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          ...(returnUrl ? [{
            tag: 'button',
            text: { tag: 'plain_text', content: '回到任务处理回复' },
            type: 'primary',
            url: returnUrl,
          }] : []),
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看请求' },
            type: returnUrl ? 'default' : 'primary',
            url: input.url,
          },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `**发送给 Agent**（复制发给你的 Agent，它即可接手）\n\`\`\`text\n${agentPrompt}\n\`\`\``,
      },
    ],
  };
}
