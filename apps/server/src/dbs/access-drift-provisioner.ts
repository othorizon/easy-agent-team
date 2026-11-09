import type { Client } from 'pg';
import type { DbAccessDrift } from '@eat/shared';
import { revokeAccessMemberships, type AccessDatabase } from './access-provisioner';
import { q, withAdmin, type AdminConn } from './provisioner';
export interface ExpectedDbMember { role: string; groups: string[]; marker?: string }
async function inspect(c: Client, conn: AdminConn, d: AccessDatabase, desired: ExpectedDbMember[]): Promise<DbAccessDrift> {
  const groups = [d.readRole,d.writeRole];
  const { rows: roles } = await c.query<{ name: string; marker: string }>("select rolname name,shobj_description(oid,'pg_authid') marker from pg_roles where rolname=any($1::text[])",[groups]);
  for (const [i,group] of groups.entries()) if (roles.find(r => r.name===group)?.marker !== `eat:db-catalog:${d.id}:${i===0?'read':'write'}`) throw new Error(`组角色 ${group} 缺失或来源不明，请管理员先核对配置`);
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  const { rows: actual } = await c.query<{ role: string; group: string; administrative: boolean }>(`select m.rolname role,r.rolname "group",${version>=160000?'a.admin_option and not a.inherit_option and not a.set_option':'false'} administrative from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member where r.rolname=any($1::text[]) order by m.rolname,r.rolname`,[groups]);
  const expected = new Map(desired.map(m => [m.role,m.groups]));
  if (d.source !== 'external') expected.set(conn.adminUser,[d.readRole]);
  const relevant = actual.filter(m => !(m.role===conn.adminUser && m.administrative));
  const members = [...new Set([...expected.keys(),...relevant.map(m=>m.role)])].sort().map(role => {
    const want = [...(expected.get(role)??[])].sort(), have = [...new Set(relevant.filter(m=>m.role===role).map(m=>m.group))].sort();
    return { role,expected:want,actual:have,missing:want.filter(g=>!have.includes(g)),extra:have.filter(g=>!want.includes(g)) };
  });
  return { checkedAt:new Date().toISOString(),consistent:members.every(m=>!m.missing.length&&!m.extra.length),error:null,members };
}
export async function inspectPostgresAccess(conn: AdminConn, d: AccessDatabase, desired: ExpectedDbMember[]): Promise<DbAccessDrift> {
  return withAdmin(conn,'postgres',c=>inspect(c,conn,d,desired));
}
export async function repairPostgresAccess(conn: AdminConn, d: AccessDatabase, desired: ExpectedDbMember[], guard:()=>void): Promise<DbAccessDrift> {
  const before = await withAdmin(conn,'postgres',async c => {
    await c.query('begin');
    try {
      const state = await inspect(c,conn,d,desired);
      // 修复只能恢复已有受管身份；来源不明/缺失的个人角色须先由授予入口处理。
      for (const member of desired.filter(m=>m.groups.length)) {
        const { rows:[role] }=await c.query("select shobj_description(oid,'pg_authid') marker from pg_roles where rolname=$1",[member.role]);
        if (!role || role.marker!==member.marker) throw new Error(`个人角色 ${member.role} 缺失或来源不明，请先重试授权`);
      }
      const version=Number((await c.query('show server_version_num')).rows[0].server_version_num);
      for (const member of state.members) {
        for (const group of member.missing) {
          guard(); await c.query(`grant ${q(group)} to ${q(member.role)}${version>=160000 ? member.role===conn.adminUser ? ' with inherit true, set false' : ' with inherit true, set true' : ''}`);
        }
        for (const group of member.extra) { guard(); await revokeAccessMemberships(c,[group],member.role); }
      }
      const after=await inspect(c,conn,d,desired);
      if (!after.consistent) throw new Error('未能撤掉由其他管理身份授予的成员关系，请 DBA 先撤销后重试；本次修复已回滚');
      guard(); await c.query('commit'); return state;
    } catch(e) { await c.query('rollback'); throw e; }
  });
  // 降级/撤掉成员后按实际角色和当前库断会话，保留同实例其他库与owner服务连接。
  for (const member of before.members.filter(m=>m.extra.length&&m.role!==conn.adminUser)) await withAdmin(conn,'postgres',async c=> {
    guard();
    // 只有能SET的角色才可安全终止；不额外取得外部非EAT身份的成员关系。
    const version=Number((await c.query('show server_version_num')).rows[0].server_version_num);
    if ((await c.query('select pg_has_role(current_user,$1,$2) ok',[member.role,version>=160000?'SET':'MEMBER'])).rows[0].ok) await c.query(`set role ${q(member.role)}`);
    guard(); await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and usename=$2 and pid<>pg_backend_pid()',[d.dbName,member.role]);
  });
  guard(); return inspectPostgresAccess(conn,d,desired);
}
