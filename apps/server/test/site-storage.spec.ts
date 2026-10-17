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
    settings.enabled.mockRejectedValue(new Error('页面已停用'));
    const storage = new SiteStorage(settings as unknown as SiteSettingsStore);
    await expect(storage.put('site', 'version', 'index.html', Buffer.from('x'), 'text/html')).rejects.toThrow('已停用');
    await expect(storage.get('oss', 'site', 'version', 'index.html')).rejects.toThrow('已停用');
    await storage.discard('oss', 'site', 'version', ['index.html']);
    expect(oss.put).not.toHaveBeenCalled();
    expect(oss.get).not.toHaveBeenCalled();
    expect(oss.deleteMulti).toHaveBeenCalled();
  });
});

describe('实际 SiteStorage 的流式验证与不可变封存', () => {
  it('冻结快照后验证，再禁止覆盖封存；临时对象被改写也不影响最终字节', async () => {
    const { Readable } = await import('node:stream');
    const { createHash } = await import('node:crypto');
    const bytes = Buffer.from('verified binary');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const objects = new Map([['sites/folio/staging/session/' + hash, bytes]]);
    const copied: { destination: string; source: string; headers: Record<string, string> }[] = [];
    const client = {
      copy: async (destination: string, source: string, options: { headers: Record<string, string> }) => {
        copied.push({ destination, source, headers: options.headers });
        if (objects.has(destination)) throw { code: 'FileAlreadyExists' };
        objects.set(destination, Buffer.from(objects.get(source)!));
        if (destination.includes('/snapshots/')) objects.set(source, Buffer.from('rewrite staging'));
      },
      getStream: async (key: string) => ({ stream: Readable.from([objects.get(key)!]) }),
      delete: async (key: string) => { objects.delete(key); },
    };
    const storage = new SiteStorage(settings as unknown as SiteSettingsStore);
    vi.spyOn(storage, 'client').mockReturnValue(client as never);
    await storage.verifyAndSeal('folio', 'session', { hash, size: bytes.length });
    expect(objects.get('sites/folio/blobs/' + hash)).toEqual(bytes);
    expect(copied[1].source).toBe(copied[0].destination);
    expect(copied.every((c) => c.headers['x-oss-forbid-overwrite'] === 'true')).toBe(true);
    expect([...objects.keys()].some((key) => key.includes('/snapshots/'))).toBe(false);
    // Concurrent sealing accepts only an existing object that really hashes correctly.
    objects.set('sites/folio/staging/session/' + hash, bytes);
    await storage.verifyAndSeal('folio', 'session', { hash, size: bytes.length });
    objects.set('sites/folio/blobs/' + hash, Buffer.from('corruption'));
    objects.set('sites/folio/staging/session/' + hash, bytes);
    await expect(storage.verifyAndSeal('folio', 'session', { hash, size: bytes.length })).rejects.toThrow('大小');
  });
  it('签名仅限 staging，SDK 故障不向错误或日志传播 URL/密钥', async () => {
    const client = { signatureUrlV4: vi.fn().mockResolvedValue('https://oss.test/signed'),
      head: vi.fn().mockRejectedValue(new Error('https://oss.test/?secret=credential')) };
    const storage = new SiteStorage(settings as unknown as SiteSettingsStore);
    vi.spyOn(storage, 'client').mockReturnValue(client as never);
    expect(await storage.signUpload('folio', 'session', 'a'.repeat(64), 600)).toEqual({ url: 'https://oss.test/signed', headers: { 'Content-Type': 'application/octet-stream' } });
    expect(client.signatureUrlV4).toHaveBeenCalledWith('PUT', 600,
      { headers: { 'Content-Type': 'application/octet-stream' } }, 'sites/folio/staging/session/' + 'a'.repeat(64));
    await expect(storage.hasBlob('folio', 'a'.repeat(64), 1)).rejects.toThrow('OSS 操作失败');
    await expect(storage.hasBlob('folio', 'a'.repeat(64), 1)).rejects.not.toThrow('credential');
  });
});
