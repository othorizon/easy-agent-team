import {
  OssCloud,
  OssCloudError,
  type OssConnection,
} from '../src/oss/oss-cloud';
import type { OssPolicy } from '../src/oss/oss-policy';
import { TestRamCloud } from './ram-fixture';

/** Deterministic cloud boundary: authorization is enforced on every object operation. */
export class TestOssCloud extends OssCloud {
  objects = new Map<string, Buffer>();
  acls = new Map<string, string>();
  policy: OssPolicy | null = null;
  lostPolicyResponse = false;
  writes: string[] = [];
  constructor(private readonly ram: TestRamCloud) {
    super();
  }
  reset() {
    this.objects.clear();
    this.acls.clear();
    this.policy = null;
    this.writes = [];
    this.lostPolicyResponse = false;
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
  override async waitForNewKey() {}
  private authorize(c: OssConnection, action: string, value: string) {
    if (this.ram.isManagement(c)) return;
    const documents = this.ram.documentsForKey(c) as OssPolicy[];
    const allowed = documents.some((p) =>
      p.Statement.some((s) => {
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
      }),
    );
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
  override async cleanProbeObjects(
    c: OssConnection,
    prefix: string,
    keys: string[],
  ) {
    for (const key of keys) {
      if (!key.startsWith(prefix)) throw new Error('Invalid scope');
      await this.remove(c, key);
    }
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
