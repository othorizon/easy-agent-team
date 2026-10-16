import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { SiteSettingsStore } from '../src/sites/site-settings.store';
const row = { ossBucket: 'test-bucket', ossRegion: 'oss-cn-hangzhou' };
const settings = {
  enabled: vi.fn().mockResolvedValue(row),
  required: vi.fn().mockResolvedValue(row),
  secrets: () => ({ ossAccessKeyId: 'test-key', ossAccessKeySecret: 'test-secret' }),
};
afterEach(() => {
  vi.clearAllMocks();
  settings.enabled.mockResolvedValue(row);
});
describe('静态产物存储', () => {
  it('OSS 从系统配置读取凭证，写入版本前缀与私有 ACL，不返回源站地址', async () => {
    oss.get.mockResolvedValue({ content: Buffer.from('saved') });
    const storage = new SiteStorage(settings as unknown as SiteSettingsStore);
    await storage.put('site', 'version', 'assets/a.js', Buffer.from('saved'), 'text/javascript');
    expect(oss.options).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'test-bucket',
        region: 'oss-cn-hangzhou',
        accessKeyId: 'test-key',
        accessKeySecret: 'test-secret',
        secure: true,
      }),
    );
    expect(oss.put).toHaveBeenCalledWith('sites/site/version/assets/a.js', Buffer.from('saved'), {
      headers: { 'Content-Type': 'text/javascript', 'x-oss-object-acl': 'private' },
    });
    expect((await storage.get('oss', 'site', 'version', 'assets/a.js')).toString()).toBe('saved');
    await storage.discard('oss', 'site', 'version', ['assets/a.js']);
    expect(oss.deleteMulti).toHaveBeenCalledWith(['sites/site/version/assets/a.js'], { quiet: true });
  });
  it('停用后拒绝写入和读取 OSS，仍可清理未完成的发布', async () => {
    settings.enabled.mockRejectedValue(new Error('静态网站已停用'));
    const storage = new SiteStorage(settings as unknown as SiteSettingsStore);
    await expect(storage.put('site', 'version', 'index.html', Buffer.from('x'), 'text/html')).rejects.toThrow('已停用');
    await expect(storage.get('oss', 'site', 'version', 'index.html')).rejects.toThrow('已停用');
    await storage.discard('oss', 'site', 'version', ['index.html']);
    expect(oss.put).not.toHaveBeenCalled();
    expect(oss.get).not.toHaveBeenCalled();
    expect(oss.deleteMulti).toHaveBeenCalled();
  });
});
