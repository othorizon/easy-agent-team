import type { Client } from 'pg';
import type { DbMembershipOptions } from '@eat/shared';
import { q } from './provisioner';

export interface AccessMembership {
  role: string;
  group: string;
  grantor: string;
  options: DbMembershipOptions;
}
export async function accessMemberships(c: Client, groups: string[]): Promise<AccessMembership[]> {
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  const { rows } = await c.query<{ role: string; group: string; grantor: string; admin: boolean; inherit: boolean | null; set: boolean | null }>(`
    select m.rolname role,r.rolname "group",g.rolname grantor,a.admin_option admin,
      ${version >= 160000 ? 'a.inherit_option inherit,a.set_option set' : 'null::boolean inherit,null::boolean set'}
    from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor
    where r.rolname=any($1::text[]) order by m.rolname,r.rolname,g.rolname`, [groups]);
  return rows.map(({ role, group, grantor, admin, inherit, set }) => ({ role, group, grantor, options: { admin, inherit, set } }));
}
export function administrativeMembership(m: AccessMembership): boolean {
  return m.options.admin && m.options.inherit === false && m.options.set === false;
}
export function expectedMembershipOptions(m: AccessMembership, management: boolean): DbMembershipOptions {
  // Management keeps ADMIN authority and the EAT database's inherited CONNECT path.
  return { admin: management ? m.options.admin : false, inherit: m.options.inherit === null ? null : true, set: m.options.set === null ? null : !management };
}
export function membershipOptionsDiffer(actual: DbMembershipOptions, expected: DbMembershipOptions): boolean {
  return actual.admin !== expected.admin || actual.inherit !== expected.inherit || actual.set !== expected.set;
}

/** Explicit give/replay and repair share this norm. Inspection never calls it. Caller owns the transaction. */
export async function normalizeAccessMembership(c: Client, group: string, member: string, management = false): Promise<void> {
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  const memberships = (await accessMemberships(c, [group])).filter(m => m.role === member && !(management && administrativeMembership(m)));
  for (const m of memberships) {
    const expected = expectedMembershipOptions(m, management);
    if (!membershipOptionsDiffer(m.options, expected)) continue;
    const grantor = version >= 160000 ? ` granted by ${q(m.grantor)}` : '';
    const statements: string[] = [];
    // GRANT ... ADMIN FALSE does not enforce REVOKE's dependent-grant check on PG16.
    // Explicit RESTRICT must succeed before normalizing the remaining options.
    if (m.options.admin && !expected.admin) statements.push(`revoke admin option for ${q(group)} from ${q(member)}${grantor} restrict`);
    if (version >= 160000) statements.push(`grant ${q(group)} to ${q(member)} with admin ${expected.admin}, inherit true, set ${expected.set}${grantor}`);
    const sql = `${statements.join('; ')};`;
    if (version >= 160000 && !(await c.query("select pg_has_role(current_user,$1,'SET') ok", [m.grantor])).rows[0].ok)
      throw new Error(`成员选项由 ${m.grantor} 授予，管理角色不能代为修改；本次事务已回滚。请 DBA 执行：${sql} 然后重试`);
    try { for (const statement of statements) await c.query(statement); }
    catch (e) {
      // ADMIN removal defaults to RESTRICT: dependent grants must be reviewed by a DBA, never CASCADE.
      throw new Error(`成员选项修复失败（${m.grantor}）：${(e as Error).message}；本次事务已回滚。请 DBA 先核对依赖授予，再执行：${sql} 然后重试`);
    }
  }
  if (!memberships.length) {
    await c.query(`grant ${q(group)} to ${q(member)}${version >= 160000 ? ` with ${management ? '' : 'admin false, '}inherit true, set ${!management}` : ''}`);
  }
}
