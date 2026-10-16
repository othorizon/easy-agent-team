import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { SiteStorage } from '../src/sites/site-storage.service';
import { SiteSettingsStore } from '../src/sites/site-settings.store';

/** 本地文件仅作测试替身，生产配置始终使用私有 OSS。 */
export class TestSiteStorage extends SiteStorage {
  constructor(
    settings: SiteSettingsStore,
    private readonly root: string,
  ) {
    super(settings);
  }
  override kind(): 'local' {
    return 'local';
  }
  override async put(site: string, version: string, path: string, content: Buffer, _type: string) {
    const file = join(this.root, site, version, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: 'wx' });
  }
  override async get(_storage: 'local' | 'oss', site: string, version: string, path: string) {
    return readFile(join(this.root, site, version, path));
  }
  override async discard(_storage: 'local' | 'oss', site: string, version: string, _paths: string[]) {
    await rm(join(this.root, site, version), { recursive: true, force: true });
  }
}
