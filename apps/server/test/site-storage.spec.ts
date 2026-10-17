import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
const oss = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), deleteMulti: vi.fn(), list: vi.fn(), options: vi.fn() }));
vi.mock('ali-oss', () => ({
  default: class {
    constructor(options: unknown) {
      oss.options(options);
    }
    put = oss.put;
    get = oss.get;
    deleteMulti = oss.deleteMulti;
    list = oss.list;
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
describe('OSS 内容存储', () => {
  it('从系统配置读取凭据，内联输入只写 staging，读取只使用 blob 哈希', async () => {
    oss.get.mockResolvedValue({ content: Buffer.from('saved') });
    const storage = new SiteStorage(settings as unknown as SiteSettingsStore);
    const hash = 'a'.repeat(64);
    await storage.putStaging('site', 'upload', hash, Buffer.from('saved'));
    expect(oss.options).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'test-bucket', region: 'oss-cn-hangzhou', accessKeyId: 'test-key',
      accessKeySecret: 'test-secret', secure: true,
    }));
    expect(oss.put).toHaveBeenCalledWith(`sites/site/staging/upload/${hash}`, Buffer.from('saved'), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect((await storage.getBlob('site', hash)).toString()).toBe('saved');
    expect(oss.get).toHaveBeenCalledWith(`sites/site/blobs/${hash}`);
  });
  it('停用后拒绝上传和读取，仍可清理已删除 Folio 的资源', async () => {
    settings.enabled.mockRejectedValue(new ServiceUnavailableException('Folio 已停用'));
    oss.list.mockResolvedValue({ objects: [] });
    const storage = new SiteStorage(settings as unknown as SiteSettingsStore);
    await expect(storage.putStaging('site', 'upload', 'a'.repeat(64), Buffer.from('x'))).rejects.toThrow('已停用');
    await expect(storage.getBlob('site', 'a'.repeat(64))).rejects.toThrow('已停用');
    await storage.discardSite('site');
    expect(oss.put).not.toHaveBeenCalled();
    expect(oss.get).not.toHaveBeenCalled();
    expect(oss.list).toHaveBeenCalledWith({ prefix: 'sites/site/', 'max-keys': 1000 }, {});
  });
  it('删除整个 Folio 按 UUID 前缀清理 blobs、staging 和快照，不影响其他 Folio', async () => {
    const keys = ['sites/site/blobs/hash', 'sites/site/staging/upload/hash', 'sites/site/snapshots/snapshot'];
    oss.list.mockResolvedValueOnce({ objects: keys.map((name) => ({ name })) }).mockResolvedValueOnce({ objects: [] });
    oss.deleteMulti.mockResolvedValue({ res: { status: 200 } });
    await new SiteStorage(settings as unknown as SiteSettingsStore).discardSite('site');
    expect(oss.deleteMulti).toHaveBeenCalledWith(keys, { quiet: true });
    expect(oss.list).toHaveBeenCalledTimes(2);
    expect(oss.list.mock.calls.every(([query]) => query.prefix === 'sites/site/')).toBe(true);
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
