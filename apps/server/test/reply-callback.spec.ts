import { describe, expect, it } from 'vitest';
import {
  buildHelpFeishuCard, buildReplyRedirectUrl, createHelpRequestSchema, helpAgentPrompt,
  isReplyRedirectUrl, readReplyRedirectUrl, replyCallbackUrlSchema, resolveReplyCallbackUrl,
} from '@eat/shared';

describe('求助回复回调链接', () => {
  const title = '中文 `标题` & # + % "引号" 🔔';
  const message = helpAgentPrompt('reply', 'request-123', title);

  it('两层 URL 编码完整还原 Agent 文本，不改变原来的查询参数或片段', () => {
    const template = 'codex://new?prompt={message}&path=%2FUsers%2Fme%2Fa%20b#keep';
    const relay = new URL(buildReplyRedirectUrl('https://eat.example', template, message));
    expect(relay.origin + relay.pathname).toBe('https://eat.example/redirect');
    expect(relay.search).toBe('');
    const target = new URL(readReplyRedirectUrl(relay.hash)!);
    expect(target.searchParams.get('prompt')).toBe(message);
    expect(target.searchParams.get('path')).toBe('/Users/me/a b');
    expect(target.hash).toBe('#keep');
    expect(target.searchParams.size).toBe(2);
  });

  it('平台部署在子路径时，中转地址保留该路径', () => {
    const card = buildHelpFeishuCard({ kind: 'reply', requestId: 'r', title: '测试', excerpt: '回答', from: '同事',
      url: 'https://eat.example/team/help/r', replyCallbackUrl: 'codex://new?prompt={message}' }) as any;
    const returnUrl = card.elements.find((e: any) => e.tag === 'action').actions[0].url;
    expect(new URL(returnUrl).pathname).toBe('/team/redirect');
  });

  it('支持已编码占位符、多个占位符及自定义应用协议', () => {
    const template = 'cursor://task/1?text=%7bmessage%7d#copy={message}';
    const text = '中文\n&x=1#fragment + 100% $& <script> 😀';
    const result = new URL(resolveReplyCallbackUrl(template, text));
    expect(result.searchParams.get('text')).toBe(text);
    expect(decodeURIComponent(result.hash.slice('#copy='.length))).toBe(text);
    expect(replyCallbackUrlSchema.safeParse('https://agent.example/tasks/1?message={message}').success).toBe(true);
  });

  it.each([
    'codex://new?prompt=missing', '', '/relative?message={message}',
    'javascript://host/{message}', 'data://host/{message}', 'file:///tmp/{message}',
    'https://user:password@agent.example/?q={message}',
    '{message}://task/1', 'https://{message}/task', 'https://%7Bmessage%7D/task',
    'code\nx://new?prompt={message}', 'codex://new?prompt={message}\\x',
    'codex://new?prompt={message}&x=' + 'a'.repeat(4096),
  ])('拒绝不合法的模板：%s', (template) => {
    expect(replyCallbackUrlSchema.safeParse(template).success).toBe(false);
  });

  it('中转页独立校验目标，缺少/无效 URL 不导航', () => {
    for (const target of ['javascript:alert(1)', 'javascript://example/%0aalert(1)', 'data:text/html,test',
      'blob:https://eat.example/1', 'file://localhost/a', '//evil.example', 'https://user:pass@example.com', '\tcodex://new']) {
      expect(isReplyRedirectUrl(target)).toBe(false);
      expect(readReplyRedirectUrl('#' + new URLSearchParams({ url: target }))).toBeNull();
    }
    expect(readReplyRedirectUrl('')).toBeNull();
    expect(readReplyRedirectUrl('#url=%')).toBeNull();
  });

  it('创建契约允许不填参数，填了就必须通过验证', () => {
    const base = { title: '问题', description: '描述', tried: '已尝试', helperUserId: 'helper' };
    expect(createHelpRequestSchema.parse(base).replyCallbackUrl).toBeUndefined();
    expect(createHelpRequestSchema.parse({ ...base, replyCallbackUrl: 'codex://new?prompt={message}' }).replyCallbackUrl)
      .toBe('codex://new?prompt={message}');
    expect(createHelpRequestSchema.safeParse({ ...base, replyCallbackUrl: 'codex://new' }).success).toBe(false);
  });

  it('回复卡片主按钮在查看请求前，携带的文本与代码块完全一致', () => {
    const input = { kind: 'reply' as const, requestId: 'request-123', title, excerpt: '回答', from: '同事',
      url: 'https://eat.example/help/request-123', replyCallbackUrl: 'codex://new?prompt={message}' };
    const card = buildHelpFeishuCard(input) as any;
    const buttons = card.elements.find((e: any) => e.tag === 'action').actions;
    expect(buttons.map((b: any) => [b.text.content, b.type])).toEqual([
      ['回到任务处理回复', 'primary'], ['查看请求', 'default'],
    ]);
    const target = new URL(readReplyRedirectUrl(new URL(buttons[0].url).hash)!);
    const promptInCard = card.elements.at(-1).content.split('```text\n')[1].split('\n```')[0];
    expect(target.searchParams.get('prompt')).toBe(promptInCard);
    expect(promptInCard).toBe(message);
    for (const data of [{ ...input, replyCallbackUrl: undefined }, { ...input, kind: 'request' as const }]) {
      const original = buildHelpFeishuCard(data) as any;
      expect(original.elements.find((e: any) => e.tag === 'action').actions).toEqual([
        { tag: 'button', text: { tag: 'plain_text', content: '查看请求' }, type: 'primary', url: input.url },
      ]);
    }
  });
});
