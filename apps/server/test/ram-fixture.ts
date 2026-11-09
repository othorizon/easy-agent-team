import {
  RamCloud,
  RamCloudError,
  type RamCredentials,
} from '../src/ram/ram-cloud';

type Raw = Record<string, any>;
export interface TestRamUser {
  userName: string;
  userId: string;
  comments: string;
  displayName: string;
  attached: Set<string>;
  keys: { id: string; secret: string; status: string }[];
}

/** In-memory RAM transport: the real adapter's public interface and ownership checks still run. */
export class TestRamCloud extends RamCloud {
  private accounts = new Map<
    string,
    {
      users: Map<string, TestRamUser>;
      policies: Map<
        string,
        {
          policyName: string;
          policyType: 'Custom' | 'System';
          description: string;
          document: string;
          versions: Map<string, string>;
          versionSerial: number;
        }
      >;
    }
  >();
  private credentials = new Map<
    string,
    { secret: string; accountId: string }
  >();
  keySerial = 0;
  private userSerial = 0;
  lostKeyResponse = false;
  failKeyStatus = false;
  failCleanup = false;
  failListPoliciesMarker: string | undefined;
  constructor() {
    super();
    this.registerAccount(
      {
        accessKeyId: 'management-test',
        accessKeySecret: 'management-test-secret',
      },
      'account-test',
    );
  }
  reset() {
    for (const account of this.accounts.values()) {
      account.users.clear();
      account.policies.clear();
    }
    this.credentials.clear();
    this.registerAccount(
      {
        accessKeyId: 'management-test',
        accessKeySecret: 'management-test-secret',
      },
      'account-test',
    );
    this.keySerial = this.userSerial = 0;
    this.lostKeyResponse = this.failKeyStatus = this.failCleanup = false;
    this.failListPoliciesMarker = undefined;
  }
  isManagement(c: RamCredentials): boolean {
    return this.credentials.get(c.accessKeyId)?.secret === c.accessKeySecret;
  }
  /** OSS data-plane fixture uses the very same identities, keys and bindings. */
  documentsForKey(c: RamCredentials): unknown[] {
    for (const account of this.accounts.values()) {
      const user = [...account.users.values()].find((u) =>
        u.keys.some(
          (k) =>
            k.id === c.accessKeyId &&
            k.secret === c.accessKeySecret &&
            k.status === 'Active',
        ),
      );
      if (user)
        return [...user.attached].map((name) =>
          JSON.parse(account.policies.get(name)!.document),
        );
    }
    return [];
  }
  registerAccount(c: RamCredentials, accountId: string) {
    this.credentials.set(c.accessKeyId, {
      secret: c.accessKeySecret,
      accountId,
    });
    if (!this.accounts.has(accountId))
      this.accounts.set(accountId, { users: new Map(), policies: new Map() });
  }
  private accountId(c: RamCredentials): string {
    const credential = this.credentials.get(c.accessKeyId);
    if (!credential || credential.secret !== c.accessKeySecret)
      throw new RamCloudError('RAM management credentials', 'AccessDenied');
    return credential.accountId;
  }
  override async callerAccount(c: RamCredentials) {
    if (this.isManagement(c)) return this.accountId(c);
    for (const [id, account] of this.accounts)
      if (
        [...account.users.values()].some((u) =>
          u.keys.some(
            (k) =>
              k.id === c.accessKeyId &&
              k.secret === c.accessKeySecret &&
              k.status === 'Active',
          ),
        )
      )
        return id;
    throw new RamCloudError('STS GetCallerIdentity', 'InvalidAccessKeyId');
  }
  get users() {
    return this.accounts.get('account-test')!.users;
  }
  get policies() {
    return this.accounts.get('account-test')!.policies;
  }
  protected override async ram(
    c: RamCredentials,
    action: string,
    args: Raw,
  ): Promise<Raw> {
    const { users, policies } = this.accounts.get(this.accountId(c))!;
    const user = users.get(args.userName);
    if (action === 'CreatePolicy') {
      if (policies.has(args.policyName))
        throw new RamCloudError(action, 'EntityAlreadyExists.Policy');
      policies.set(args.policyName, {
        policyName: args.policyName,
        policyType: 'Custom',
        description: args.description,
        document: args.policyDocument,
        versions: new Map([['v1', args.policyDocument]]),
        versionSerial: 1,
      });
      return {};
    }
    if (action === 'GetPolicy') {
      const policy = policies.get(args.policyName);
      if (!policy) throw new RamCloudError(action, 'EntityNotExist.Policy');
      return {
        policy,
        defaultPolicyVersion: { policyDocument: policy.document },
      };
    }
    if (action === 'ListPolicies') {
      if (this.failListPoliciesMarker !== undefined && args.marker === this.failListPoliciesMarker)
        throw new RamCloudError(action, 'NETWORK_ERROR');
      const rows = [...policies.values()]
        .filter((p) => p.policyType === args.policyType)
        .sort((a, b) => a.policyName.localeCompare(b.policyName));
      const offset = Number(args.marker ?? 0),
        maxItems = args.maxItems ?? 100;
      const isTruncated = offset + maxItems < rows.length;
      return {
        policies: { policy: rows.slice(offset, offset + maxItems) },
        isTruncated,
        marker: isTruncated ? String(offset + maxItems) : undefined,
      };
    }
    if (action === 'ListPolicyVersions') {
      if (!policies.has(args.policyName))
        throw new RamCloudError(action, 'EntityNotExist.Policy');
      const policy = policies.get(args.policyName)!;
      return {
        policyVersions: {
          policyVersion: [...policy.versions.keys()].map((versionId) => ({
            versionId,
            isDefaultVersion: versionId === `v${policy.versionSerial}`,
          })),
        },
      };
    }
    if (action === 'CreatePolicyVersion') {
      const policy = policies.get(args.policyName);
      if (!policy) throw new RamCloudError(action, 'EntityNotExist.Policy');
      if (policy.versions.size >= 5) {
        if (
          args.rotateStrategy !==
          'DeleteOldestNonDefaultVersionWhenLimitExceeded'
        )
          throw new RamCloudError(action, 'LimitExceeded.PolicyVersion');
        policy.versions.delete(policy.versions.keys().next().value!);
      }
      policy.versions.set(`v${++policy.versionSerial}`, args.policyDocument);
      policy.document = args.policyDocument;
      return {};
    }
    if (action === 'DeletePolicyVersion') {
      const policy = policies.get(args.policyName);
      if (!policy || !policy.versions.has(args.versionId))
        throw new RamCloudError(action, 'EntityNotExist.PolicyVersion');
      if (args.versionId === `v${policy.versionSerial}`)
        throw new RamCloudError(action, 'DeleteConflict.PolicyVersion');
      policy.versions.delete(args.versionId);
      return {};
    }
    if (action === 'DeletePolicy') {
      if (!policies.has(args.policyName))
        throw new RamCloudError(action, 'EntityNotExist.Policy');
      if ([...users.values()].some((u) => u.attached.has(args.policyName)))
        throw new RamCloudError(action, 'DeleteConflict.Policy');
      policies.delete(args.policyName);
      return {};
    }
    if (action === 'GetUser') {
      if (!user) throw new RamCloudError(action, 'EntityNotExist.User');
      return { user };
    }
    if (action === 'CreateUser') {
      if (user) throw new RamCloudError(action, 'EntityAlreadyExists.User');
      const created: TestRamUser = {
        userName: args.userName,
        comments: args.comments ?? '',
        displayName: args.displayName ?? '',
        userId: `user-${++this.userSerial}`,
        attached: new Set(),
        keys: [],
      };
      users.set(args.userName, created);
      return { user: created };
    }
    if (!user) throw new RamCloudError(action, 'EntityNotExist.User');
    switch (action) {
      case 'ListPoliciesForUser':
        return {
          policies: {
            policy: [...user.attached].map((name) => policies.get(name)),
          },
        };
      case 'AttachPolicyToUser': {
        const policy = policies.get(args.policyName);
        if (!policy || policy.policyType !== args.policyType)
          throw new RamCloudError(action, 'EntityNotExist.Policy');
        if (user.attached.has(args.policyName)) return {};
        if (
          policy.policyType === 'Custom' &&
          [...user.attached].filter(
            (name) => policies.get(name)?.policyType === 'Custom',
          ).length >= 10
        )
          throw new RamCloudError(action, 'LimitExceeded.Policy');
        user.attached.add(args.policyName);
        return {};
      }
      case 'DetachPolicyFromUser':
        user.attached.delete(args.policyName);
        return {};
      case 'DeleteUser':
        if (user.keys.length || user.attached.size)
          throw new RamCloudError(action, 'DeleteConflict.User');
        if (this.failCleanup) throw new RamCloudError(action, 'AccessDenied');
        users.delete(args.userName);
        return {};
      case 'UpdateUser': {
        if (
          args.newUserName &&
          args.newUserName !== args.userName &&
          users.has(args.newUserName)
        )
          throw new RamCloudError(action, 'EntityAlreadyExists.User');
        users.delete(args.userName);
        user.userName = args.newUserName ?? user.userName;
        user.displayName = args.newDisplayName ?? user.displayName;
        user.comments = args.newComments ?? user.comments;
        users.set(user.userName, user);
        return { user };
      }
      case 'ListAccessKeys':
        return {
          accessKeys: {
            accessKey: user.keys.map((k) => ({
              accessKeyId: k.id,
              status: k.status,
            })),
          },
        };
      case 'CreateAccessKey': {
        if (user.keys.length >= 2)
          throw new RamCloudError(action, 'LimitExceeded.AccessKey');
        const key = {
          id: `test-key-${++this.keySerial}`,
          secret: `test-secret-${this.keySerial}`,
          status: 'Active',
        };
        user.keys.push(key);
        if (this.lostKeyResponse) {
          this.lostKeyResponse = false;
          throw new RamCloudError(action, 'NETWORK_ERROR');
        }
        return {
          accessKey: { accessKeyId: key.id, accessKeySecret: key.secret },
        };
      }
      case 'UpdateAccessKey': {
        if (this.failKeyStatus) throw new RamCloudError(action, 'AccessDenied');
        const key = user.keys.find((k) => k.id === args.userAccessKeyId);
        if (!key) throw new RamCloudError(action, 'EntityNotExist.AccessKey');
        key.status = args.status;
        return {};
      }
      case 'DeleteAccessKey': {
        const key = user.keys.find((k) => k.id === args.userAccessKeyId);
        if (!key) throw new RamCloudError(action, 'EntityNotExist.AccessKey');
        user.keys = user.keys.filter((k) => k.id !== key.id);
        return {};
      }
      default:
        throw new Error(`Unimplemented RAM operation: ${action}`);
    }
  }
}
