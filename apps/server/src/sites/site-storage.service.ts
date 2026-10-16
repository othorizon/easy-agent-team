import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OSS from 'ali-oss';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { siteConfig } from './site-config';

@Injectable()
export class SiteStorage {
  private client?: OSS;
  private oss(): OSS {
    if (!this.client) {
      const {
        EAT_SITES_OSS_BUCKET: bucket,
        EAT_SITES_OSS_REGION: region,
        EAT_SITES_OSS_ACCESS_KEY_ID: accessKeyId,
        EAT_SITES_OSS_ACCESS_KEY_SECRET: accessKeySecret,
      } = process.env;
      if (!bucket || !region || !accessKeyId || !accessKeySecret)
        throw new ServiceUnavailableException('OSS 静态站点存储尚未配置完整');
      this.client = new OSS({ bucket, region, accessKeyId, accessKeySecret, secure: true, timeout: 30_000 });
    }
    return this.client;
  }
  kind() {
    return siteConfig().storage;
  }
  private key(siteId: string, versionId: string, path: string) {
    return `sites/${siteId}/${versionId}/${path}`;
  }
  private local(key: string) {
    const root = resolve(process.env.EAT_SITES_LOCAL_DIR ?? './data/static-sites');
    const file = resolve(root, key);
    if (!file.startsWith(`${root}/`)) throw new Error('无效存储路径');
    return file;
  }
  async put(siteId: string, versionId: string, path: string, content: Buffer, type: string) {
    const key = this.key(siteId, versionId, path);
    if (this.kind() === 'oss') {
      await this.oss().put(key, content, { headers: { 'Content-Type': type, 'x-oss-object-acl': 'private' } });
    } else {
      const file = this.local(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, { flag: 'wx' });
    }
  }
  async get(storage: 'local' | 'oss', siteId: string, versionId: string, path: string): Promise<Buffer> {
    const key = this.key(siteId, versionId, path);
    if (storage === 'local') return readFile(this.local(key));
    return (await this.oss().get(key)).content as Buffer;
  }
  async discard(storage: 'local' | 'oss', siteId: string, versionId: string, paths: string[]) {
    if (storage === 'local') await rm(this.local(this.key(siteId, versionId, '.')), { recursive: true, force: true });
    else
      for (let i = 0; i < paths.length; i += 1000)
        await this.oss().deleteMulti(
          paths.slice(i, i + 1000).map((p) => this.key(siteId, versionId, p)),
          { quiet: true },
        );
  }
}
