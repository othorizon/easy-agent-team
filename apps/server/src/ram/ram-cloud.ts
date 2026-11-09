import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import StsClient from '@alicloud/sts20150401';
import RamClient, * as Ram from '@alicloud/ram20150501';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { isDeepStrictEqual } from 'node:util';

export interface RamCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}
export interface RamUser {
  id: string;
  name: string;
  displayName: string;
  comments: string;
}
export interface RamPolicy {
  name: string;
  type: 'Custom' | 'System';
  description: string;
}
export type RamErrorKind =
  | 'quota'
  | 'missing'
  | 'forbidden'
  | 'network'
  | 'conflict'
  | 'other';
function errorKind(code: string): RamErrorKind {
  if (/^(LimitExceeded|QuotaExceeded|EntityQuotaExceeded)/i.test(code))
    return 'quota';
  if (/^(NoSuch|EntityNotExist)/i.test(code)) return 'missing';
  if (
    /^(AccessDenied|Forbidden|Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch|401|403)/i.test(
      code,
    )
  )
    return 'forbidden';
  if (
    /^(NETWORK_ERROR|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|RequestTimeout|ConnectTimeout|ReadTimeout|TimeoutError|SDK\.(Timeout|Connection)Error)/i.test(
      code,
    )
  )
    return 'network';
  if (/^(EntityAlreadyExists|DeleteConflict)/i.test(code)) return 'conflict';
  return 'other';
}
/** Sanitized provider error. Raw SDK messages may contain credentials and are never exposed. */
export class RamCloudError extends ServiceUnavailableException {
  readonly kind: RamErrorKind;
  readonly code: string;
  constructor(
    readonly action: string,
    code: string,
  ) {
    const safeCode =
      code.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100) || 'UNKNOWN';
    super(`${action} 失败（${safeCode}），请检查阿里云权限、配额及配置`);
    this.code = safeCode;
    this.kind = errorKind(safeCode);
  }
}
export const ramMissing = (e: unknown) =>
  e instanceof RamCloudError && e.kind === 'missing';
type Raw = Record<string, any>; // Only the provider transport uses SDK response shapes.

/** All credentials are supplied per call; no account-specific state is retained. */
@Injectable()
export class RamCloud {
  private async safe<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RamCloudError) throw e;
      const raw = (e && typeof e === 'object' ? e : {}) as {
        code?: string;
        status?: number;
        statusCode?: number;
      };
      const code = String(
        raw.code ?? raw.statusCode ?? raw.status ?? 'NETWORK_ERROR',
      )
        .replace(/[^a-zA-Z0-9._-]/g, '')
        .slice(0, 100);
      throw new RamCloudError(action, code || 'UNKNOWN');
    }
  }
  protected async ram(
    c: RamCredentials,
    action: string,
    args: Raw,
  ): Promise<Raw> {
    return this.safe(`RAM ${action}`, async () => {
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
      const result = await (
        client as unknown as Record<
          string,
          (v: unknown) => Promise<{ body: Raw }>
        >
      )[method](new models[`${action}Request`](args));
      return result.body;
    });
  }
  async callerAccount(c: RamCredentials): Promise<string> {
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
        throw new RamCloudError('STS GetCallerIdentity', 'MissingAccountId');
      return result.body.accountId;
    });
  }
  async getUser(c: RamCredentials, userName: string): Promise<RamUser> {
    const { user } = await this.ram(c, 'GetUser', { userName });
    return this.userInfo(user);
  }
  async createUser(
    c: RamCredentials,
    user: Omit<RamUser, 'id'>,
  ): Promise<RamUser> {
    const r = await this.ram(c, 'CreateUser', {
      userName: user.name,
      displayName: user.displayName,
      comments: user.comments,
    });
    return this.userInfo(r.user);
  }
  async updateUser(
    c: RamCredentials,
    userName: string,
    changes: Partial<Omit<RamUser, 'id'>>,
  ): Promise<RamUser> {
    const r = await this.ram(c, 'UpdateUser', {
      userName,
      newUserName: changes.name,
      newDisplayName: changes.displayName,
      newComments: changes.comments,
    });
    return this.userInfo(r.user);
  }
  private userInfo(user: Raw): RamUser {
    return {
      id: String(user.userId),
      name: String(user.userName),
      displayName: user.displayName ?? '',
      comments: user.comments ?? '',
    };
  }
  async ensureUser(
    c: RamCredentials,
    userName: string,
    marker: string,
    guard: () => void = () => {},
  ): Promise<RamUser> {
    guard();
    let user: RamUser;
    try {
      user = await this.getUser(c, userName);
    } catch (e) {
      if (!ramMissing(e)) throw e;
      guard();
      user = await this.createUser(c, {
        name: userName,
        comments: marker,
        displayName: userName,
      });
    }
    guard();
    if (user.comments !== marker)
      throw new Error('RAM 用户归属不匹配，拒绝接管已有用户');
    return user;
  }
  private policyInfo(policy: Raw): RamPolicy {
    return {
      name: String(policy.policyName),
      type: policy.policyType,
      description: policy.description ?? '',
    };
  }
  async listPolicies(
    c: RamCredentials,
    page: { marker?: string; maxItems?: number } = {},
  ): Promise<{ policies: RamPolicy[]; nextMarker?: string }> {
    const r = await this.ram(c, 'ListPolicies', {
      policyType: 'Custom',
      ...page,
    });
    return {
      policies: (r.policies?.policy ?? []).map((p: Raw) => this.policyInfo(p)),
      nextMarker: r.isTruncated ? r.marker : undefined,
    };
  }
  async getPolicy(
    c: RamCredentials,
    policyName: string,
  ): Promise<RamPolicy & { document: string }> {
    const r = await this.ram(c, 'GetPolicy', {
      policyName,
      policyType: 'Custom',
    });
    let document = r.defaultPolicyVersion.policyDocument;
    try {
      JSON.parse(document);
    } catch {
      try {
        document = decodeURIComponent(document);
        JSON.parse(document);
      } catch {
        throw new RamCloudError('RAM GetPolicy', 'InvalidPolicyDocument');
      }
    }
    return { ...this.policyInfo(r.policy), document };
  }
  async createPolicy(
    c: RamCredentials,
    policyName: string,
    description: string,
    document: string,
  ) {
    await this.ram(c, 'CreatePolicy', {
      policyName,
      description,
      policyDocument: document,
    });
  }
  async userPolicies(
    c: RamCredentials,
    userName: string,
  ): Promise<RamPolicy[]> {
    const r = await this.ram(c, 'ListPoliciesForUser', { userName });
    return (r.policies?.policy ?? []).map((p: Raw) => this.policyInfo(p));
  }
  async attachPolicy(
    c: RamCredentials,
    userName: string,
    policyName: string,
    policyType: RamPolicy['type'] = 'Custom',
  ) {
    await this.ram(c, 'AttachPolicyToUser', {
      userName,
      policyName,
      policyType,
    });
  }
  async detachPolicy(
    c: RamCredentials,
    userName: string,
    policyName: string,
    policyType: RamPolicy['type'] = 'Custom',
  ) {
    await this.ram(c, 'DetachPolicyFromUser', {
      userName,
      policyName,
      policyType,
    });
  }
  async deleteUser(c: RamCredentials, userName: string) {
    await this.ram(c, 'DeleteUser', { userName });
  }
  async deletePolicy(c: RamCredentials, policyName: string) {
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
  }
  async applyUserPolicy(
    c: RamCredentials,
    userName: string,
    policyName: string,
    marker: string,
    policy: unknown,
    guard: () => void = () => {},
  ) {
    guard();
    let found: (RamPolicy & { document: string }) | undefined;
    try {
      found = await this.getPolicy(c, policyName);
    } catch (e) {
      if (!ramMissing(e)) throw e;
    }
    guard();
    if (!found)
      await this.createPolicy(c, policyName, marker, JSON.stringify(policy));
    else {
      if (found.description !== marker)
        throw new Error('RAM 策略归属不匹配，拒绝覆盖已有策略');
      if (!isDeepStrictEqual(JSON.parse(found.document), policy))
        await this.ram(c, 'CreatePolicyVersion', {
          policyName,
          policyDocument: JSON.stringify(policy),
          setAsDefault: true,
          rotateStrategy: 'DeleteOldestNonDefaultVersionWhenLimitExceeded',
        });
    }
    guard();
    if (
      !(await this.userPolicies(c, userName)).some(
        (p) => p.name === policyName && p.type === 'Custom',
      )
    ) {
      guard();
      await this.attachPolicy(c, userName, policyName);
    }
    guard();
  }
  async keys(
    c: RamCredentials,
    userName: string,
  ): Promise<{ id: string; status: string }[]> {
    const r = await this.ram(c, 'ListAccessKeys', { userName });
    return (r.accessKeys?.accessKey ?? []).map((k: Raw) => ({
      id: String(k.accessKeyId),
      status: String(k.status),
    }));
  }
  async createKey(
    c: RamCredentials,
    userName: string,
  ): Promise<{ id: string; secret: string }> {
    const r = await this.ram(c, 'CreateAccessKey', { userName });
    return { id: r.accessKey.accessKeyId, secret: r.accessKey.accessKeySecret };
  }
  async keyStatus(
    c: RamCredentials,
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
  async deleteKey(
    c: RamCredentials,
    userName: string,
    userAccessKeyId: string,
  ) {
    try {
      await this.ram(c, 'DeleteAccessKey', { userName, userAccessKeyId });
    } catch (e) {
      if (!ramMissing(e)) throw e;
    }
  }
  /** EAT never creates console login profiles; a missing profile is already safe. */
  async deleteLoginProfile(c: RamCredentials, userName: string) {
    try { await this.ram(c, 'DeleteLoginProfile', { userName }); }
    catch (e) { if (!ramMissing(e)) throw e; }
  }
  /** Only called for a persisted, uniquely named probe user with a matching marker. */
  async deleteProbeUser(
    c: RamCredentials,
    userName: string,
    policyName: string,
    marker: string,
  ) {
    try {
      const user = await this.getUser(c, userName);
      if (user.comments !== marker) throw new Error('测试用户归属不匹配');
      for (const k of await this.keys(c, userName))
        await this.deleteKey(c, userName, k.id);
      if (
        (await this.userPolicies(c, userName)).some(
          (p) => p.name === policyName && p.type === 'Custom',
        )
      )
        await this.detachPolicy(c, userName, policyName);
      await this.deleteUser(c, userName);
    } catch (e) {
      if (!ramMissing(e)) throw e;
    }
    try {
      const policy = await this.getPolicy(c, policyName);
      if (policy.description !== marker) throw new Error('测试策略归属不匹配');
      await this.deletePolicy(c, policyName);
    } catch (e) {
      if (!ramMissing(e)) throw e;
    }
  }
}
