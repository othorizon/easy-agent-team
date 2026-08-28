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
}

/** 卡片里描述/回复的最大展示字数，超出截断加省略号 */
export const HELP_CARD_EXCERPT_LIMIT = 100;

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
  const isRequest = input.kind === 'request';
  const excerptLabel = isRequest ? '描述' : '回复';
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
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看请求' },
            type: 'primary',
            url: input.url,
          },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `**发送给 Agent**（复制发给你的 Agent，它即可接手）\n\`\`\`text\n${helpAgentPrompt(input.kind, input.requestId, input.title)}\n\`\`\``,
      },
    ],
  };
}
