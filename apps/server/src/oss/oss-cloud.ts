import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OSS from 'ali-oss';
import { setTimeout as delay } from 'node:timers/promises';
import type { OssPolicy } from './oss-policy';

export interface OssConnection {
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
}
export class OssCloudError extends ServiceUnavailableException {
  constructor(
    readonly action: string,
    readonly code: string,
  ) {
    super(`${action} 失败（${code}），请检查阿里云权限、配额及配置`);
  }
}
type Raw = Record<string, any>; // Provider boundary only; do not return raw responses or exceptions to clients.

@Injectable()
export class OssCloud {
  client(c: OssConnection): OSS {
    return new OSS({
      bucket: c.bucket,
      region: `oss-${c.region}`,
      accessKeyId: c.accessKeyId,
      accessKeySecret: c.accessKeySecret,
      secure: true,
      authorizationV4: true,
      timeout: 20_000,
    });
  }
  private async safe<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof OssCloudError) throw e;
      const raw = e as { code?: string; status?: number };
      const code = String(raw.code ?? raw.status ?? 'NETWORK_ERROR')
        .replace(/[^a-zA-Z0-9._-]/g, '')
        .slice(0, 100);
      throw new OssCloudError(action, code || 'UNKNOWN');
    }
  }
  async bucketInfo(
    c: OssConnection,
  ): Promise<{ accountId: string; acl: string; region: string }> {
    return this.safe('OSS GetBucketInfo', async () => {
      const b = (await this.client(c).getBucketInfo(c.bucket))
        .bucket as unknown as Raw;
      return {
        accountId: String(b.Owner.ID),
        acl: String(b.AccessControlList.Grant),
        region: String(b.Location).replace(/^oss-/, ''),
      };
    });
  }
  async domains(
    c: OssConnection,
  ): Promise<{ domain: string; status: string }[]> {
    return this.safe('OSS ListCname', async () => {
      const client = this.client(c) as unknown as Raw;
      const params = client._bucketRequestParams('GET', c.bucket, 'cname', {});
      params.xmlResponse = true;
      params.successStatuses = [200];
      try {
        const result = await client.request(params);
        const rows = result.data.Cname
          ? Array.isArray(result.data.Cname)
            ? result.data.Cname
            : [result.data.Cname]
          : [];
        return rows
          .filter((d: Raw) => String(d.IsWildCard) !== 'true')
          .map((d: Raw) => ({
            domain: String(d.Domain).toLowerCase(),
            status: String(d.Status),
          }));
      } catch (e) {
        if ((e as Raw).code === 'NoSuchCname') return [];
        throw e;
      }
    });
  }
  async bucketPolicy(c: OssConnection): Promise<OssPolicy | null> {
    return this.safe('OSS GetBucketPolicy', async () => {
      try {
        return (await this.client(c).getBucketPolicy(c.bucket))
          .policy as unknown as OssPolicy;
      } catch (e) {
        if ((e as Raw).code === 'NoSuchBucketPolicy') return null;
        throw e;
      }
    });
  }
  async writeBucketPolicy(c: OssConnection, policy: OssPolicy) {
    await this.safe('OSS PutBucketPolicy', async () => {
      if (policy.Statement.length)
        await this.client(c).putBucketPolicy(
          c.bucket,
          policy as unknown as OSS.BucketPolicy,
        );
      else await this.client(c).deleteBucketPolicy(c.bucket);
    });
  }
  /** OSS V4 may take time to recognize a just-created RAM key. */
  async waitForNewKey() {
    await delay(45_000);
  }
  async put(c: OssConnection, key: string, bytes: Buffer) {
    await this.safe('OSS PutObject', () => this.client(c).put(key, bytes));
  }
  async get(c: OssConnection, key: string): Promise<Buffer> {
    return this.safe(
      'OSS GetObject',
      async () => (await this.client(c).get(key)).content as Buffer,
    );
  }
  async list(c: OssConnection, prefix: string): Promise<string[]> {
    return this.safe(
      'OSS ListObjects',
      async () =>
        (
          await this.client(c).list(
            { ...(prefix ? { prefix } : {}), 'max-keys': 100 },
            {},
          )
        ).objects?.map((v) => v.name) ?? [],
    );
  }
  async remove(c: OssConnection, key: string) {
    await this.safe('OSS DeleteObject', () => this.client(c).delete(key));
  }
  /** Delete only exact probe keys, including versions and delete markers created by probe retries. */
  async cleanProbeObjects(c: OssConnection, prefix: string, keys: string[]) {
    if (!prefix.endsWith('/') || keys.some((key) => !key.startsWith(prefix)))
      throw new OssCloudError('OSS 测试版本清理', 'InvalidProbeScope');
    await this.safe('OSS 测试版本清理', async () => {
      const client = this.client(c);
      // The SDK implements this method but its community declarations omit it.
      const versionClient = client as unknown as {
        getBucketVersions(query: { prefix: string; maxKeys: number }): Promise<{
          objects: { name: string; versionId: string }[];
          deleteMarker: { name: string; versionId: string }[];
        }>;
      };
      for (let page = 0; page < 20; page++) {
        const result = await versionClient.getBucketVersions({
          prefix,
          maxKeys: 1000,
        });
        const versions = [
          ...(result.objects ?? []),
          ...(result.deleteMarker ?? []),
        ];
        if (versions.some((v) => !keys.includes(v.name)))
          throw new OssCloudError(
            'OSS 测试版本清理',
            'UnexpectedObjectInProbePrefix',
          );
        if (!versions.length) return;
        for (const v of versions)
          await client.delete(v.name, {
            versionId: v.versionId,
          } as OSS.RequestOptions & { versionId: string });
      }
      throw new OssCloudError('OSS 测试版本清理', 'CleanupIncomplete');
    });
  }
  async objectAcl(
    c: OssConnection,
    key: string,
    acl?: 'default' | 'private' | 'public-read',
  ): Promise<string> {
    return this.safe('OSS ObjectAcl', async () => {
      if (acl) await this.client(c).putACL(key, acl as OSS.ACLType); // OSS object ACL additionally supports 'default'.;
      return (await this.client(c).getACL(key)).acl;
    });
  }
  /** Recover only unfinished uploads at this exact, uniquely journaled probe key. */
  async cleanMultipartProbe(c: OssConnection, key: string) {
    await this.safe('OSS MultipartUpload 清理', async () => {
      const client = this.client(c);
      const result = await client.listUploads({
        prefix: key,
        'max-uploads': 100,
      });
      for (const upload of result.uploads ?? [])
        if (upload.name === key)
          await client.abortMultipartUpload(key, upload.uploadId);
    });
  }
  async multipartProbe(c: OssConnection, key: string) {
    await this.safe('OSS MultipartUpload', async () => {
      const client = this.client(c);
      const upload = await client.initMultipartUpload(key);
      try {
        await client.listParts(key, upload.uploadId);
      } finally {
        await client.abortMultipartUpload(key, upload.uploadId);
      }
    });
  }
  async anonymousStatus(c: OssConnection, key: string): Promise<number> {
    return this.safe('OSS 匿名读取检查', async () => {
      const response = await fetch(
        `https://${c.bucket}.oss-${c.region}.aliyuncs.com/${key.split('/').map(encodeURIComponent).join('/')}`,
        { redirect: 'error', signal: AbortSignal.timeout(20_000) },
      );
      await response.body?.cancel();
      return response.status;
    });
  }
}
