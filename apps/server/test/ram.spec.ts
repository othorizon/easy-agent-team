import { afterEach, describe, it, expect, vi } from 'vitest';
import RamClient from '@alicloud/ram20150501';
import { RamCloud } from '../src/ram/ram-cloud';

afterEach(() => vi.restoreAllMocks());
import { TestRamCloud } from './ram-fixture';

const management = {
  accessKeyId: 'management-test',
  accessKeySecret: 'management-test-secret',
};

describe('RAM adapter', () => {
  it('deletes a manual console login profile idempotently without changing keys or policies', async () => {
    const ram = new TestRamCloud();
    await ram.ensureUser(management, 'eat-person', 'EAT person');
    const key = await ram.createKey(management, 'eat-person');
    ram.setConsoleLogin(management, 'eat-person', true);
    await ram.deleteLoginProfile(management, 'eat-person');
    await ram.deleteLoginProfile(management, 'eat-person');
    expect(ram.hasConsoleLogin(management, 'eat-person')).toBe(false);
    expect(await ram.keys(management, 'eat-person')).toEqual([{ id: key.id, status: 'Active' }]);
  });
  it('allows only two AccessKeys per RAM user, including inactive keys', async () => {
    const ram = new TestRamCloud();
    await ram.ensureUser(management, 'eat-person', 'EAT person');
    const first = await ram.createKey(management, 'eat-person');
    await ram.keyStatus(management, 'eat-person', first.id, false);
    await ram.createKey(management, 'eat-person');
    await expect(ram.createKey(management, 'eat-person')).rejects.toMatchObject(
      {
        code: 'LimitExceeded.AccessKey',
        kind: 'quota',
      },
    );
    expect(await ram.keys(management, 'eat-person')).toEqual([
      { id: first.id, status: 'Inactive' },
      { id: 'test-key-2', status: 'Active' },
    ]);
  });
  it('renames a personal identity without changing its UserId or AccessKeys', async () => {
    const ram = new TestRamCloud();
    await ram.ensureUser(management, 'old-oss-name', 'EAT person');
    const before = await ram.getUser(management, 'old-oss-name');
    const key = await ram.createKey(management, 'old-oss-name');
    await ram.updateUser(management, 'old-oss-name', {
      name: 'eat-person',
      displayName: 'Member',
      comments: 'EAT person member@example.test',
    });
    expect(await ram.getUser(management, 'eat-person')).toEqual({
      id: before.id,
      name: 'eat-person',
      displayName: 'Member',
      comments: 'EAT person member@example.test',
    });
    expect(await ram.keys(management, 'eat-person')).toEqual([
      { id: key.id, status: 'Active' },
    ]);
    expect(
      await ram.callerAccount({
        accessKeyId: key.id,
        accessKeySecret: key.secret,
      }),
    ).toBe('account-test');
    await expect(ram.getUser(management, 'old-oss-name')).rejects.toMatchObject(
      { kind: 'missing' },
    );
  });

  it('pages through custom policies and returns their description and exact current document', async () => {
    const ram = new TestRamCloud();
    const document =
      '{ "Version": "1", "Statement": [{ "Effect": "Allow", "Action": "oss:GetObject", "Resource": "*" }] }';
    for (const name of ['eat-perm-a', 'eat-perm-b', 'eat-perm-c'])
      await ram.createPolicy(management, name, `Description ${name}`, document);
    const first = await ram.listPolicies(management, { maxItems: 2 });
    expect(first.policies).toEqual([
      {
        name: 'eat-perm-a',
        type: 'Custom',
        description: 'Description eat-perm-a',
      },
      {
        name: 'eat-perm-b',
        type: 'Custom',
        description: 'Description eat-perm-b',
      },
    ]);
    expect(first.nextMarker).toBeTruthy();
    const second = await ram.listPolicies(management, {
      maxItems: 2,
      marker: first.nextMarker,
    });
    expect(second).toEqual({
      policies: [
        {
          name: 'eat-perm-c',
          type: 'Custom',
          description: 'Description eat-perm-c',
        },
      ],
      nextMarker: undefined,
    });
    expect(await ram.getPolicy(management, 'eat-perm-b')).toEqual({
      name: 'eat-perm-b',
      type: 'Custom',
      description: 'Description eat-perm-b',
      document,
    });
  });

  it('limits each user to ten custom policy bindings and releases quota on detach', async () => {
    const ram = new TestRamCloud();
    await ram.ensureUser(management, 'eat-person', 'EAT person');
    for (let i = 0; i < 11; i++)
      await ram.createPolicy(
        management,
        `eat-perm-${i}`,
        'Permission',
        '{"Version":"1","Statement":[]}',
      );
    for (let i = 0; i < 10; i++)
      await ram.attachPolicy(management, 'eat-person', `eat-perm-${i}`);
    await ram.attachPolicy(management, 'eat-person', 'eat-perm-0');
    await expect(
      ram.attachPolicy(management, 'eat-person', 'eat-perm-10'),
    ).rejects.toMatchObject({ kind: 'quota' });
    await ram.detachPolicy(management, 'eat-person', 'eat-perm-0');
    await ram.attachPolicy(management, 'eat-person', 'eat-perm-10');
    expect(
      (await ram.userPolicies(management, 'eat-person'))
        .map((p) => p.name)
        .sort(),
    ).toEqual([
      'eat-perm-1',
      'eat-perm-10',
      'eat-perm-2',
      'eat-perm-3',
      'eat-perm-4',
      'eat-perm-5',
      'eat-perm-6',
      'eat-perm-7',
      'eat-perm-8',
      'eat-perm-9',
    ]);
  });

  it('requires detaching policies and deleting keys before deleting cloud resources', async () => {
    const ram = new TestRamCloud();
    await ram.ensureUser(management, 'eat-person', 'EAT person');
    const key = await ram.createKey(management, 'eat-person');
    await expect(
      ram.deleteUser(management, 'eat-person'),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await ram.createPolicy(
      management,
      'eat-perm-a',
      'Permission',
      '{"Version":"1","Statement":[]}',
    );
    await ram.attachPolicy(management, 'eat-person', 'eat-perm-a');
    await expect(
      ram.deletePolicy(management, 'eat-perm-a'),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(
      ram.deleteUser(management, 'eat-person'),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await ram.deleteKey(management, 'eat-person', key.id);
    await expect(
      ram.deleteUser(management, 'eat-person'),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await ram.detachPolicy(management, 'eat-person', 'eat-perm-a');
    await ram.deletePolicy(management, 'eat-perm-a');
    await ram.deleteUser(management, 'eat-person');
    await expect(ram.getUser(management, 'eat-person')).rejects.toMatchObject({
      kind: 'missing',
    });
    await expect(ram.getPolicy(management, 'eat-perm-a')).rejects.toMatchObject(
      { kind: 'missing' },
    );
  });

  it('uses the management credentials on each call and isolates cloud accounts', async () => {
    const ram = new TestRamCloud();
    const other = {
      accessKeyId: 'other-management',
      accessKeySecret: 'other-secret',
    };
    ram.registerAccount(other, 'other-account');
    await ram.ensureUser(management, 'eat-person', 'First cloud');
    await expect(ram.getUser(other, 'eat-person')).rejects.toMatchObject({
      kind: 'missing',
    });
    await ram.ensureUser(other, 'eat-person', 'Second cloud');
    expect((await ram.getUser(management, 'eat-person')).comments).toBe(
      'First cloud',
    );
    expect((await ram.getUser(other, 'eat-person')).comments).toBe(
      'Second cloud',
    );
    expect(await ram.callerAccount(management)).toBe('account-test');
    expect(await ram.callerAccount(other)).toBe('other-account');
    await expect(
      ram.keys({ ...management, accessKeySecret: 'incorrect' }, 'eat-person'),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it.each([
    ['LimitExceeded.UserPolicy', 'quota'],
    ['EntityNotExist.User', 'missing'],
    ['Forbidden.RAM', 'forbidden'],
    ['ECONNRESET', 'network'],
    ['SDK.TimeoutError', 'network'],
  ])(
    'turns provider %s into a sanitized %s domain error',
    async (code, kind) => {
      vi.spyOn(RamClient.prototype, 'createAccessKey').mockRejectedValue({
        code,
        message: `The request contained secret ${management.accessKeySecret}`,
      });
      const result = await new RamCloud()
        .createKey(management, 'eat-person')
        .catch((e) => e);
      expect(result).toMatchObject({ code, kind });
      expect(result.message).not.toContain(management.accessKeySecret);
    },
  );
});
