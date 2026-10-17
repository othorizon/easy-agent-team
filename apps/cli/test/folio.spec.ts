import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Api } from '../src/client.js';
import { collectFolioFiles, registerFolioCommands } from '../src/commands/folio.js';
import { buildEatTools, folioToolRequest, uploadFolioFiles } from '@eat/shared';

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
    expect(collectFolioFiles(d)[0]).toMatchObject({ path: 'index.html', size: 13 });
  });
  it('push 目录/ZIP 使用清单与原始 PUT，二次只上传新增内容，重试不携带平台凭据', async () => {
    const blobs = new Map<string, Buffer>();
    let puts = 0, failures = 1;
    const sessions = new Map<string, any>();
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers['content-type']).toBe('application/octet-stream');
      const hash = req.url!.slice(1);
      if (failures-- > 0) { req.resume(); res.writeHead(503).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      blobs.set(hash, bytes); puts++;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let version = 0;
    const request = vi.fn(async (method: string, path: string, data: any) => {
      if (path.endsWith('/uploads')) {
        expect(data.files.every((f: any) => !('content' in f) && !('bytes' in f))).toBe(true);
        const session = { id: randomUUID(), files: data.files, state: 'uploading', result: null,
          uploads: [...new Map(data.files.filter((f: any) => !blobs.has(f.hash)).map((f: any) => [f.hash,
            { hash: f.hash, size: f.size, url: origin + '/' + f.hash, headers: { 'Content-Type': 'application/octet-stream' } }])).values()] };
        sessions.set(session.id, session); return session;
      }
      if (path.endsWith('/complete')) {
        const session = sessions.get(path.split('/').at(-2)!);
        expect(session.files.every((f: any) => blobs.get(f.hash)?.length === f.size)).toBe(true);
        return { id: randomUUID(), number: ++version, url: 'https://v' + version + '--demo.test' };
      }
      throw new Error(method + ' ' + path);
    });
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ serverUrl: 'https://cli-binary.test', request } as unknown as Api);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = dir();
    writeFileSync(join(d, 'index.html'), '<body>one</body>');
    writeFileSync(join(d, 'logo.png'), Buffer.from([0,128,255]));
    try {
      for (const source of [d, join(d, 'release.zip')]) {
        if (source.endsWith('.zip')) writeFileSync(source, zipSync({ 'index.html': strToU8('<body>two</body>'), 'logo.png': new Uint8Array([0,128,255]) }));
        const command = new Command().exitOverride(); registerFolioCommands(command);
        await command.parseAsync(['node', 'eat', 'folio', 'push', 'demo', source, '--fresh']);
      }
      expect(puts).toBe(3);
      expect(request.mock.calls.filter((c) => c[1].endsWith('/uploads'))).toHaveLength(2);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it.each(['prepare_folio_upload', 'get_folio_upload', 'renew_folio_upload', 'complete_folio_upload'] as const)('stdio/HTTP 共享会话工具 %s', (name) => {
    for (const mode of ['local', 'remote'] as const) expect(buildEatTools(mode).some((t) => t.name === name)).toBe(true);
    const files = [{ path: 'index.html', hash: 'a'.repeat(64), size: 1, type: 'text/html' }];
    const req = folioToolRequest(name, { folio: 'demo', uploadId: randomUUID(), requestId: randomUUID(), files });
    expect(req.path).toMatch(/^\/api\/sites\/demo\/uploads/);
    expect(req.method).toBe(name === 'get_folio_upload' ? 'GET' : 'POST');
  });
  it('旧平台明确提示升级；鉴权失败及 Folio 不存在不降级或误报', async () => {
    const files = [{ path: 'index.html', bytes: new Uint8Array([1]), size: 1, hash: 'a'.repeat(64), type: 'text/html' }];
    const auth = Object.assign(new Error('没有权限'), { status: 403 });
    const denied = vi.fn().mockRejectedValue(auth);
    await expect(uploadFolioFiles(denied, 'demo', files, { requestId: randomUUID() })).rejects.toBe(auth);
    expect(denied).toHaveBeenCalledTimes(1);
    const unsupported = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Cannot POST'), { status: 404 })).mockResolvedValueOnce({ slug: 'demo' });
    await expect(uploadFolioFiles(unsupported, 'demo', files, { requestId: randomUUID() })).rejects.toThrow('升级');
    expect(unsupported).toHaveBeenCalledTimes(2);
    const absent = Object.assign(new Error('Folio 不存在'), { status: 404 });
    const missing = vi.fn().mockRejectedValue(absent);
    await expect(uploadFolioFiles(missing, 'demo', files, { requestId: randomUUID() })).rejects.toBe(absent);
    expect(missing.mock.calls.some((c) => String(c[1]).endsWith('/releases'))).toBe(false);
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
    expect(Buffer.from(files.find((f) => f.path === 'assets/image.png')!.bytes)).toEqual(
      Buffer.from([0, 128, 255]),
    );
  });
  it('删除 Folio 命令与两种 MCP 共用 DELETE 端点，不携带发布或评论参数', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, cleanupFailed: false });
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command().exitOverride();
    registerFolioCommands(program);
    await program.parseAsync(['node', 'eat', 'folio', 'delete', 'demo']);
    expect(request).toHaveBeenCalledWith('DELETE', '/api/sites/demo', undefined, {});
    for (const mode of ['local', 'remote'] as const) {
      const tool = buildEatTools(mode).find((t) => t.name === 'delete_folio')!;
      expect(tool.inputSchema.required).toEqual(['folio']);
      expect(tool.inputSchema.properties).not.toHaveProperty('commentId');
    }
    expect(folioToolRequest('delete_folio', { folio: 'demo' })).toEqual({
      method: 'DELETE', path: '/api/sites/demo', body: undefined, headers: {},
    });
    expect(() => folioToolRequest('delete_folio', { folio: '../demo' })).toThrow();
    expect(() => folioToolRequest('delete_folio', {})).toThrow();
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
