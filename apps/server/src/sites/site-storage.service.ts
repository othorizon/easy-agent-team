import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OSS from 'ali-oss';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SiteSettingsStore, type SiteSettingRow } from './site-settings.store';

@Injectable()
export class SiteStorage {
  private cached?: { key: string; client: OSS };
  constructor(private readonly settings: SiteSettingsStore) {}
  client(row: SiteSettingRow): OSS {
    const key = [row.ossBucket, row.ossRegion, row.ossAccessKeyIdEncrypted, row.ossAccessKeySecretEncrypted].join(':');
    if (this.cached?.key === key) return this.cached.client;
    const { ossAccessKeyId: accessKeyId, ossAccessKeySecret: accessKeySecret } = this.settings.secrets(row);
    if (!accessKeyId || !accessKeySecret) throw new ServiceUnavailableException('OSS 静态站点存储尚未配置完整');
    const client = new OSS({
      bucket: row.ossBucket,
      region: row.ossRegion,
      accessKeyId,
      accessKeySecret,
      secure: true,
      timeout: 30_000,
    });
    this.cached = { key, client };
    return client;
  }
  kind(): 'oss' | 'local' {
    return 'oss';
  }
  private key(siteId: string, versionId: string, path: string) {
    return `sites/${siteId}/${versionId}/${path}`;
  }
  private local(key: string) {
    const root = resolve('./data/static-sites');
    const file = resolve(root, key);
    if (!file.startsWith(`${root}/`)) throw new Error('无效存储路径');
    return file;
  }
  async put(siteId: string, versionId: string, path: string, content: Buffer, type: string) {
    await this.client(await this.settings.enabled()).put(this.key(siteId, versionId, path), content, {
      headers: { 'Content-Type': type, 'x-oss-object-acl': 'private' },
    });
  }
  async get(storage: 'local' | 'oss', siteId: string, versionId: string, path: string): Promise<Buffer> {
    const key = this.key(siteId, versionId, path);
    if (storage === 'local') return readFile(this.local(key));
    return (await this.client(await this.settings.enabled()).get(key)).content as Buffer;
  }
  async discard(storage: 'local' | 'oss', siteId: string, versionId: string, paths: string[]) {
    if (storage === 'local') await rm(this.local(this.key(siteId, versionId, '.')), { recursive: true, force: true });
    else {
      const client = this.client(await this.settings.required());
      for (let i = 0; i < paths.length; i += 1000)
        await client.deleteMulti(
          paths.slice(i, i + 1000).map((p) => this.key(siteId, versionId, p)),
          { quiet: true },
        );
    }
  }
}
