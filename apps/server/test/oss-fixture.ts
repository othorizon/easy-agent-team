import {
  OssCloud,
  OssCloudError,
  type OssConnection,
} from '../src/oss/oss-cloud';
import type { OssPolicy } from '../src/oss/oss-policy';

/** Deterministic cloud boundary: authorization is enforced on every object operation. */
export class TestOssCloud extends OssCloud {
  objects = new Map<string, Buffer>();
  acls = new Map<string, string>();
  ramUsers = new Map<
    string,
    {
      marker: string;
      policy?: OssPolicy;
      keys: { id: string; secret: string; status: string }[];
    }
  >();
  policy: OssPolicy | null = null;
  keySerial = 0;
  lostKeyResponse = false;
  lostPolicyResponse = false;
  failCleanup = false;
  failKeyStatus = false;
  writes: string[] = [];
  reset() {
    this.objects.clear();
    this.acls.clear();
    this.ramUsers.clear();
    this.policy = null;
    this.keySerial = 0;
    this.writes = [];
    this.failCleanup =
      this.failKeyStatus =
      this.lostKeyResponse =
      this.lostPolicyResponse =
        false;
  }
  override async callerAccount() {
    return 'account-test';
  }
  override async bucketInfo() {
    return { accountId: 'account-test', acl: 'private', region: 'cn-beijing' };
  }
  override async domains() {
    return [
      { domain: 'assets.example.com', status: 'Enabled' },
      { domain: 'cdn.example.com', status: 'Enabled' },
    ];
  }
  override async bucketPolicy() {
    return structuredClone(this.policy);
  }
  override async writeBucketPolicy(_c: OssConnection, p: OssPolicy) {
    this.policy = p.Statement.length ? structuredClone(p) : null;
    if (this.lostPolicyResponse) {
      this.lostPolicyResponse = false;
      throw new OssCloudError('PutBucketPolicy', 'NETWORK_ERROR');
    }
  }
  override async ensureUser(_c: OssConnection, name: string, marker: string) {
    const user = this.ramUsers.get(name);
    if (user && user.marker !== marker) throw new Error('RAM 用户归属不匹配');
    if (!user) this.ramUsers.set(name, { marker, keys: [] });
  }
  override async applyUserPolicy(
    c: OssConnection,
    name: string,
    _policy: string,
    marker: string,
    p: OssPolicy,
  ) {
    await this.ensureUser(c, name, marker);
    this.ramUsers.get(name)!.policy = structuredClone(p);
  }
  override async keys(_c: OssConnection, name: string) {
    return this.ramUsers
      .get(name)!
      .keys.map((k) => ({ id: k.id, status: k.status }));
  }
  override async waitForNewKey() {}
  override async createKey(_c: OssConnection, name: string) {
    const key = {
      id: `test-key-${++this.keySerial}`,
      secret: `test-secret-${this.keySerial}`,
      status: 'Active',
    };
    this.ramUsers.get(name)!.keys.push(key);
    if (this.lostKeyResponse) {
      this.lostKeyResponse = false;
      throw new OssCloudError('CreateAccessKey', 'NETWORK_ERROR');
    }
    return key;
  }
  override async keyStatus(
    _c: OssConnection,
    name: string,
    id: string,
    active: boolean,
  ) {
    if (this.failKeyStatus)
      throw new OssCloudError('UpdateAccessKey', 'AccessDenied');
    const k = this.ramUsers.get(name)?.keys.find((k) => k.id === id);
    if (!k)
      throw new OssCloudError('UpdateAccessKey', 'EntityNotExist.AccessKey');
    k.status = active ? 'Active' : 'Inactive';
  }
  override async deleteKey(_c: OssConnection, name: string, id: string) {
    const u = this.ramUsers.get(name);
    if (u) u.keys = u.keys.filter((k) => k.id !== id);
  }
  override async deleteProbeUser(
    _c: OssConnection,
    name: string,
    _policy: string,
    marker: string,
  ) {
    if (this.failCleanup) throw new OssCloudError('DeleteUser', 'AccessDenied');
    const u = this.ramUsers.get(name);
    if (u && u.marker !== marker) throw new Error('测试用户归属不匹配');
    this.ramUsers.delete(name);
  }
  private authorize(c: OssConnection, action: string, value: string) {
    if (c.accessKeyId === 'management-test') return;
    const u = [...this.ramUsers.values()].find((u) =>
      u.keys.some(
        (k) =>
          k.id === c.accessKeyId &&
          k.secret === c.accessKeySecret &&
          k.status === 'Active',
      ),
    );
    const allowed = u?.policy?.Statement.some((s) => {
      if (s.Effect !== 'Allow' || ![s.Action].flat().includes(action))
        return false;
      const values =
        action === 'oss:ListObjects'
          ? ((s.Condition?.StringLike as Record<string, string[]>)?.[
              'oss:Prefix'
            ] ?? [])
          : [s.Resource]
              .flat()
              .map((r) => r.replace(`acs:oss:*:*:${c.bucket}/`, ''));
      return values.some(
        (p) => p.endsWith('*') && value.startsWith(p.slice(0, -1)),
      );
    });
    if (!allowed) throw new OssCloudError(action, 'AccessDenied');
  }
  override async put(c: OssConnection, key: string, data: Buffer) {
    this.authorize(c, 'oss:PutObject', key);
    this.objects.set(key, data);
    this.writes.push(key);
  }
  override async get(c: OssConnection, key: string) {
    this.authorize(c, 'oss:GetObject', key);
    const value = this.objects.get(key);
    if (!value) throw new OssCloudError('GetObject', 'NoSuchKey');
    return value;
  }
  override async list(c: OssConnection, prefix: string) {
    this.authorize(c, 'oss:ListObjects', prefix);
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  override async remove(c: OssConnection, key: string) {
    this.authorize(c, 'oss:DeleteObject', key);
    this.objects.delete(key);
    this.acls.delete(key);
  }
  override async cleanProbeObjects(c: OssConnection, prefix: string, keys: string[]) {
    for (const key of keys) { if (!key.startsWith(prefix)) throw new Error('Invalid scope'); await this.remove(c, key); }
  }
  override async objectAcl(
    c: OssConnection,
    key: string,
    acl?: 'private' | 'default' | 'public-read',
  ) {
    this.authorize(c, acl ? 'oss:PutObjectAcl' : 'oss:GetObjectAcl', key);
    if (acl) this.acls.set(key, acl);
    return this.acls.get(key) ?? 'default';
  }
  override async multipartProbe(c: OssConnection, key: string) {
    for (const a of [
      'oss:PutObject',
      'oss:ListParts',
      'oss:AbortMultipartUpload',
    ])
      this.authorize(c, a, key);
  }
  override async cleanMultipartProbe() {}
  override async anonymousStatus(_c: OssConnection, key: string) {
    const allowed =
      this.acls.get(key) === 'public-read' ||
      this.policy?.Statement.some(
        (s) =>
          s.Effect === 'Allow' &&
          [s.Principal].flat().includes('*') &&
          [s.Resource]
            .flat()
            .some((r) =>
              key.startsWith(
                r
                  .split(':')
                  .slice(5)
                  .join(':')
                  .split('/')
                  .slice(1)
                  .join('/')
                  .replace(/\*$/, ''),
              ),
            ),
      );
    return allowed ? 200 : 403;
  }
}
