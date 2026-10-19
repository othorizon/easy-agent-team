/** Policies contain identifiers only, never credentials. */
export interface OssStatement {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Principal?: string | string[];
  Condition?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface OssPolicy {
  Version: string;
  Statement: OssStatement[];
  [key: string]: unknown;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function spacePrefix(instance: string, user: string, space: string) {
  for (const id of [instance, user, space])
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('非法资源 ID');
  return `eat-storage/${instance}/${user}/${space}/`;
}
export function userPolicy(bucket: string, prefixes: string[]): OssPolicy {
  const paths = [...new Set(prefixes)].sort();
  // An empty grant is represented by a harmless explicit deny, not a wildcard grant.
  if (!paths.length)
    return {
      Version: '1',
      Statement: [{ Effect: 'Deny', Action: 'oss:*', Resource: '*' }],
    };
  const p: OssPolicy = {
    Version: '1',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['oss:ListObjects'],
        Resource: [`acs:oss:*:*:${bucket}`],
        Condition: { StringLike: { 'oss:Prefix': paths.map((x) => `${x}*`) } },
      },
      {
        Effect: 'Allow',
        Action: [
          'oss:GetObject',
          'oss:PutObject',
          'oss:DeleteObject',
          'oss:GetObjectAcl',
          'oss:PutObjectAcl',
          'oss:ListParts',
          'oss:AbortMultipartUpload',
        ],
        Resource: paths.map((x) => `acs:oss:*:*:${bucket}/${x}*`),
      },
    ],
  };
  if (Buffer.byteLength(JSON.stringify(p)) > 6144)
    throw new Error('RAM 策略容量不足，无法增加空间；已有授权保持不变');
  return p;
}
export function publicStatements(
  bucket: string,
  prefixes: string[],
): OssStatement[] {
  return prefixes.length
    ? [
        {
          Effect: 'Allow',
          Principal: ['*'],
          Action: ['oss:GetObject'],
          Resource: [...new Set(prefixes)]
            .sort()
            .map((p) => `acs:oss:*:*:${bucket}/${p}*`),
        },
      ]
    : [];
}
/** Accept either the last committed or the journaled pending rule after a lost write response. */
export function mergePublicPolicy(
  current: OssPolicy | null,
  applied: OssStatement[],
  pending: OssStatement[] | null,
  next: OssStatement[],
): OssPolicy {
  const original = current?.Statement ?? [];
  const hasAll = (set: OssStatement[]) =>
    set.every((s) => original.some((v) => canonical(v) === canonical(s)));
  const previous =
    pending && hasAll(pending) && (pending.length > 0 || !hasAll(applied))
      ? pending
      : applied;
  if (!hasAll(previous))
    throw new Error(
      'EAT 管理的 Bucket Policy 已在云端被修改，请恢复受管规则后重试',
    );
  const owned = new Set(previous.map(canonical));
  const result: OssPolicy = {
    ...(current ?? {}),
    Version: current?.Version ?? '1',
    Statement: [...original.filter((s) => !owned.has(canonical(s))), ...next],
  };
  if (Buffer.byteLength(JSON.stringify(result)) >= 16 * 1024)
    throw new Error('Bucket Policy 容量不足，已有规则保持不变');
  return result;
}
