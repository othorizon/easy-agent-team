import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const oss = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), deleteMulti: vi.fn(), options: vi.fn() }));
vi.mock('ali-oss', () => ({
  default: class {
    constructor(options: unknown) {
      oss.options(options);
    }
    put = oss.put;
    get = oss.get;
    deleteMulti = oss.deleteMulti;
  },
}));
import { SiteStorage } from '../src/sites/site-storage.service';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
describe('静态产物存储', () => {
  it('本地文件不可覆盖，读历史版本使用记录中的存储类型', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eat-site-storage-'));
    dirs.push(dir);
    vi.stubEnv('EAT_SITES_LOCAL_DIR', dir);
    vi.stubEnv('EAT_SITES_STORAGE', 'local');
    const storage = new SiteStorage();
    await storage.put('site', 'version', 'index.html', Buffer.from('original'), 'text/html');
    await expect(storage.put('site', 'version', 'index.html', Buffer.from('overwrite'), 'text/html')).rejects.toThrow();
    vi.stubEnv('EAT_SITES_STORAGE', 'oss');
    expect((await storage.get('local', 'site', 'version', 'index.html')).toString()).toBe('original');
    await storage.discard('local', 'site', 'version', ['index.html']);
    expect(await readdir(join(dir, 'sites', 'site'))).toEqual([]);
  });
  it('OSS 写入固定站点/版本前缀与私有 ACL，读取不返回源站地址', async () => {
    vi.stubEnv('EAT_SITES_STORAGE', 'oss');
    vi.stubEnv('EAT_SITES_OSS_BUCKET', 'test-bucket');
    vi.stubEnv('EAT_SITES_OSS_REGION', 'oss-cn-hangzhou');
    vi.stubEnv('EAT_SITES_OSS_ACCESS_KEY_ID', 'test-key');
    vi.stubEnv('EAT_SITES_OSS_ACCESS_KEY_SECRET', 'test-secret');
    oss.get.mockResolvedValue({ content: Buffer.from('saved') });
    const storage = new SiteStorage();
    await storage.put('site', 'version', 'assets/a.js', Buffer.from('saved'), 'text/javascript');
    expect(oss.put).toHaveBeenCalledWith('sites/site/version/assets/a.js', Buffer.from('saved'), {
      headers: { 'Content-Type': 'text/javascript', 'x-oss-object-acl': 'private' },
    });
    expect((await storage.get('oss', 'site', 'version', 'assets/a.js')).toString()).toBe('saved');
    await storage.discard('oss', 'site', 'version', ['assets/a.js']);
    expect(oss.deleteMulti).toHaveBeenCalledWith(['sites/site/version/assets/a.js'], { quiet: true });
  });
  it('OSS 配置不完整时明确失败，不静默写入本地', async () => {
    vi.stubEnv('EAT_SITES_STORAGE', 'oss');
    vi.stubEnv('EAT_SITES_OSS_BUCKET', '');
    await expect(new SiteStorage().put('site', 'version', 'index.html', Buffer.from('x'), 'text/html')).rejects.toThrow(
      '尚未配置完整',
    );
    expect(oss.put).not.toHaveBeenCalled();
  });
});
