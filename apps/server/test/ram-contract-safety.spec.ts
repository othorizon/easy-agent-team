import { describe, expect, it } from 'vitest';
import { GuardedRamCloud, GuardedBucket, newManifest, runContract, runFromEnvironment, validateManifest, PrivateManifest,
  safeCode, waitForReady, type BucketClient, type ContractManifest } from '../scripts/ram-contract';
import { RamCloudError, type RamCredentials } from '../src/ram/ram-cloud';
import { TestRamCloud } from './ram-fixture';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const admin = { accessKeyId: 'fake-admin-AK', accessKeySecret: 'fake-admin-SK' };

class RpcFixture extends TestRamCloud {
  calls: string[] = [];
  loseRename = false;
  losePolicy = false;
  allowEleventh = false;
  allowThird = false;
  loseKeyAndListing = false;
  async rpc(c: RamCredentials, action: string, args: Record<string, any>) {
    this.calls.push(action);
    if (action === 'AttachPolicyToUser' && this.allowEleventh) {
      const user = this.users.get(args.userName)!;
      if (user.attached.size === 10) { user.attached.add(args.policyName); return {}; }
    }
    if (action === 'CreateAccessKey' && this.allowThird) {
      const user = this.users.get(args.userName)!;
      if (user.keys.length === 2) {
        user.keys.push({ id: 'unexpected-third-key', secret: 'never-log-this', status: 'Active' });
        return { accessKey: { accessKeyId: 'unexpected-third-key', accessKeySecret: 'never-log-this' } };
      }
    }
    const result = await super.ram(c, action, args);
    if (action === 'CreateAccessKey' && this.loseKeyAndListing) {
      this.loseKeyAndListing = false; this.failActions.set('ListAccessKeys', 'NETWORK_ERROR');
      throw new RamCloudError(action, 'NETWORK_ERROR');
    }
    if (action === 'CreatePolicy' && this.losePolicy) { this.losePolicy = false; throw new RamCloudError(action, 'NETWORK_ERROR'); }
    if (action === 'UpdateUser' && this.loseRename) { this.loseRename = false; throw new RamCloudError(action, 'NETWORK_ERROR'); }
    return result;
  }
}
function harness() {
  const m = newManifest('123456', 'cn-hangzhou');
  const rpc = new RpcFixture(); rpc.registerAccount(admin, 'account-test');
  const saved: ContractManifest[] = [];
  const persist = async () => { saved.push(structuredClone(m)); };
  const cloud = new GuardedRamCloud(admin, m, persist, rpc.rpc.bind(rpc));
  const objects = new Map<string, Buffer>();
  const versions: { name: string; versionId: string; deleteMarker?: boolean }[] = [];
  const state = { exists: false, marker: '', loseCreate: false, deleteFailed: false, getFailed: false, pages: false, rejectUndefined: false };
  const reads: string[] = [];
  const factory = (c: RamCredentials): BucketClient => ({
    async getBucketInfo() {
      if (state.getFailed) throw { code: 'AccessDenied' };
      if (!state.exists) throw { code: 'NoSuchBucket' };
      return { bucket: { Owner: { ID: m.accountId }, Location: `oss-${m.region}`, AccessControlList: { Grant: 'private' } } };
    },
    async getBucketTags() { return { tag: { 'eat-ram-contract': state.marker } }; },
    async putBucket(_name, options) {
      state.exists = true; state.marker = new URLSearchParams(options.headers['x-oss-bucket-tagging']).get('eat-ram-contract')!;
      if (state.loseCreate) throw { code: 'NETWORK_ERROR' };
    },
    async deleteBucket() { if (state.deleteFailed) throw { code: 'AccessDenied' }; state.exists = false; },
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key) {
      reads.push(c.accessKeyId);
      if (c !== admin && !rpc.documentsForKey(c).length) throw { code: 'InvalidAccessKeyId' };
      if (!objects.has(key)) throw { code: 'NoSuchKey' };
      return { content: objects.get(key)! };
    },
    async list(query) {
      if (state.rejectUndefined && Object.values(query).some(v => v === undefined)) throw { code: 'SignatureDoesNotMatch' };
      const all = [...objects.keys()];
      if (state.pages && all.length > 1) return query.marker
        ? { objects: all.slice(1).map(name => ({ name })), isTruncated: false }
        : { objects: [{ name: all[0] }], isTruncated: true, nextMarker: all[0] };
      return { objects: all.map(name => ({ name })), isTruncated: false };
    },
    async getBucketVersions(query) {
      if (state.rejectUndefined && Object.values(query).some(v => v === undefined)) throw { code: 'SignatureDoesNotMatch' };
      const start = query.keyMarker ? versions.findIndex(v => v.name === query.keyMarker && v.versionId === query.versionIdMarker) + 1 : 0;
      const page = state.pages ? versions.slice(start, start + 1) : versions.slice(start);
      const last = page.at(-1);
      return { objects: page.filter(v => !v.deleteMarker), deleteMarker: page.filter(v => v.deleteMarker),
        isTruncated: start + page.length < versions.length,
        nextKeyMarker: last?.name, nextVersionIdMarker: last?.versionId };
    },
    async delete(key, options) {
      if (options?.versionId) {
        const i = versions.findIndex(v => v.name === key && v.versionId === options.versionId);
        if (i >= 0) versions.splice(i, 1);
        if (!versions.some(v => v.name === key)) objects.delete(key);
      } else { objects.delete(key); }
    },
  });
  const bucket = new GuardedBucket(admin, m, persist, factory);
  return { m, rpc, cloud, bucket, persist, saved, objects, versions, state, reads };
}

describe('真实 RAM 契约脚本的安全边界（离线）', () => {
  it('未显式 opt-in 时不读取 profile，也不创建云客户端', async () => {
    let touched = false;
    const result = await runFromEnvironment({}, [], {
      readProfile: async () => { touched = true; throw new Error('不应读取'); },
    });
    expect(result).toEqual({ skipped: true });
    expect(touched).toBe(false);
  });

  it('默认拒绝账号扫描及同前缀非登记资源，且没有云调用', async () => {
    const m = newManifest('123456', 'cn-hangzhou');
    const calls: string[] = [];
    const cloud = new GuardedRamCloud(admin, m, async () => {}, async (_c, action) => {
      calls.push(action); return {};
    });
    await expect(cloud.listPolicies(admin)).rejects.toThrow('ActionDenied');
    await expect(cloud.getUser(admin, `${m.names.old}-other`)).rejects.toThrow('ResourceDenied');
    await expect(cloud.deleteUser(admin, 'eat-oss-existing')).rejects.toThrow('ResourceDenied');
    expect(calls).toEqual([]);
  });

  it('持久化失败时不创建用户；只凭前缀或 marker 不能覆盖稳定身份', async () => {
    const m = newManifest('123456', 'cn-hangzhou');
    const writes: string[] = [];
    const rpc = async (_c: unknown, action: string) => {
      if (action === 'GetUser') throw new RamCloudError(action, 'NoSuchUser');
      writes.push(action); return {};
    };
    const cloud = new GuardedRamCloud(admin, m, async () => { throw new Error('disk full'); }, rpc);
    await expect(cloud.createUser(admin, { name: m.names.old, comments: m.marker, displayName: m.names.old })).rejects.toThrow('disk full');
    expect(writes).toEqual([]);
    m.user.id = 'stable-original';
    const replaced = new GuardedRamCloud(admin, m, async () => {}, async () => ({
      user: { userName: m.names.old, comments: m.marker, userId: 'different-user' },
    }));
    await expect(replaced.deleteUser(admin, m.names.old)).rejects.toThrow('UserIdentityMismatch');
  });

  it('创建响应丢失可按已持久 intent 与精确 marker 恢复，目标被占用不能改名', async () => {
    const m = newManifest('123456', 'cn-hangzhou');
    let created = false;
    let renamed = false;
    const cloud = new GuardedRamCloud(admin, m, async () => {}, async (_c, action, args) => {
      if (action === 'CreateUser') { created = true; throw new RamCloudError(action, 'NETWORK_ERROR'); }
      if (action === 'UpdateUser') { renamed = true; return {}; }
      if (action === 'GetUser' && args.userName === m.names.renamed)
        return { user: { userName: m.names.renamed, comments: 'unrelated', userId: 'other' } };
      if (!created) throw new RamCloudError(action, 'NoSuchUser');
      return { user: { userName: m.names.old, comments: m.marker, userId: 'new-stable-id' } };
    });
    await expect(cloud.createUser(admin, { name: m.names.old, comments: m.marker, displayName: m.names.old })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await cloud.ownedUser(m.names.old);
    expect(m.user.id).toBe('new-stable-id');
    await expect(cloud.updateUser(admin, m.names.old, { name: m.names.renamed })).rejects.toThrow('NameOccupied');
    expect(renamed).toBe(false);
  });

  it('私有 manifest 可恢复精确资源名单，拒绝账号或名称篡改且不保存 SK', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eat-contract-test-'));
    try {
      const m = newManifest('123456', 'cn-hangzhou');
      const store = await PrivateManifest.create(dir, m);
      expect((await stat(store.path)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await PrivateManifest.load(store.path, '123456')).manifest).toEqual(m);
      await expect(PrivateManifest.load(store.path, 'other-account')).rejects.toThrow('AccountMismatch');
      const tampered = structuredClone(m); tampered.names.old = 'eat-oss-existing';
      expect(() => validateManifest(tampered, '123456')).toThrow('InvalidManifest');
      const text = await readFile(store.path, 'utf8');
      expect(text).not.toContain(admin.accessKeySecret);
      expect(safeCode({ code: admin.accessKeySecret, message: admin.accessKeySecret })).toBe('UnclassifiedError');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('全流程验证配额、旧 Key 跨改名访问和解绑后删除，并精确核零', async () => {
    const h = harness(); h.state.pages = true;
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist);
    expect(result).toMatchObject({ passed: true, code: 'OK', cleanup: { remaining: [], unknown: [], errors: [] } });
    expect(h.m.observations.map(o => [o.step, o.code])).toContainEqual(['eleventh-policy', 'LimitExceeded.Policy']);
    expect(h.m.observations.map(o => [o.step, o.code])).toContainEqual(['third-key', 'LimitExceeded.AccessKey']);
    expect(h.m.observations.map(o => [o.step, o.code])).toContainEqual(['bound-policy-delete', 'DeleteConflict.Policy']);
    expect(h.reads.filter(k => k !== admin.accessKeyId)).toEqual(['test-key-1', 'test-key-1', 'test-key-1', 'test-key-2']);
    expect(h.objects.size).toBe(0); expect(h.state.exists).toBe(false);
    expect(h.rpc.users.size).toBe(0); expect(h.rpc.policies.size).toBe(0);
    expect(h.rpc.calls).not.toContain('ListUsers'); expect(h.rpc.calls).not.toContain('ListPolicies');
    expect(JSON.stringify(h.saved)).not.toContain('test-secret-');
  });

  it.each(['user', 'rename', 'key', 'bucket', 'policy'] as const)('%s 响应丢失后仍恢复本轮归属并清零', async point => {
    const h = harness();
    if (point === 'user') h.rpc.lostUserResponse = true;
    if (point === 'rename') h.rpc.loseRename = true;
    if (point === 'key') h.rpc.lostKeyResponse = true;
    if (point === 'bucket') h.state.loseCreate = true;
    if (point === 'policy') h.rpc.losePolicy = true;
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist);
    expect(result).toMatchObject({ passed: false, code: 'NETWORK_ERROR', cleanup: { remaining: [], unknown: [], errors: [] } });
    expect(h.state.exists).toBe(false); expect(h.rpc.users.size).toBe(0); expect(h.rpc.policies.size).toBe(0);
  });

  it('缺少原子 Bucket marker 或出现未登记对象时拒绝删除，不假报清零', async () => {
    const h = harness(); await h.bucket.create();
    h.state.marker = 'different-run';
    let result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist, {}, true);
    expect(result).toMatchObject({ passed: false, cleanup: { remaining: [h.m.names.bucket] } });
    expect(h.state.exists).toBe(true);
    h.state.marker = h.m.runId;
    h.objects.set('unregistered-object', Buffer.from('preserve'));
    h.objects.set(h.m.names.objects[0], Buffer.from('preserve until all pages are checked'));
    h.state.pages = true;
    result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist, {}, true);
    expect(result.passed).toBe(false); expect(h.objects.size).toBe(2); expect(h.state.exists).toBe(true);
  });

  it('仅显式 opt-in 仍不能通过额外参数指定资源，参数失败前不读取 profile', async () => {
    let read = false;
    await expect(runFromEnvironment({ EAT_REAL_RAM_CONTRACT: '1' }, ['--user', 'eat-oss-existing'], {
      readProfile: async () => { read = true; return { credentials: admin, region: 'cn-hangzhou' }; },
    })).rejects.toThrow('InvalidArguments');
    expect(read).toBe(false);
  });

  it('完整日志与私有恢复状态均不泄露测试 AK / SK', async () => {
    const h = harness(), events: unknown[] = [];
    await runContract(admin, h.m, h.cloud, h.bucket, h.persist, { log: e => events.push(e) });
    const logs = JSON.stringify(events);
    expect(logs).not.toContain('test-key-'); expect(logs).not.toContain('test-secret-');
    expect(logs).not.toContain(admin.accessKeyId); expect(logs).not.toContain(admin.accessKeySecret);
  });

  it('显式清理能从持久 key intent 恢复中断前未知的 Key ID', async () => {
    const h = harness();
    await h.cloud.createUser(admin, { name: h.m.names.old, displayName: h.m.names.old, comments: h.m.marker });
    h.rpc.loseKeyAndListing = true;
    await expect(h.cloud.createKey(admin, h.m.names.old)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const restored = validateManifest(h.saved.at(-1), h.m.accountId);
    expect(restored.keys).toEqual([]); expect(restored.keyIntents[0].finished).toBe(false);
    h.rpc.failActions.clear();
    const persist = async () => {};
    const cloud = new GuardedRamCloud(admin, restored, persist, h.rpc.rpc.bind(h.rpc));
    const result = await runContract(admin, restored, cloud, h.bucket, persist, {}, true);
    expect(result).toMatchObject({ passed: true, cleanup: { remaining: [], unknown: [], errors: [] } });
    expect(restored.keys).toEqual(['test-key-1']); expect(h.rpc.users.size).toBe(0);
  });

  it('版本与删除标记使用双marker完整分页后按versionId清理', async () => {
    const h = harness(); await h.bucket.create(); h.state.pages = true;
    h.objects.set(h.m.names.objects[0], Buffer.from('current'));
    h.versions.push({ name: h.m.names.objects[0], versionId: 'version-1' },
      { name: h.m.names.objects[0], versionId: 'version-2' },
      { name: h.m.names.objects[0], versionId: 'marker-1', deleteMarker: true });
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist, {}, true);
    expect(result).toMatchObject({ passed: true, cleanup: { remaining: [], unknown: [], errors: [] } });
    expect(h.versions).toEqual([]); expect(h.objects.size).toBe(0); expect(h.state.exists).toBe(false);
  });

  it('列绑定失败后仍尝试清理本轮 Key 与独立 Bucket', async () => {
    const h = harness();
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist, {
      log: e => { if (e.step === 'detached-policy-delete') h.rpc.failActions.set('ListPoliciesForUser', 'AccessDenied'); },
    });
    expect(result.passed).toBe(false); expect(h.state.exists).toBe(false);
    expect(h.rpc.users.get(h.m.names.renamed)?.keys).toEqual([]);
    expect(result.cleanup.remaining).toContain(h.m.names.renamed);
  });

  it.each(['policy', 'key'] as const)('意外的第 11 策略 / 第 3 Key 成功（%s）先登记、清理，再报告规格冲突', async point => {
    const h = harness(); h.rpc.allowEleventh = point === 'policy'; h.rpc.allowThird = point === 'key';
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist);
    expect(result).toMatchObject({ passed: false, code: point === 'policy' ? 'UnexpectedEleventhPolicySuccess' : 'UnexpectedThirdKeySuccess',
      cleanup: { remaining: [], unknown: [], errors: [] } });
    expect(h.rpc.users.size).toBe(0); expect(h.rpc.policies.size).toBe(0); expect(h.state.exists).toBe(false);
  });

  it('一个资源清理失败仍清理其余资源，权限错误不能被当成零', async () => {
    const h = harness(); h.rpc.failCleanup = true; h.state.deleteFailed = true;
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist);
    expect(result.passed).toBe(false);
    expect(result.cleanup.remaining).toEqual([h.m.names.renamed, h.m.names.bucket]);
    expect(h.rpc.policies.size).toBe(0); expect(h.objects.size).toBe(0);
    h.state.getFailed = true;
    const retry = await runContract(admin, h.m, h.cloud, h.bucket, h.persist, {}, true);
    expect(retry.cleanup.unknown).toContain(h.m.names.bucket);
  });

  it('中断停止新工作，清理忽略测试 abort，且只进入一次清理', async () => {
    const h = harness(); let aborted = false;
    h.rpc.afterCreateKey = async () => { aborted = true; };
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist, { aborted: () => aborted });
    expect(result).toMatchObject({ passed: false, code: 'Aborted', cleanup: { remaining: [], unknown: [], errors: [] } });
    expect(h.rpc.calls.filter(c => c === 'DeleteUser')).toHaveLength(1);
  });

  it('传播等待允许首次成功，只重试允许的暂态错误，签名错误与 deadline 直接失败', async () => {
    expect(await waitForReady(async () => {})).toMatchObject({ attempts: 1 });
    let now = 0, attempts = 0;
    const options = { now: () => now, sleep: async (ms: number) => { now += ms; }, readinessMs: 10_000 };
    const ready = await waitForReady(async () => { if (++attempts < 3) throw { code: 'InvalidAccessKeyId' }; }, options);
    expect(ready).toEqual({ attempts: 3, elapsedMs: 3000 });
    await expect(waitForReady(async () => { throw { code: 'SignatureDoesNotMatch' }; }, options)).rejects.toMatchObject({ code: 'SignatureDoesNotMatch' });
    await expect(waitForReady(async () => { throw { code: 'AccessDenied' }; }, options)).rejects.toMatchObject({ code: 'AccessDenied' });
    await expect(waitForReady(async () => { throw { code: 'InvalidAccessKeyId' }; }, options)).rejects.toThrow('ReadinessDeadline');
  });

  it('OSS 固定 timeout name 可安全分类，不暴露原始异常信息', () => {
    expect(safeCode({ name: 'ResponseTimeoutError', message: admin.accessKeySecret })).toBe('ResponseTimeoutError');
    expect(safeCode({ name: 'ConnectionTimeoutError', code: undefined })).toBe('ConnectionTimeoutError');
    expect(safeCode(new Error(admin.accessKeySecret))).toBe('UnclassifiedError');
  });

  it('资源种类不符的 missing 错误不能被当作策略不存在', async () => {
    const h = harness();
    const cloud = new GuardedRamCloud(admin, h.m, h.persist, async (c, action, args) => {
      if (action === 'GetPolicy') throw new RamCloudError(action, 'EntityNotExist.User');
      return h.rpc.rpc(c, action, args);
    });
    const result = await runContract(admin, h.m, cloud, h.bucket, h.persist, {}, true);
    expect(result.passed).toBe(false); expect(result.cleanup.unknown).toEqual(h.m.names.policies);
  });

  it('V4分页请求省略未设置的query键，显式清理不会产生签名不一致', async () => {
    const h = harness(); await h.bucket.create(); h.state.rejectUndefined = true;
    h.objects.set(h.m.names.objects[0], Buffer.from('probe'));
    const result = await runContract(admin, h.m, h.cloud, h.bucket, h.persist, {}, true);
    expect(result).toMatchObject({ passed: true, cleanup: { remaining: [], unknown: [], errors: [] } });
  });
});
