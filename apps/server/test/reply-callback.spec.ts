import { describe, expect, it } from 'vitest';
import {
  buildHelpFeishuCard, buildReplyRedirectUrl, createHelpRequestSchema, helpAgentPrompt,
  isReplyRedirectUrl, readReplyRedirectUrl, replyCallbackUrlSchema, resolveReplyCallbackUrl,
  assertHelpReplyCallbackFits, REPLY_REDIRECT_MAX_LENGTH, HELP_CARD_MAX_BYTES,
} from '@eat/shared';

describe('求助回复回调链接', () => {
  const title = '中文 `标题` & # + % "引号" 🔔';
  const message = helpAgentPrompt('reply', 'request-123', title);

  it('展开后的 URL 在中转页长度边界内可用，超过一字符直接拒绝', () => {
    const prefix = 'codex://new?prompt=';
    const text = 'a'.repeat(REPLY_REDIRECT_MAX_LENGTH - prefix.length);
    const target = resolveReplyCallbackUrl(prefix + '{message}', text);
    expect(target).toHaveLength(REPLY_REDIRECT_MAX_LENGTH);
    expect(readReplyRedirectUrl('#' + new URLSearchParams({ url: target }))).toBe(target);
    expect(() => resolveReplyCallbackUrl(prefix + '{message}', text + 'a')).toThrow(/过长/);
    expect(() => buildReplyRedirectUrl('https://eat.example', prefix + '{message}', text + 'a')).toThrow();
  });

  it.each(['{message}', '%7Bmessage%7D'])('创建时拒绝多占位符与中文长标题的组合：%s', placeholder => {
    const template = 'codex://new?' + Array.from({ length: 30 }, (_, i) => `p${i}=${placeholder}`).join('&');
    expect(replyCallbackUrlSchema.safeParse(template).success).toBe(true);
    const result = createHelpRequestSchema.safeParse({ title: '中'.repeat(200), description: '描述', tried: '已尝试',
      helperUserId: 'helper', replyCallbackUrl: template });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['replyCallbackUrl'], message: expect.stringMatching(/过长/) }),
    ]));
  });

  it('目标 URL 未超限但二次编码使卡片过大时，创建校验仍拒绝', () => {
    const template = 'codex://new?' + Array.from({ length: 8 }, (_, i) => `p${i}={message}`).join('&');
    const title = '中'.repeat(200), id = '00000000-0000-4000-8000-000000000000';
    expect(isReplyRedirectUrl(resolveReplyCallbackUrl(template, helpAgentPrompt('reply', id, title)))).toBe(true);
    expect(() => assertHelpReplyCallbackFits(template, title)).toThrow(/卡片过大/);
    expect(createHelpRequestSchema.safeParse({ title, description: '描述', tried: '已尝试', helperUserId: 'helper', replyCallbackUrl: template }).success).toBe(false);
  });

  it.each([1, 8, 30])('正常模板保留按钮；存量超限模板退回原通知（%i 个占位符）', count => {
    const input = { kind: 'reply' as const, requestId: '00000000-0000-4000-8000-000000000000', title: '中'.repeat(200),
      excerpt: '新回复', from: '回复人', url: 'https://eat.example/help/00000000-0000-4000-8000-000000000000' };
    const template = 'codex://new?' + Array.from({ length: count }, (_, i) => `p${i}={message}`).join('&');
    const card = buildHelpFeishuCard({ ...input, replyCallbackUrl: template }) as any;
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(HELP_CARD_MAX_BYTES);
    if (count === 1) {
      expect(card.elements.find((e: any) => e.tag === 'action').actions).toHaveLength(2);
    } else {
      expect(card).toEqual(buildHelpFeishuCard(input));
    }
  });

  it('无效存量模板不能令回复卡片构建抛错，编码 Unicode 与多个正常占位符仍可用', () => {
    const input = { kind: 'reply' as const, requestId: 'r', title, excerpt: '回复', from: '同事', url: 'https://eat.example/help/r' };
    expect(buildHelpFeishuCard({ ...input, replyCallbackUrl: 'javascript:alert(1)' })).toEqual(buildHelpFeishuCard(input));
    expect(createHelpRequestSchema.safeParse({ title: '😀'.repeat(100), description: '描述', tried: '已尝试', helperUserId: 'helper',
      replyCallbackUrl: 'codex://new?one={message}&two=%7Bmessage%7D' }).success).toBe(true);
  });

  it('创建预检查计入实际平台地址，并为姓名和回复摘要预留空间', () => {
    const template = 'codex://new?prompt={message}';
    expect(() => assertHelpReplyCallbackFits(template, '问题')).not.toThrow();
    expect(() => assertHelpReplyCallbackFits(template, '问题', 'https://eat.example/' + 'a'.repeat(20000))).toThrow(/卡片过大/);
  });

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
