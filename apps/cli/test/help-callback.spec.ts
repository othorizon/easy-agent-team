import { afterEach, expect, it, vi } from 'vitest';
import { buildEatTools } from '@eat/shared';
import { Api } from '../src/client.js';
import { askCreate } from '../src/commands/ask.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startMcpServer } from '../src/mcp.js';

const transportState = vi.hoisted(() => ({ server: null as unknown }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class { constructor() { return transportState.server; } },
}));

afterEach(() => vi.restoreAllMocks());

it('CLI 创建求助原样传递回调模板，保持占位符供收到回复时替换', async () => {
  const request = vi.fn().mockResolvedValue({ id: 'request', helperName: '同事' });
  vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const replyCallbackUrl = 'codex://new?prompt={message}&path=%2Fwork';
  await askCreate({ title: '问题', description: '背景', tried: '查文档', to: 'helper', replyCallbackUrl });
  expect(request).toHaveBeenCalledWith('POST', '/api/help-requests', expect.objectContaining({ replyCallbackUrl }));
  await askCreate({ title: '问题', description: '背景', tried: '查文档', skill: 'guide' });
  expect(request.mock.calls.at(-1)![2].replyCallbackUrl).toBeUndefined();
});

it('两种 MCP 接入公开相同的可选回调参数', () => {
  for (const mode of ['local', 'remote'] as const) {
    const tool = buildEatTools(mode).find((t) => t.name === 'create_help_request')!;
    expect(tool.inputSchema.properties.replyCallbackUrl).toMatchObject({ type: 'string' });
    expect(tool.inputSchema.required).not.toContain('replyCallbackUrl');
  }
});

it('本地 MCP 的 tools/call 将回调模板传递给创建 API', async () => {
  const request = vi.fn().mockResolvedValue({ id: 'created' });
  vi.spyOn(Api, 'fromSaved').mockReturnValue({ request, serverUrl: 'http://test.invalid' } as unknown as Api);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transportState.server = serverTransport;
  const client = new Client({ name: 'callback-test', version: '1' });
  try {
    await startMcpServer();
    await client.connect(clientTransport);
    const args = { title: '问题', description: '背景', tried: '查文档', helperUserId: 'helper',
      replyCallbackUrl: 'codex://new?prompt=%7Bmessage%7D' };
    const result = await client.callTool({ name: 'create_help_request', arguments: args });
    expect(result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledWith('POST', '/api/help-requests', expect.objectContaining(args));
  } finally {
    await client.close();
    await serverTransport.close();
  }
});
