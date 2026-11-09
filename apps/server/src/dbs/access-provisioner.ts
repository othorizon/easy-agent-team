import type { Client } from 'pg';
import { allowSetRole, q, withAdmin, type AdminConn } from './provisioner';

export interface AccessDatabase {
  id: string;
  dbName: string;
  creatorRole: string;
  schemas: string[];
  readRole: string;
  writeRole: string;
}

/** 所有角色都有来源标记。失败重试只复用本记录创建的角色，不接管同名资源。 */
async function ensureRole(c: Client, name: string, marker: string, password?: string): Promise<void> {
  const { rows: [existing] } = await c.query("select shobj_description(oid,'pg_authid') marker from pg_roles where rolname=$1", [name]);
  if (existing) {
    if (existing.marker !== marker) throw new Error(`角色 ${name} 已存在且不是本记录创建的，EAT 不会接管；请管理员核对同名角色。`);
    return;
  }
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  await c.query(`create role ${q(name)} ${password ? `login inherit password ${literal(password)}` : 'nologin'}`);
  await c.query(`comment on role ${q(name)} is ${literal(marker)}`);
}

/** 目标端事务同时提交角色、权限与来源标记；不会留下半套授权。 */
async function transaction<T>(conn: AdminConn, database: string, fn: (c: Client) => Promise<T>, guard: () => void): Promise<T> {
  return withAdmin(conn, database, async c => {
    await c.query('begin');
    try { guard(); const result = await fn(c); guard(); await c.query('commit'); return result; }
    catch (e) { await c.query('rollback'); throw e; }
  });
}

export async function openPostgresAccess(conn: AdminConn, d: AccessDatabase, guard: () => void): Promise<void> {
  // 维护库负责集群角色。管理账号通过只读组取得 CONNECT，才能在已收紧的库上安全重试。
  await transaction(conn, 'postgres', async c => {
    await ensureRole(c, d.readRole, `eat:db-catalog:${d.id}:read`);
    await ensureRole(c, d.writeRole, `eat:db-catalog:${d.id}:write`);
    await allowSetRole(c, d.creatorRole, conn.adminUser);
    const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
    await c.query(`grant ${q(d.readRole)} to ${q(conn.adminUser)}${version >= 160000 ? ' with inherit true, set false' : ''}`);
  }, guard);
  await transaction(conn, d.dbName, async c => {
    await c.query(`set local role ${q(d.creatorRole)}`);
    await c.query(`revoke connect on database ${q(d.dbName)} from public`);
    await c.query('revoke create on schema public from public');
    await c.query(`grant connect on database ${q(d.dbName)} to ${q(d.readRole)}, ${q(d.writeRole)}`);
    for (const name of d.schemas) {
      await c.query(`grant usage on schema ${q(name)} to ${q(d.readRole)}, ${q(d.writeRole)}`);
      await c.query(`grant select on all tables in schema ${q(name)} to ${q(d.readRole)}, ${q(d.writeRole)}`);
      await c.query(`alter default privileges for role ${q(d.creatorRole)} in schema ${q(name)} grant select on tables to ${q(d.readRole)}, ${q(d.writeRole)}`);
    }
  }, guard);
}

export async function grantPostgresRead(conn: AdminConn, d: AccessDatabase, identity: { id: string; roleName: string; password: string }, guard: () => void): Promise<void> {
  await transaction(conn, 'postgres', async c => {
    await ensureRole(c, identity.roleName, `eat:db-personal-role:${identity.id}`, identity.password);
    await allowSetRole(c, identity.roleName, conn.adminUser);
    await c.query(`grant ${q(d.readRole)} to ${q(identity.roleName)}`);
  }, guard);
}

export async function revokePostgresAccess(conn: AdminConn, d: AccessDatabase, identity: { id: string; roleName: string }, guard: () => void): Promise<void> {
  const { roleName } = identity;
  const exists = await transaction(conn, 'postgres', async c => {
    const { rows: [role] } = await c.query("select shobj_description(oid,'pg_authid') marker from pg_roles where rolname=$1", [roleName]);
    if (!role) return false;
    if (role.marker !== `eat:db-personal-role:${identity.id}`) throw new Error(`个人角色 ${roleName} 来源不明，EAT 不会修改；请管理员核对。`);
    await c.query(`revoke ${q(d.readRole)}, ${q(d.writeRole)} from ${q(roleName)}`);
    return true;
  }, guard);
  if (!exists) return;
  // 成员关系必须先提交再断会话，重连不能继续沿用旧权限。
  await withAdmin(conn, 'postgres', async c => {
    guard();
    await allowSetRole(c, roleName, conn.adminUser);
    await c.query(`set role ${q(roleName)}`);
    await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and usename=$2 and pid<>pg_backend_pid()', [d.dbName, roleName]);
  });
}
