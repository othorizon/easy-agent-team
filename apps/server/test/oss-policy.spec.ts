import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  spacePrefix,
  userPolicy,
  publicStatements,
  mergePublicPolicy,
} from '../src/oss/oss-policy';
import { buildOssTools, buildEatTools, ossToolRequest } from '@eat/shared';

describe('OSS policy and client contract', () => {
  it('scopes list and objects to complete slash-delimited prefixes, permits owner ACL changes', () => {
    const prefix = spacePrefix(randomUUID(), randomUUID(), randomUUID());
    const p = userPolicy('bucket-test', [prefix, prefix]);
    expect(p.Statement[0].Condition).toEqual({
      StringLike: { 'oss:Prefix': [prefix + '*'] },
    });
    expect(p.Statement[1].Resource).toEqual([
      `acs:oss:*:*:bucket-test/${prefix}*`,
    ]);
    expect(p.Statement[1].Action).toContain('oss:PutObjectAcl');
    expect(p.Statement[1].Action).not.toContain('oss:PutBucketPolicy');
    expect(() => spacePrefix('*', randomUUID(), randomUUID())).toThrow();
    expect(userPolicy('bucket-test', []).Statement[0].Effect).toBe('Deny');
  });
  it('preserves unrelated policy rules and recovers both lost additions and removals', () => {
    const foreign = {
      Effect: 'Allow',
      Action: ['oss:GetObject'],
      Principal: ['123'],
      Resource: ['acs:oss:*:*:bucket-test/existing/*'],
    };
    const old = publicStatements('bucket-test', ['eat-storage/old/']),
      next = publicStatements('bucket-test', ['eat-storage/next/']);
    const current = { Version: '1', Statement: [foreign, ...old] };
    expect(mergePublicPolicy(current, old, next, next).Statement).toEqual([
      foreign,
      ...next,
    ]);
    expect(
      mergePublicPolicy(
        { Version: '1', Statement: [foreign, ...next] },
        old,
        next,
        [],
      ).Statement,
    ).toEqual([foreign]);
    expect(
      mergePublicPolicy({ Version: '1', Statement: [foreign] }, old, [], next)
        .Statement,
    ).toEqual([foreign, ...next]);
    expect(() =>
      mergePublicPolicy({ Version: '1', Statement: [foreign] }, old, null, []),
    ).toThrow('已在云端被修改');
    expect(() =>
      userPolicy(
        'bucket-test',
        Array.from({ length: 100 }, () =>
          spacePrefix(randomUUID(), randomUUID(), randomUUID()),
        ),
      ),
    ).toThrow('容量不足');
  });
  it('registers every OSS tool once and validates identifiers and boolean inputs', () => {
    const names = buildEatTools('remote').map((t) => t.name);
    for (const t of buildOssTools())
      expect(names.filter((n) => n === t.name)).toHaveLength(1);
    expect(() =>
      ossToolRequest(
        'get_oss_space',
        { space: '../credentials' },
        randomUUID(),
      ),
    ).toThrow();
    expect(() =>
      ossToolRequest(
        'set_oss_space_public_read',
        { space: randomUUID(), enabled: 'false' },
        randomUUID(),
      ),
    ).toThrow();
    const id = randomUUID();
    expect(
      ossToolRequest(
        'request_oss_space',
        { name: 'Docs', purpose: 'Manual', requestId: id },
        randomUUID(),
      ).body,
    ).toEqual({ name: 'Docs', purpose: 'Manual', requestId: id });
  });
});
