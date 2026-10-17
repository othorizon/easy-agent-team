import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import OSS from 'ali-oss';
import { createHash, randomUUID } from 'node:crypto';
import type { SiteManifestFile } from '@eat/shared';
import { SiteSettingsStore, type SiteSettingRow } from './site-settings.store';

@Injectable()
export class SiteStorage {
  private cached?: { key: string; client: OSS };
  constructor(private readonly settings: SiteSettingsStore) {}
  client(row: SiteSettingRow): OSS {
    const key = [row.ossBucket, row.ossRegion, row.ossAccessKeyIdEncrypted, row.ossAccessKeySecretEncrypted].join(':');
    if (this.cached?.key === key) return this.cached.client;
    const { ossAccessKeyId: accessKeyId, ossAccessKeySecret: accessKeySecret } = this.settings.secrets(row);
    if (!accessKeyId || !accessKeySecret) throw new ServiceUnavailableException('OSS Folio 存储尚未配置完整');
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
  /** Never propagate SDK errors: they may contain signed URLs, credentials or headers. */
  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (e) {
      if (e instanceof HttpException) throw e;
      throw new ServiceUnavailableException('OSS 操作失败，请重试或续签上传会话');
    }
  }
  stagingKey(siteId: string, sessionId: string, hash: string) {
    return `sites/${siteId}/staging/${sessionId}/${hash}`;
  }
  blobKey(siteId: string, hash: string) { return `sites/${siteId}/blobs/${hash}`; }
  async signUpload(siteId: string, sessionId: string, hash: string, seconds: number) {
    return this.safe(async () => {
      const headers = { 'Content-Type': 'application/octet-stream' };
      const url = await this.client(await this.settings.enabled()).signatureUrlV4(
        'PUT', seconds, { headers }, this.stagingKey(siteId, sessionId, hash),
      );
      return { url, headers };
    });
  }
  async hasBlob(siteId: string, hash: string, size: number) {
    return this.safe(async () => {
      try {
        const result = await this.client(await this.settings.enabled()).head(this.blobKey(siteId, hash));
        return Number((result.res.headers as Record<string, string>)['content-length']) === size;
      } catch (e) {
        if ((e as { status?: number }).status === 404) return false;
        throw e;
      }
    });
  }
  async putStaging(siteId: string, sessionId: string, hash: string, bytes: Buffer) {
    return this.safe(async () => {
      await this.client(await this.settings.enabled()).put(this.stagingKey(siteId, sessionId, hash), bytes,
        { headers: { 'Content-Type': 'application/octet-stream' } });
    });
  }
  private async verifyObject(client: OSS, key: string, file: Pick<SiteManifestFile, 'hash' | 'size'>) {
    const result = await client.getStream(key);
    const stream = result.stream;
    let size = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > file.size) throw new BadRequestException('上传对象大小不符，请重新上传');
        hash.update(chunk);
      }
      if (size !== file.size || hash.digest('hex') !== file.hash)
        throw new BadRequestException('上传对象大小或 SHA-256 不符，请重新上传');
    } finally { stream.destroy(); }
  }
  async verifyAndSeal(siteId: string, sessionId: string, file: Pick<SiteManifestFile, 'hash' | 'size'>) {
    return this.safe(async () => {
      const client = this.client(await this.settings.enabled());
      // CopyObject atomically snapshots one source object. This random destination is never signed.
      // We hash the snapshot, NOT staging followed by a copy of mutable staging.
      const snapshot = `sites/${siteId}/snapshots/${randomUUID()}`;
      try {
        try {
          await client.copy(snapshot, this.stagingKey(siteId, sessionId, file.hash), {
            headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-metadata-directive': 'REPLACE',
              'Content-Type': 'application/octet-stream' },
          });
        } catch (e) {
          if ((e as { status?: number }).status === 404)
            throw new BadRequestException('缺少上传对象，请上传后重试完成');
          throw e;
        }
        await this.verifyObject(client, snapshot, file);
        try {
          await client.copy(this.blobKey(siteId, file.hash), snapshot, {
            headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-metadata-directive': 'REPLACE',
              'Content-Type': 'application/octet-stream' },
          });
        } catch (e) {
          if ((e as { code?: string }).code !== 'FileAlreadyExists') throw e;
          // A concurrent publisher may have sealed it first. Also reject pre-existing corrupt objects.
          await this.verifyObject(client, this.blobKey(siteId, file.hash), file);
        }
      } finally { await client.delete(snapshot).catch(() => undefined); }
    });
  }
  async getBlob(siteId: string, hash: string) {
    return this.safe(async () => (await this.client(await this.settings.enabled()).get(this.blobKey(siteId, hash))).content as Buffer);
  }
  async discardSite(siteId: string) {
    return this.safe(async () => {
      const client = this.client(await this.settings.required());
      // Restart listing after each deletion; no continuation token can skip objects during a sweep.
      let previous = '';
      for (let batch = 0; ; batch++) {
        const result = await client.list({ prefix: `sites/${siteId}/`, 'max-keys': 1000 }, {});
        const keys = (result.objects ?? []).map((o) => o.name);
        if (!keys.length) break;
        const marker = keys.join('\n');
        if (marker === previous || batch >= 100) throw new Error('cleanup pending');
        previous = marker;
        const deleted = await client.deleteMulti(keys, { quiet: true });
        if (deleted.res.status >= 300) throw new Error('delete failed');
      }
    });
  }
}
