import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OSS from 'ali-oss';
import { setTimeout as delay } from 'node:timers/promises';
import StsClient from '@alicloud/sts20150401';
import RamClient, * as Ram from '@alicloud/ram20150501';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { canonical, type OssPolicy } from './oss-policy';

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
export const cloudMissing = (e: unknown) =>
  e instanceof OssCloudError && /^(NoSuch|EntityNotExist)/.test(e.code);
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
  private async ram(c: OssConnection, action: string, args: Raw): Promise<Raw> {
    const client = new RamClient(
      new $OpenApiUtil.Config({
        accessKeyId: c.accessKeyId,
        accessKeySecret: c.accessKeySecret,
        endpoint: 'ram.aliyuncs.com',
        protocol: 'https',
        connectTimeout: 10_000,
        readTimeout: 20_000,
      }),
    );
    const models = Ram as unknown as Record<string, new (v: Raw) => unknown>;
    const method = action[0].toLowerCase() + action.slice(1);
    return this.safe(`RAM ${action}`, async () => {
      const result = await (
        client as unknown as Record<
          string,
          (v: unknown) => Promise<{ body: Raw }>
        >
      )[method](new models[`${action}Request`](args));
      return result.body;
    });
  }
  async callerAccount(c: OssConnection): Promise<string> {
    return this.safe('STS GetCallerIdentity', async () => {
      const client = new StsClient(
        new $OpenApiUtil.Config({
          accessKeyId: c.accessKeyId,
          accessKeySecret: c.accessKeySecret,
          endpoint: 'sts.aliyuncs.com',
          protocol: 'https',
          connectTimeout: 10_000,
          readTimeout: 20_000,
        }),
      );
      const result = await client.getCallerIdentity();
      if (!result.body?.accountId)
        throw new OssCloudError('STS GetCallerIdentity', 'MissingAccountId');
      return result.body.accountId;
    });
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
  async ensureUser(c: OssConnection, userName: string, marker: string) {
    let user: Raw;
    try {
      user = (await this.ram(c, 'GetUser', { userName })).user;
    } catch (e) {
      if (!cloudMissing(e)) throw e;
      user = (
        await this.ram(c, 'CreateUser', {
          userName,
          comments: marker,
          displayName: userName,
        })
      ).user;
    }
    if (user.comments !== marker)
      throw new Error('RAM 用户归属不匹配，拒绝接管已有用户');
  }
  async applyUserPolicy(
    c: OssConnection,
    userName: string,
    policyName: string,
    marker: string,
    policy: OssPolicy,
  ) {
    let found: Raw | null = null;
    try {
      found = await this.ram(c, 'GetPolicy', {
        policyType: 'Custom',
        policyName,
      });
    } catch (e) {
      if (!cloudMissing(e)) throw e;
    }
    if (!found)
      await this.ram(c, 'CreatePolicy', {
        policyName,
        description: marker,
        policyDocument: JSON.stringify(policy),
      });
    else {
      if (found.policy.description !== marker)
        throw new Error('RAM 策略归属不匹配，拒绝覆盖已有策略');
      const document = found.defaultPolicyVersion.policyDocument;
      let old: unknown;
      try {
        old = JSON.parse(document);
      } catch {
        old = JSON.parse(decodeURIComponent(document));
      }
      if (canonical(old) !== canonical(policy))
        await this.ram(c, 'CreatePolicyVersion', {
          policyName,
          policyDocument: JSON.stringify(policy),
          setAsDefault: true,
          rotateStrategy: 'DeleteOldestNonDefaultVersionWhenLimitExceeded',
        });
    }
    const attached = await this.ram(c, 'ListPoliciesForUser', { userName });
    if (
      !(attached.policies?.policy ?? []).some(
        (p: Raw) => p.policyName === policyName && p.policyType === 'Custom',
      )
    )
      await this.ram(c, 'AttachPolicyToUser', {
        userName,
        policyName,
        policyType: 'Custom',
      });
  }
  async keys(
    c: OssConnection,
    userName: string,
  ): Promise<{ id: string; status: string }[]> {
    const r = await this.ram(c, 'ListAccessKeys', { userName });
    return (r.accessKeys?.accessKey ?? []).map((k: Raw) => ({
      id: String(k.accessKeyId),
      status: String(k.status),
    }));
  }
  /** OSS V4 may take time to recognize a just-created RAM key. Allow initial propagation before probing it. */
  async waitForNewKey() {
    await delay(45_000);
  }
  async createKey(
    c: OssConnection,
    userName: string,
  ): Promise<{ id: string; secret: string }> {
    const r = await this.ram(c, 'CreateAccessKey', { userName });
    return { id: r.accessKey.accessKeyId, secret: r.accessKey.accessKeySecret };
  }
  async keyStatus(
    c: OssConnection,
    userName: string,
    userAccessKeyId: string,
    active: boolean,
  ) {
    await this.ram(c, 'UpdateAccessKey', {
      userName,
      userAccessKeyId,
      status: active ? 'Active' : 'Inactive',
    });
  }
  async deleteKey(c: OssConnection, userName: string, userAccessKeyId: string) {
    try {
      await this.ram(c, 'DeleteAccessKey', { userName, userAccessKeyId });
    } catch (e) {
      if (!cloudMissing(e)) throw e;
    }
  }
  /** Only called for a persisted, uniquely named probe user with a matching marker. */
  async deleteProbeUser(
    c: OssConnection,
    userName: string,
    policyName: string,
    marker: string,
  ) {
    try {
      const r = await this.ram(c, 'GetUser', { userName });
      if (r.user.comments !== marker) throw new Error('测试用户归属不匹配');
      for (const k of await this.keys(c, userName))
        await this.deleteKey(c, userName, k.id);
      const r2 = await this.ram(c, 'ListPoliciesForUser', { userName });
      if (
        (r2.policies?.policy ?? []).some(
          (p: Raw) => p.policyName === policyName,
        )
      )
        await this.ram(c, 'DetachPolicyFromUser', {
          userName,
          policyName,
          policyType: 'Custom',
        });
      await this.ram(c, 'DeleteUser', { userName });
    } catch (e) {
      if (!cloudMissing(e)) throw e;
    }
    try {
      const p = await this.ram(c, 'GetPolicy', {
        policyType: 'Custom',
        policyName,
      });
      if (p.policy.description !== marker)
        throw new Error('测试策略归属不匹配');
      const versions = await this.ram(c, 'ListPolicyVersions', {
        policyType: 'Custom',
        policyName,
      });
      for (const v of versions.policyVersions?.policyVersion ?? [])
        if (!v.isDefaultVersion)
          await this.ram(c, 'DeletePolicyVersion', {
            policyName,
            versionId: v.versionId,
          });
      await this.ram(c, 'DeletePolicy', { policyName });
    } catch (e) {
      if (!cloudMissing(e)) throw e;
    }
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
