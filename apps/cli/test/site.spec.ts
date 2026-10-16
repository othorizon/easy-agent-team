import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Api } from '../src/client.js';
import { collectSiteFiles, registerSiteCommands } from '../src/commands/site.js';
import { siteToolRequest } from '@eat/shared';

const dirs: string[] = [];
function dir() {
  const d = mkdtempSync(join(tmpdir(), 'eat-site-cli-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('静态发布打包', () => {
  it('评论版本参数不会触发根命令的 --version', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'comment' });
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command().version('0.6.0').exitOverride();
    registerSiteCommands(program);
    const id = '00000000-0000-4000-8000-000000000001';
    await program.parseAsync(['node', 'eat', 'site', 'comment', 'demo', 'reply', '--version-id', id, '--thread', id]);
    expect(request).toHaveBeenCalledWith(
      'POST',
      `/api/sites/demo/threads/${id}/replies`,
      { content: 'reply', versionId: id, mentions: [] },
      {},
    );
  });
  it('目录支持二进制和嵌套文件，并排除环境配置', () => {
    const d = dir();
    writeFileSync(join(d, 'index.html'), '<body>Hello</body>');
    mkdirSync(join(d, 'assets'));
    writeFileSync(join(d, 'assets', 'image.png'), Buffer.from([0, 128, 255]));
    writeFileSync(join(d, '.env'), 'not for publishing');
    const files = collectSiteFiles(d);
    expect(files).toHaveLength(2);
    expect(Buffer.from(files.find((f) => f.path === 'assets/image.png')!.content, 'base64')).toEqual(
      Buffer.from([0, 128, 255]),
    );
  });
  it('拒绝软链接与缺少首页的目录', () => {
    const d = dir();
    expect(() => collectSiteFiles(d)).toThrow('index.html');
    writeFileSync(join(d, 'index.html'), 'index');
    symlinkSync(join(d, 'index.html'), join(d, 'link.html'));
    expect(() => collectSiteFiles(d)).toThrow('软链接');
  });
  it('ZIP 支持静态文件，拒绝目录穿越', () => {
    const d = dir(),
      file = join(d, 'site.zip');
    writeFileSync(file, zipSync({ 'index.html': strToU8('<h1>Hi</h1>'), 'a.js': strToU8('hi') }));
    expect(collectSiteFiles(file)).toHaveLength(2);
    writeFileSync(file, zipSync({ 'index.html': strToU8('hi'), '../bad': strToU8('bad') }));
    expect(() => collectSiteFiles(file)).toThrow();
  });
  it('CLI 与 stdio MCP 共用版本、评论和访问凭据映射', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const req = siteToolRequest('reply_site_comment', {
      site: 'demo',
      threadId: id,
      versionId: id,
      content: 'reply',
      accessToken: 'proof',
    });
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/sites/demo/threads/' + id + '/replies');
    expect(req.headers).toEqual({ 'x-eat-site-access': 'proof' });
    expect(req.body).toMatchObject({ versionId: id, content: 'reply' });
    expect(() => siteToolRequest('create_site', { slug: 'demo', name: 'Demo', access: 'password' })).toThrow();
  });
});
