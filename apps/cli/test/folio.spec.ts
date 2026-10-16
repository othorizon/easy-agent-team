import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Api } from '../src/client.js';
import { collectFolioFiles, registerFolioCommands } from '../src/commands/folio.js';
import { buildEatTools, folioToolRequest } from '@eat/shared';

const dirs: string[] = [];
function dir() {
  const d = mkdtempSync(join(tmpdir(), 'eat-folio-cli-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('静态发布打包', () => {
  it('通过 eat folio 创建并发布静态产物', async () => {
    const request = vi.fn().mockResolvedValue({ slug: 'demo' });
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const create = new Command().exitOverride();
    registerFolioCommands(create);
    await create.parseAsync(['node', 'eat', 'folio', 'create', 'demo', '--name', 'Demo']);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/sites',
      { slug: 'demo', name: 'Demo', description: '', access: 'authenticated', spa: false },
      {},
    );
    const d = dir();
    writeFileSync(join(d, 'index.html'), '<h1>Demo</h1>');
    const push = new Command().exitOverride();
    registerFolioCommands(push);
    await push.parseAsync(['node', 'eat', 'folio', 'push', 'demo', d, '-m', 'First release']);
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      '/api/sites/demo/releases',
      { files: collectFolioFiles(d), message: 'First release' },
      {},
    );
  });
  it('旧 eat site 命令直接报 unknown command', async () => {
    const request = vi.fn();
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerFolioCommands(program);
    await expect(program.parseAsync(['node', 'eat', 'site', 'list'])).rejects.toMatchObject({
      code: 'commander.unknownCommand',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['local', 'remote'] as const)('%s MCP 使用 Folio 工具名与 folio 参数', (mode) => {
    const tools = buildEatTools(mode);
    expect(tools.some((t) => /(?:^|_)sites?(?:_|$)/.test(t.name))).toBe(false);
    const publish = tools.find((t) => t.name === 'publish_folio')!;
    expect(publish.inputSchema.required).toContain('folio');
    expect(publish.inputSchema.properties).not.toHaveProperty('site');
    expect(() =>
      folioToolRequest('publish_folio', {
        site: 'demo', files: [{ path: 'index.html', content: '<h1>Demo</h1>' }],
      }),
    ).toThrow();
  });
  it('评论版本参数不会触发根命令的 --version', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'comment' });
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command().version('0.6.0').exitOverride();
    registerFolioCommands(program);
    const id = '00000000-0000-4000-8000-000000000001';
    await program.parseAsync([
      'node',
      'eat',
      'folio',
      'comment',
      'demo',
      'reply',
      '--version-id',
      id,
      '--thread',
      id,
    ]);
    expect(request).toHaveBeenCalledWith(
      'POST',
      `/api/sites/demo/threads/${id}/replies`,
      { content: 'reply', versionId: id, mentions: [] },
      {},
    );
  });
  it('删除评论命令与 MCP 使用相同的权限校验端点和访问凭据', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerFolioCommands(program);
    const id = '00000000-0000-4000-8000-000000000001';
    await program.parseAsync([
      'node',
      'eat',
      'folio',
      'delete-comment',
      'demo',
      id,
      '--access-token',
      'proof',
    ]);
    expect(request).toHaveBeenCalledWith('DELETE', '/api/sites/demo/comments/' + id, undefined, {
      'x-eat-site-access': 'proof',
    });
    expect(() => folioToolRequest('delete_folio_comment', { folio: 'demo', commentId: 'invalid' })).toThrow();
  });
  it('目录支持二进制和嵌套文件，并排除环境配置', () => {
    const d = dir();
    writeFileSync(join(d, 'index.html'), '<body>Hello</body>');
    mkdirSync(join(d, 'assets'));
    writeFileSync(join(d, 'assets', 'image.png'), Buffer.from([0, 128, 255]));
    writeFileSync(join(d, '.env'), 'not for publishing');
    const files = collectFolioFiles(d);
    expect(files).toHaveLength(2);
    expect(Buffer.from(files.find((f) => f.path === 'assets/image.png')!.content, 'base64')).toEqual(
      Buffer.from([0, 128, 255]),
    );
  });
  it('拒绝软链接与缺少首页的目录', () => {
    const d = dir();
    expect(() => collectFolioFiles(d)).toThrow('index.html');
    writeFileSync(join(d, 'index.html'), 'index');
    symlinkSync(join(d, 'index.html'), join(d, 'link.html'));
    expect(() => collectFolioFiles(d)).toThrow('软链接');
  });
  it('ZIP 支持静态文件，拒绝目录穿越', () => {
    const d = dir(),
      file = join(d, 'folio.zip');
    writeFileSync(file, zipSync({ 'index.html': strToU8('<h1>Hi</h1>'), 'a.js': strToU8('hi') }));
    expect(collectFolioFiles(file)).toHaveLength(2);
    writeFileSync(file, zipSync({ 'index.html': strToU8('hi'), '../bad': strToU8('bad') }));
    expect(() => collectFolioFiles(file)).toThrow();
  });
  it('CLI 与 stdio MCP 共用版本、评论和访问凭据映射', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const req = folioToolRequest('reply_folio_comment', {
      folio: 'demo',
      threadId: id,
      versionId: id,
      content: 'reply',
      accessToken: 'proof',
    });
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/sites/demo/threads/' + id + '/replies');
    expect(req.headers).toEqual({ 'x-eat-site-access': 'proof' });
    expect(req.body).toMatchObject({ versionId: id, content: 'reply' });
    expect(() =>
      folioToolRequest('create_folio', { slug: 'demo', name: 'Demo', access: 'password' }),
    ).toThrow();
  });
});
