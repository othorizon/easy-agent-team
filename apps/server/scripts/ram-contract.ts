/** Opt-in real-cloud contract. Importing this module performs no I/O. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type OSS from 'ali-oss';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { RamCloud, RamCloudError, type RamCredentials } from '../src/ram/ram-cloud';

type Raw = Record<string, any>; // Only SDK transport shapes.
type Intent = { missing: boolean; attempted: boolean; confirmed: boolean };
export interface ContractManifest {
  schemaVersion: 1;
  runId: string;
  marker: string;
  accountId: string;
  region: string;
  names: { old: string; renamed: string; policies: string[]; bucket: string; objects: string[] };
  user: Intent & { id?: string; renameAttempted: boolean };
  policies: Record<string, Intent>;
  bindings: string[];
  keys: string[];
  keyIntents: { baseline: string[]; finished: boolean }[];
  versions: Record<string, string[]>;
  bucket: Intent;
  observations: { step: string; code: string; elapsedMs: number; attempts?: number }[];
  cleanup?: { remaining: string[]; unknown: string[]; errors: string[] };
}
function namesFor(runId: string) {
  const prefix = `eat-ram-contract-${runId.replaceAll('-', '')}`;
  return {
    old: `${prefix}-old`, renamed: `${prefix}-new`,
    policies: Array.from({ length: 11 }, (_, i) => `${prefix}-p${String(i + 1).padStart(2, '0')}`),
    bucket: `${prefix}-oss`, objects: ['probe/original.txt', 'probe/personal.txt'],
  };
}
export function newManifest(accountId: string, region: string): ContractManifest {
  const runId = randomUUID();
  const names = namesFor(runId);
  return {
    schemaVersion: 1, runId, marker: `EAT RAM contract ${runId}`, accountId, region, names,
    user: { missing: false, attempted: false, confirmed: false, renameAttempted: false },
    policies: Object.fromEntries(names.policies.map(n => [n, { missing: false, attempted: false, confirmed: false }])),
    bindings: [], keys: [], keyIntents: [], versions: {},
    bucket: { missing: false, attempted: false, confirmed: false }, observations: [],
  };
}
export class ContractError extends Error {
  constructor(readonly code: string) { super(code); }
}
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new ContractError(code);
}
export function safeCode(error: unknown): string {
  // Never log arbitrary SDK messages or untrusted error.code strings.
  const fixedNames = new Set(['ConnectionTimeoutError', 'ResponseTimeoutError', 'RequestError', 'ResponseError',
    'RemoteSocketClosedError', 'JSONResponseFormatError', 'UnzipError']);
  const name = error && typeof error === 'object' ? (error as Raw).name : undefined;
  // ali-oss 6.x sometimes reports a timeout only in .name, with no .code.
  if (fixedNames.has(name)) return name;
  if (error instanceof TypeError) return 'ClientTypeError';
  const code = error instanceof ContractError || error instanceof RamCloudError
    ? error.code : (error && typeof error === 'object' ? (error as Raw).code : undefined);
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,99}$/.test(code) &&
    (error instanceof ContractError || /^(NoSuch|EntityNotExist|LimitExceeded|QuotaExceeded|EntityQuotaExceeded|DeleteConflict|EntityAlreadyExists|AccessDenied|Forbidden|Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch|RequestTimeTooSkewed|InvalidArgument|InvalidParameter|InvalidHeader|InvalidBucket|InvalidRequest|InvalidTag|Malformed|NotImplemented|OperationNotSupported|NETWORK_ERROR|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|RequestTimeout|ConnectTimeout|ReadTimeout|TimeoutError|SDK\.)/.test(code))
    ? code : 'UnclassifiedError';
}
const isMissing = (e: unknown, resource: 'User' | 'Policy' | 'Bucket') =>
  (resource === 'Bucket' ? ['NoSuchBucket'] : [`NoSuch${resource}`, `EntityNotExist.${resource}`]).includes(safeCode(e));
export function probePolicy(m: ContractManifest): string {
  return JSON.stringify({ Version: '1', Statement: [{ Effect: 'Allow',
    Action: ['oss:PutObject', 'oss:GetObject'],
    Resource: m.names.objects.map(k => `acs:oss:*:*:${m.names.bucket}/${k}`),
  }] });
}
export type Persist = () => Promise<void>;
export type RamTransport = (c: RamCredentials, action: string, args: Raw) => Promise<Raw>;

const intentSchema = z.object({ missing: z.boolean(), attempted: z.boolean(), confirmed: z.boolean() }).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuidv4(), marker: z.string(), accountId: z.string().regex(/^\d+$/),
  region: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  names: z.object({ old: z.string(), renamed: z.string(), policies: z.array(z.string()).length(11),
    bucket: z.string(), objects: z.array(z.string()).length(2) }).strict(),
  user: intentSchema.extend({ id: z.string().min(1).max(128).optional(), renameAttempted: z.boolean() }).strict(),
  policies: z.record(z.string(), intentSchema), bindings: z.array(z.string()), keys: z.array(z.string().min(1).max(128)),
  keyIntents: z.array(z.object({ baseline: z.array(z.string()), finished: z.boolean() }).strict()),
  versions: z.record(z.string(), z.array(z.string().regex(/^v\d+$/))), bucket: intentSchema,
  observations: z.array(z.object({ step: z.string(), code: z.string(), elapsedMs: z.number().nonnegative(),
    attempts: z.number().int().positive().optional() }).strict()),
  cleanup: z.object({ remaining: z.array(z.string()), unknown: z.array(z.string()), errors: z.array(z.string()) }).strict().optional(),
}).strict();
export function validateManifest(value: unknown, accountId: string): ContractManifest {
  const parsed = manifestSchema.safeParse(value);
  requireThat(parsed.success, 'InvalidManifest');
  const m = parsed.data;
  requireThat(m.accountId === accountId, 'AccountMismatch');
  requireThat(m.marker === `EAT RAM contract ${m.runId}` &&
    JSON.stringify(m.names) === JSON.stringify(namesFor(m.runId)), 'InvalidManifest');
  requireThat(Object.keys(m.policies).length === 11 && m.names.policies.every(n => n in m.policies) &&
    m.bindings.every(n => m.names.policies.includes(n)) && Object.keys(m.versions).every(n => m.names.policies.includes(n)) &&
    m.keyIntents.every(i => i.baseline.every(k => m.keys.includes(k))) &&
    (!m.user.id || m.user.attempted && m.user.missing) &&
    (!m.user.renameAttempted || !!m.user.id) &&
    [m.user, m.bucket, ...Object.values(m.policies)].every(i => !i.attempted || i.missing), 'InvalidManifest');
  return m;
}

/** Each save replaces a 0600 file atomically and fsyncs both file and directory. */
export class PrivateManifest {
  private constructor(readonly path: string, readonly manifest: ContractManifest) {}
  private static async privatePath(path: string, directory: boolean) {
    const s = await lstat(path);
    requireThat(!s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile()) &&
      s.uid === process.getuid?.() && (s.mode & 0o077) === 0, 'ManifestPermissions');
  }
  static async create(directory: string, manifest: ContractManifest) {
    const dir = resolve(directory);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.privatePath(dir, true);
    const store = new PrivateManifest(join(dir, `${manifest.runId}.json`), manifest);
    const file = await open(store.path, 'wx', 0o600); await file.close();
    await store.save();
    return store;
  }
  static async load(path: string, accountId: string) {
    const target = resolve(path);
    await this.privatePath(dirname(target), true); await this.privatePath(target, false);
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const m = validateManifest(JSON.parse(await file.readFile('utf8')), accountId);
      requireThat(basename(target) === `${m.runId}.json`, 'InvalidManifest');
      return new PrivateManifest(target, m);
    } finally { await file.close(); }
  }
  async save() {
    validateManifest(this.manifest, this.manifest.accountId);
    await PrivateManifest.privatePath(dirname(this.path), true);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(this.manifest, null, 2)); await file.sync(); }
    finally { await file.close(); }
    try {
      await rename(temp, this.path);
      const dir = await open(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  }
}

/** Every inherited RAM helper must cross this default-deny transport guard. */
export class GuardedRamCloud extends RamCloud {
  beforeRequest: () => void = () => {};
  constructor(
    private readonly admin: RamCredentials,
    readonly manifest: ContractManifest,
    private readonly persist: Persist,
    private readonly transport?: RamTransport,
  ) { super(); }
  private send(action: string, args: Raw) {
    this.beforeRequest();
    return this.transport ? this.transport(this.admin, action, args) : super.ram(this.admin, action, args);
  }
  private userName(name: string) {
    requireThat([this.manifest.names.old, this.manifest.names.renamed].includes(name), 'ResourceDenied');
  }
  private policyName(name: string) {
    requireThat(this.manifest.names.policies.includes(name), 'ResourceDenied');
  }
  private async missing(action: string, args: Raw, resource: 'User' | 'Policy') {
    try { await this.send(action, args); }
    catch (e) { if (isMissing(e, resource)) return; throw e; }
    throw new ContractError('NameOccupied');
  }
  async ownedUser(name: string): Promise<Raw> {
    this.userName(name);
    const m = this.manifest;
    requireThat(m.user.missing && m.user.attempted, 'NoCreateIntent');
    requireThat(name !== m.names.renamed || m.user.renameAttempted, 'NoRenameIntent');
    const { user } = await this.send('GetUser', { userName: name });
    requireThat(user?.userName === name && user.comments === m.marker && user.userId, 'UserOwnershipMismatch');
    requireThat(!m.user.id || String(user.userId) === m.user.id, 'UserIdentityMismatch');
    if (!m.user.id || !m.user.confirmed) { m.user.id = String(user.userId); m.user.confirmed = true; await this.persist(); }
    return user;
  }
  async ownedPolicy(name: string): Promise<Raw> {
    this.policyName(name);
    const m = this.manifest;
    requireThat(m.policies[name]?.missing && m.policies[name].attempted, 'NoCreateIntent');
    const r = await this.send('GetPolicy', { policyName: name, policyType: 'Custom' });
    requireThat(r.policy?.policyName === name && r.policy.policyType === 'Custom' && r.policy.description === m.marker, 'PolicyOwnershipMismatch');
    if (!m.policies[name].confirmed) { m.policies[name].confirmed = true; await this.persist(); }
    return r;
  }
  async recoverKeys(name: string) {
    await this.ownedUser(name);
    const m = this.manifest;
    const keys = (await this.send('ListAccessKeys', { userName: name })).accessKeys?.accessKey ?? [];
    for (const intent of m.keyIntents.filter(i => !i.finished)) {
      for (const key of keys)
        if (!intent.baseline.includes(String(key.accessKeyId)) && !m.keys.includes(String(key.accessKeyId)))
          m.keys.push(String(key.accessKeyId));
      intent.finished = true;
      await this.persist();
    }
    return keys as Raw[];
  }
  protected override async ram(c: RamCredentials, action: string, args: Raw): Promise<Raw> {
    requireThat(c === this.admin, 'CredentialDenied');
    const allowed: Record<string, string[]> = {
      GetUser: ['userName'], CreateUser: ['userName', 'displayName', 'comments'],
      UpdateUser: ['userName', 'newUserName', 'newDisplayName', 'newComments'], DeleteUser: ['userName'],
      GetPolicy: ['policyName', 'policyType'], CreatePolicy: ['policyName', 'description', 'policyDocument'],
      ListPoliciesForUser: ['userName'], AttachPolicyToUser: ['userName', 'policyName', 'policyType'],
      DetachPolicyFromUser: ['userName', 'policyName', 'policyType'],
      ListPolicyVersions: ['policyName', 'policyType'], DeletePolicyVersion: ['policyName', 'versionId'],
      DeletePolicy: ['policyName'], ListAccessKeys: ['userName'], CreateAccessKey: ['userName'],
      UpdateAccessKey: ['userName', 'userAccessKeyId', 'status'], DeleteAccessKey: ['userName', 'userAccessKeyId'],
    };
    requireThat(allowed[action], 'ActionDenied');
    requireThat(Object.keys(args).every(k => allowed[action].includes(k)), 'ArgumentDenied');
    if (allowed[action].includes('userName')) this.userName(args.userName);
    if (allowed[action].includes('policyName')) this.policyName(args.policyName);
    if (allowed[action].includes('policyType')) requireThat(args.policyType === 'Custom', 'PolicyTypeDenied');
    const m = this.manifest;
    if (action === 'GetUser' || action === 'GetPolicy') return this.send(action, args);
    if (action === 'CreateUser') {
      requireThat(args.userName === m.names.old && args.comments === m.marker && args.displayName === m.names.old, 'MarkerDenied');
      requireThat(!m.user.attempted, 'CreateAlreadyAttempted');
      await this.missing('GetUser', { userName: args.userName }, 'User');
      m.user.missing = true; m.user.attempted = true; await this.persist();
      const r = await this.send(action, args);
      requireThat(r.user?.comments === m.marker && r.user.userName === args.userName && r.user.userId, 'UserOwnershipMismatch');
      m.user.id = String(r.user.userId); m.user.confirmed = true; await this.persist();
      return r;
    }
    if (action === 'CreatePolicy') {
      requireThat(args.description === m.marker && args.policyDocument === probePolicy(m), 'PolicyDocumentDenied');
      const intent = m.policies[args.policyName];
      requireThat(!intent.attempted, 'CreateAlreadyAttempted');
      await this.missing('GetPolicy', { policyName: args.policyName, policyType: 'Custom' }, 'Policy');
      intent.missing = true; intent.attempted = true; await this.persist();
      const result = await this.send(action, args);
      intent.confirmed = true; await this.persist();
      return result;
    }
    if ('userName' in args) await this.ownedUser(args.userName);
    if ('policyName' in args) await this.ownedPolicy(args.policyName);
    if (action === 'UpdateUser') {
      requireThat(args.userName === m.names.old && args.newUserName === m.names.renamed &&
        (args.newComments === undefined || args.newComments === m.marker) &&
        (args.newDisplayName === undefined || args.newDisplayName === m.names.renamed), 'RenameDenied');
      await this.missing('GetUser', { userName: args.newUserName }, 'User');
      m.user.renameAttempted = true; await this.persist();
    }
    if (action === 'AttachPolicyToUser') {
      if (!m.bindings.includes(args.policyName)) { m.bindings.push(args.policyName); await this.persist(); }
    }
    if (action === 'DetachPolicyFromUser') requireThat(m.bindings.includes(args.policyName), 'NoBindingIntent');
    if (action === 'CreateAccessKey') {
      const baseline = (await this.send('ListAccessKeys', { userName: args.userName })).accessKeys?.accessKey ?? [];
      requireThat(baseline.every((k: Raw) => m.keys.includes(String(k.accessKeyId))), 'UnexpectedKey');
      const intent = { baseline: baseline.map((k: Raw) => String(k.accessKeyId)), finished: false };
      requireThat(m.keyIntents.every(i => i.finished), 'UnrecoveredKeyIntent');
      m.keyIntents.push(intent); await this.persist();
      try {
        const r = await this.send(action, args);
        requireThat(r.accessKey?.accessKeyId && r.accessKey.accessKeySecret, 'InvalidKeyResponse');
        m.keys.push(String(r.accessKey.accessKeyId)); intent.finished = true; await this.persist();
        return r;
      } catch (e) { await this.recoverKeys(args.userName); throw e; }
    }
    if (action === 'DeleteAccessKey' || action === 'UpdateAccessKey') {
      requireThat(m.keys.includes(args.userAccessKeyId), 'KeyDenied');
      if (action === 'UpdateAccessKey') requireThat(['Active', 'Inactive'].includes(args.status), 'KeyStatusDenied');
    }
    if (action === 'DeletePolicyVersion') requireThat(m.versions[args.policyName]?.includes(args.versionId), 'VersionDenied');
    const r = await this.send(action, args);
    if (action === 'ListPolicyVersions') {
      m.versions[args.policyName] = (r.policyVersions?.policyVersion ?? []).map((v: Raw) => String(v.versionId));
      await this.persist();
    }
    if (action === 'UpdateUser') await this.ownedUser(args.newUserName);
    return r;
  }
}

/** Narrow view of the already-installed OSS SDK; omitted declarations stay at this boundary. */
export interface BucketClient {
  getBucketInfo(name: string): Promise<Raw>;
  getBucketTags(name: string): Promise<{ tag: Record<string, string> }>;
  putBucket(name: string, options: Raw): Promise<unknown>;
  deleteBucket(name: string): Promise<unknown>;
  put(key: string, bytes: Buffer, options: Raw): Promise<unknown>;
  get(key: string, options: Raw): Promise<{ content: Buffer }>;
  list(query: Raw, options: Raw): Promise<{ objects?: { name: string }[]; isTruncated?: boolean; nextMarker?: string }>;
  getBucketVersions(query: Raw): Promise<{ objects?: { name: string; versionId: string }[];
    deleteMarker?: { name: string; versionId: string }[]; isTruncated?: boolean; nextKeyMarker?: string; nextVersionIdMarker?: string }>;
  delete(key: string, options?: Raw): Promise<unknown>;
}
export type BucketFactory = (credentials: RamCredentials) => BucketClient;
export class GuardedBucket {
  beforeRequest: () => void = () => {};
  lastAction = 'Unspecified';
  private readonly adminClient: BucketClient;
  constructor(private readonly admin: RamCredentials, readonly manifest: ContractManifest,
    private readonly persist: Persist, private readonly factory: BucketFactory) { this.adminClient = factory(admin); }
  private async request<T>(fn: () => Promise<T>, action = 'Unspecified'): Promise<T> {
    this.lastAction = action; this.beforeRequest(); return fn();
  }
  private object(key: string) { requireThat(this.manifest.names.objects.includes(key), 'ObjectDenied'); }
  async exists() {
    try { await this.request(() => this.adminClient.getBucketInfo(this.manifest.names.bucket), 'GetBucketInfo'); return true; }
    catch (e) { if (isMissing(e, 'Bucket')) return false; throw e; }
  }
  async owned() {
    const m = this.manifest;
    requireThat(m.bucket.missing && m.bucket.attempted, 'NoBucketIntent');
    const { bucket: b } = await this.request(() => this.adminClient.getBucketInfo(m.names.bucket), 'GetBucketInfo');
    requireThat(String(b.Owner?.ID) === m.accountId && b.Location === `oss-${m.region}` &&
      b.AccessControlList?.Grant === 'private', 'BucketOwnershipMismatch');
    const { tag } = await this.request(() => this.adminClient.getBucketTags(m.names.bucket), 'GetBucketTags');
    requireThat(tag['eat-ram-contract'] === m.runId, 'BucketMarkerMismatch');
    if (!m.bucket.confirmed) { m.bucket.confirmed = true; await this.persist(); }
  }
  async create() {
    const m = this.manifest;
    requireThat(!m.bucket.attempted, 'CreateAlreadyAttempted');
    requireThat(!(await this.exists()), 'NameOccupied');
    m.bucket.missing = true; m.bucket.attempted = true; await this.persist();
    // The marker is attached atomically. Never "repair" an unmarked bucket after creation.
    await this.request(() => this.adminClient.putBucket(m.names.bucket, { acl: 'private', storageClass: 'Standard',
      dataRedundancyType: 'LRS', timeout: 5000, headers: { 'x-oss-bucket-tagging': `eat-ram-contract=${m.runId}` } }), 'PutBucket');
    await this.owned();
  }
  async put(c: RamCredentials, key: string, bytes: Buffer) {
    this.object(key); await this.owned();
    await this.request(() => this.factory(c).put(key, bytes, { timeout: 5000,
      headers: { 'x-oss-forbid-overwrite': 'true' }, meta: { 'eat-ram-contract': this.manifest.runId } }), 'PutObject');
  }
  async get(c: RamCredentials, key: string): Promise<Buffer> {
    this.object(key); await this.owned();
    return (await this.request(() => this.factory(c).get(key, { timeout: 5000 }), 'GetObject')).content;
  }
  async remove() {
    await this.owned();
    // Collect and verify every page before any deletion. No delimiter, no prefix-only assumptions.
    const objects: string[] = [];
    let marker: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.request(() => this.adminClient.list({ 'max-keys': 1000, ...(marker ? { marker } : {}) }, {}), 'ListObjects');
      for (const object of page.objects ?? []) { this.object(object.name); objects.push(object.name); }
      if (!page.isTruncated) break;
      requireThat(page.nextMarker && !seen.has(page.nextMarker), 'InvalidPagination');
      marker = page.nextMarker; seen.add(marker); requireThat(seen.size <= 100, 'PaginationBudget');
    } while (true);
    const versions: { name: string; versionId: string }[] = [];
    let keyMarker: string | undefined, versionIdMarker: string | undefined;
    seen.clear();
    do {
      const page = await this.request(() => this.adminClient.getBucketVersions({ maxKeys: 1000,
        ...(keyMarker ? { keyMarker } : {}), ...(versionIdMarker ? { versionIdMarker } : {}) }), 'ListObjectVersions');
      for (const v of [...(page.objects ?? []), ...(page.deleteMarker ?? [])]) { this.object(v.name); versions.push(v); }
      if (!page.isTruncated) break;
      const token = `${page.nextKeyMarker}:${page.nextVersionIdMarker}`;
      requireThat(page.nextKeyMarker && !seen.has(token), 'InvalidPagination');
      keyMarker = page.nextKeyMarker; versionIdMarker = page.nextVersionIdMarker;
      seen.add(token); requireThat(seen.size <= 100, 'PaginationBudget');
    } while (true);
    const deleteFailures: string[] = [];
    const removeObject = async (key: string, versionId?: string) => {
      try {
        await this.owned();
        await this.request(() => this.adminClient.delete(key, versionId ? { versionId } : undefined), 'DeleteObject');
      } catch (e) { deleteFailures.push(safeCode(e)); }
    };
    // Deleting a current object without versionId on a versioned bucket would create
    // another delete marker. Delete its enumerated versions directly instead.
    const versionedNames = new Set(versions.map(v => v.name));
    for (const key of objects) if (!versionedNames.has(key)) await removeObject(key);
    for (const v of versions) await removeObject(v.name, v.versionId);
    const remaining = await this.request(() => this.adminClient.list({ 'max-keys': 1000 }, {}), 'ListObjects');
    requireThat(!remaining.isTruncated && !remaining.objects?.length, 'BucketNotEmpty');
    const leftoverVersions = await this.request(() => this.adminClient.getBucketVersions({ maxKeys: 1000 }), 'ListObjectVersions');
    requireThat(!leftoverVersions.isTruncated && !leftoverVersions.objects?.length && !leftoverVersions.deleteMarker?.length, 'BucketNotEmpty');
    for (const key of this.manifest.names.objects) {
      try {
        await this.request(() => this.adminClient.get(key, { timeout: 5000 }), 'GetObject');
        throw new ContractError('ObjectStillExists');
      } catch (e) { if (safeCode(e) !== 'NoSuchKey') throw e; }
    }
    await this.owned(); await this.request(() => this.adminClient.deleteBucket(this.manifest.names.bucket), 'DeleteBucket');
    requireThat(!deleteFailures.length, 'ObjectCleanupHadErrors');
  }
}

export async function ossFactory(m: ContractManifest): Promise<BucketFactory> {
  const { default: Client } = await import('ali-oss');
  return c => new Client({ bucket: m.names.bucket, region: `oss-${m.region}`, ...c, secure: true,
    authorizationV4: true, timeout: 5000, retryMax: 0 } as OSS.Options) as unknown as BucketClient;
}

export interface CleanupReport { remaining: string[]; unknown: string[]; errors: string[] }
/** Best effort for every resource; an error is never evidence of absence. */
export async function cleanupContract(c: RamCredentials, m: ContractManifest, cloud: GuardedRamCloud,
  bucket: GuardedBucket, persist: Persist, budgetMs = 240_000): Promise<CleanupReport> {
  const deadline = Date.now() + budgetMs;
  cloud.beforeRequest = bucket.beforeRequest = () => requireThat(Date.now() < deadline, 'CleanupDeadline');
  const report: CleanupReport = { remaining: [], unknown: [], errors: [] };
  const attempt = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { report.errors.push(`${name}:${safeCode(e)}`); }
  };
  for (const name of [m.names.old, m.names.renamed]) {
    await attempt(`user:${name}`, async () => {
      if (!m.user.attempted) return;
      if (name === m.names.renamed && !m.user.renameAttempted) return;
      try { await cloud.ownedUser(name); } catch (e) { if (isMissing(e, 'User')) return; throw e; }
      let bindings: Awaited<ReturnType<RamCloud['userPolicies']>> = [];
      await attempt(`bindings:${name}`, async () => { bindings = await cloud.userPolicies(c, name); });
      // Individual failures do not block attempts to clean other bindings or keys.
      for (const binding of bindings) await attempt(`binding:${binding.name}`, async () => {
        requireThat(binding.type === 'Custom' && m.bindings.includes(binding.name), 'UnexpectedBinding');
        await cloud.detachPolicy(c, name, binding.name);
      });
      let keys: Raw[] = [];
      await attempt(`keys:${name}`, async () => { keys = await cloud.recoverKeys(name); });
      const keyIds = new Set([...m.keys, ...keys.map(key => String(key.accessKeyId))]);
      for (const keyId of keyIds) await attempt('key', async () => {
        requireThat(m.keys.includes(keyId), 'UnexpectedKey');
        await cloud.deleteKey(c, name, keyId);
      });
      // RAM itself refuses deletion with an unexpected/unremoved key or binding.
      await cloud.deleteUser(c, name);
    });
  }
  for (const name of m.names.policies) await attempt(`policy:${name}`, async () => {
    if (!m.policies[name].attempted) return;
    try { await cloud.ownedPolicy(name); } catch (e) { if (isMissing(e, 'Policy')) return; throw e; }
    await cloud.deletePolicy(c, name);
  });
  await attempt(`bucket:${m.names.bucket}`, async () => {
    try { if (m.bucket.attempted && await bucket.exists()) await bucket.remove(); }
    catch (e) { throw new ContractError(`OSS.${bucket.lastAction}.${safeCode(e)}`.slice(0, 100)); }
  });
  const verify = async (name: string, resource: 'User' | 'Policy' | 'Bucket', fn: () => Promise<unknown>) => {
    try { await fn(); report.remaining.push(name); }
    catch (e) {
      if (!isMissing(e, resource)) { report.unknown.push(name); report.errors.push(`verify:${name}:${safeCode(e)}`); }
    }
  };
  // Verify all planned names, including failed creates and both rename endpoints.
  for (const name of [m.names.old, m.names.renamed]) await verify(name, 'User', () => cloud.getUser(c, name));
  for (const name of m.names.policies) await verify(name, 'Policy', () => cloud.getPolicy(c, name));
  await verify(m.names.bucket, 'Bucket', async () => {
    if (!(await bucket.exists())) throw new ContractError('NoSuchBucket');
  });
  m.cleanup = report;
  await persist();
  return report;
}

export interface ContractOptions {
  aborted?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readinessMs?: number;
  cleanupMs?: number;
  log?: (event: Record<string, unknown>) => void;
}
export async function waitForReady(probe: () => Promise<void>, options: ContractOptions = {},
  allowAccessDenied = false): Promise<{ elapsedMs: number; attempts: number }> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? delay;
  const start = now(), deadline = start + (options.readinessMs ?? 120_000);
  let attempts = 0;
  while (true) {
    requireThat(!options.aborted?.(), 'Aborted');
    requireThat(now() < deadline, 'ReadinessDeadline');
    try { attempts++; await probe(); return { elapsedMs: now() - start, attempts }; }
    catch (e) {
      const code = safeCode(e);
      requireThat(!options.aborted?.(), 'Aborted');
      if (code !== 'InvalidAccessKeyId' && !(allowAccessDenied && code === 'AccessDenied')) throw e;
      const remaining = deadline - now();
      requireThat(remaining > 0, 'ReadinessDeadline');
      await sleep(Math.min(5000, 1000 * 2 ** Math.min(attempts - 1, 3), remaining));
    }
  }
}
export interface ContractResult { passed: boolean; code: string; cleanup: CleanupReport; elapsedMs: number }
/** The same coordinator is exercised offline against the only cloud boundaries. */
export async function runContract(c: RamCredentials, m: ContractManifest, cloud: GuardedRamCloud,
  bucket: GuardedBucket, persist: Persist, options: ContractOptions = {}, cleanupOnly = false): Promise<ContractResult> {
  const started = Date.now();
  let code = 'OK';
  let currentStep = 'setup';
  const observation = async (step: string, resultCode: string, start: number, extra = {}) => {
    const event = { step, code: resultCode, elapsedMs: Date.now() - start, ...extra };
    m.observations.push(event); await persist(); options.log?.(event);
  };
  const active = () => requireThat(!options.aborted?.(), 'Aborted');
  cloud.beforeRequest = bucket.beforeRequest = active;
  const quota = async (step: string, fn: () => Promise<unknown>, unexpected: string) => {
    const start = Date.now();
    try { await fn(); }
    catch (e) {
      requireThat(e instanceof RamCloudError && e.kind === 'quota', `${step}NotQuota`);
      await observation(step, safeCode(e), start); return;
    }
    await observation(step, unexpected, start);
    throw new ContractError(unexpected); // The successful extra resource is already journaled for finally.
  };
  try {
    if (!cleanupOnly) {
      currentStep = 'bucket-create';
      active(); await bucket.create();
      currentStep = 'admin-probe';
      const bytes = Buffer.from(`RAM contract ${m.runId}`);
      await bucket.put(c, m.names.objects[0], bytes);
      currentStep = 'create-user';
      const user = await cloud.createUser(c, { name: m.names.old, displayName: m.names.old, comments: m.marker });
      await observation('create-user', 'OK', started);
      await cloud.createPolicy(c, m.names.policies[0], m.marker, probePolicy(m));
      await cloud.attachPolicy(c, user.name, m.names.policies[0]);
      const exactPolicy = await cloud.getPolicy(c, m.names.policies[0]);
      requireThat(exactPolicy.type === 'Custom' && exactPolicy.description === m.marker &&
        isDeepStrictEqual(JSON.parse(exactPolicy.document), JSON.parse(probePolicy(m))), 'PolicyDocumentMismatch');
      requireThat((await cloud.userPolicies(c, user.name)).some(p => p.name === m.names.policies[0] && p.type === 'Custom'), 'ProbePolicyNotBound');
      let start = Date.now();
      currentStep = 'first-key-ready';
      const first = await cloud.createKey(c, user.name);
      const oldCredentials = { accessKeyId: first.id, accessKeySecret: first.secret };
      const readOld = async () => requireThat((await bucket.get(oldCredentials, m.names.objects[0])).equals(bytes), 'ObjectContentMismatch');
      // Fresh, exact policy document and binding were read back above. AccessDenied here
      // may be policy propagation; it is retryable only for this pre-registered probe.
      const firstReady = await waitForReady(readOld, options, true);
      await observation('first-key-ready', 'OK', start, { attempts: firstReady.attempts });
      await bucket.put(oldCredentials, m.names.objects[1], bytes);
      requireThat((await bucket.get(oldCredentials, m.names.objects[1])).equals(bytes), 'ObjectContentMismatch');
      currentStep = 'rename-user';
      const renamed = await cloud.updateUser(c, user.name, { name: m.names.renamed });
      requireThat(renamed.id === user.id && renamed.comments === m.marker, 'RenameIdentityMismatch');
      requireThat((await cloud.keys(c, renamed.name)).some(k => k.id === first.id && k.status === 'Active'), 'RenameKeyMismatch');
      start = Date.now(); await readOld();
      await observation('old-key-after-rename', 'OK', start);
      start = Date.now();
      currentStep = 'second-key-ready';
      const second = await cloud.createKey(c, renamed.name);
      const secondCredentials = { accessKeyId: second.id, accessKeySecret: second.secret };
      const secondReady = await waitForReady(async () => requireThat(
        (await bucket.get(secondCredentials, m.names.objects[0])).equals(bytes), 'ObjectContentMismatch'), options, true);
      await observation('second-key-ready', 'OK', start, { attempts: secondReady.attempts });
      currentStep = 'third-key';
      await quota('third-key', () => cloud.createKey(c, renamed.name), 'UnexpectedThirdKeySuccess');
      currentStep = 'first-ten-policies';
      for (const policy of m.names.policies.slice(1, 10)) {
        await cloud.createPolicy(c, policy, m.marker, probePolicy(m));
        await cloud.attachPolicy(c, renamed.name, policy);
      }
      const eleventh = m.names.policies[10];
      currentStep = 'eleventh-policy';
      await cloud.createPolicy(c, eleventh, m.marker, probePolicy(m));
      await quota('eleventh-policy', () => cloud.attachPolicy(c, renamed.name, eleventh), 'UnexpectedEleventhPolicySuccess');
      const bound = m.names.policies[9]; start = Date.now();
      currentStep = 'bound-policy-delete';
      let rejected = false;
      try { await cloud.deletePolicy(c, bound); }
      catch (e) {
        requireThat(e instanceof RamCloudError && e.kind === 'conflict', 'BoundDeleteNotConflict');
        rejected = true; await observation('bound-policy-delete', safeCode(e), start);
      }
      requireThat(rejected, 'UnexpectedBoundPolicyDeleteSuccess');
      await cloud.ownedPolicy(bound);
      requireThat((await cloud.userPolicies(c, renamed.name)).some(p => p.name === bound && p.type === 'Custom'), 'BoundPolicyDisappeared');
      await cloud.detachPolicy(c, renamed.name, bound); await cloud.deletePolicy(c, bound);
      try { await cloud.getPolicy(c, bound); throw new ContractError('DetachedPolicyStillExists'); }
      catch (e) { if (!isMissing(e, 'Policy')) throw e; }
      await observation('detached-policy-delete', 'OK', start);
    }
  } catch (e) {
    code = safeCode(e);
    const event = { step: `failed:${currentStep}`, code, elapsedMs: Date.now() - started };
    m.observations.push(event);
    try { await persist(); } catch { /* finally still attempts all cleanup */ }
    options.log?.(event);
  }
  finally {
    // One finally path. Signals only set the abort flag and never exit in-flight SDK work.
    try { await cleanupContract(c, m, cloud, bucket, persist, options.cleanupMs); }
    catch (e) {
      m.cleanup ??= { remaining: [], unknown: [...[m.names.old, m.names.renamed], ...m.names.policies, m.names.bucket], errors: [] };
      m.cleanup.errors.push(`manifest:${safeCode(e)}`);
      if (code === 'OK') code = 'CleanupFailed';
    }
  }
  const cleanup = m.cleanup!;
  if ((cleanup.remaining.length || cleanup.unknown.length || cleanup.errors.length) && code === 'OK') code = 'CleanupFailed';
  return { passed: code === 'OK', code, cleanup, elapsedMs: Date.now() - started };
}

export async function runFromEnvironment(
  env: Record<string, string | undefined>,
  args: string[],
  options: { readProfile?: () => Promise<{ credentials: RamCredentials; region: string }>;
    log?: (event: Record<string, unknown>) => void } = {},
): Promise<{ skipped: true } | (ContractResult & { manifest: string; runId: string; resources: ContractManifest['names']; observations: ContractManifest['observations'] })> {
  if (env.EAT_REAL_RAM_CONTRACT !== '1') return { skipped: true };
  requireThat(args.length === 0 || args.length === 2 && args[0] === '--cleanup', 'InvalidArguments');
  let aborted = false;
  const abort = () => { aborted = true; };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath: string | undefined;
  try {
    const profile = await (options.readProfile ?? (() => readSelectedProfile(env.EAT_REAL_RAM_PROFILE)))();
    requireThat(!aborted, 'Aborted');
    const credentials = Object.freeze(profile.credentials);
    const accountId = await new RamCloud().callerAccount(credentials);
    requireThat(!aborted, 'Aborted');
    const store = args.length
      ? await PrivateManifest.load(args[1], accountId)
      : await PrivateManifest.create(env.EAT_RAM_CONTRACT_MANIFEST_DIR ?? resolve('.ram-contract'), newManifest(accountId, profile.region));
    const m = store.manifest;
    // flock is not portable; an exclusive lease prevents concurrent cleanup/run on the same manifest.
    // A killed process leaves its lease. Explicit recovery checks only that recorded PID locally.
    lockPath = `${store.path}.lock`;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (e) {
      if ((e as Raw).code !== 'EEXIST' || !args.length) throw new ContractError('ManifestLocked');
      const lease = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let pid: number;
      try { pid = Number(await lease.readFile('utf8')); } finally { await lease.close(); }
      requireThat(Number.isSafeInteger(pid) && pid > 1, 'ManifestLocked');
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if ((error as Raw).code === 'ESRCH') alive = false; }
      requireThat(!alive, 'ManifestLocked');
      await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
    }
    await lock.writeFile(String(process.pid)); await lock.sync();
    const persist = () => store.save();
    const cloud = new GuardedRamCloud(credentials, m, persist);
    const bucket = new GuardedBucket(credentials, m, persist, await ossFactory(m));
    options.log?.({ step: args.length ? 'cleanup-start' : 'start', runId: m.runId, manifest: store.path, resources: m.names });
    const result = await runContract(credentials, m, cloud, bucket, persist, { aborted: () => aborted, log: options.log }, !!args.length);
    return { ...result, manifest: store.path, runId: m.runId, resources: m.names, observations: m.observations };
  } finally {
    if (lock) { await lock.close(); if (lockPath) await unlink(lockPath).catch(() => {}); }
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

async function readSelectedProfile(name?: string): Promise<{ credentials: RamCredentials; region: string }> {
  // Do not execute `aliyun configure get`: it prints the complete credential profile.
  const file = await open(join(homedir(), '.aliyun', 'config.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const config = JSON.parse(await file.readFile('utf8')) as Raw;
    const selected = name ?? config.current;
    const profile = Array.isArray(config.profiles) && config.profiles.find((p: Raw) => p.name === selected);
    requireThat(profile && profile.mode === 'AK' && typeof profile.access_key_id === 'string' && profile.access_key_id &&
      typeof profile.access_key_secret === 'string' && profile.access_key_secret && typeof profile.region_id === 'string' &&
      /^[a-z][a-z0-9-]{1,39}$/.test(profile.region_id), 'InvalidAKProfile');
    return { credentials: { accessKeyId: profile.access_key_id, accessKeySecret: profile.access_key_secret }, region: profile.region_id };
  } finally { await file.close(); }
}
