import type { Client } from 'pg';
import type { DbAccessLevel } from '@eat/shared';
import { allowSetRole, q, withAdmin, type AdminConn } from './provisioner';

export interface AccessDatabase {
  id: string;
  dbName: string;
  creatorRole: string | null;
  source?: 'eat' | 'external';
  schemas: string[];
  readRole: string;
  writeRole: string;
}

/** 所有角色都有来源标记。失败重试只复用本记录创建的角色，不接管同名资源。 */
export async function ensureAccessRole(c: Client, name: string, marker: string, password?: string): Promise<void> {
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
  if (!d.creatorRole || d.source === 'external') throw new Error('EAT 建库授权需要 owner 角色，外部库必须使用独立执行器');
  const creatorRole = d.creatorRole;
  // 维护库负责集群角色。管理账号通过只读组取得 CONNECT，才能在已收紧的库上安全重试。
  await transaction(conn, 'postgres', async c => {
    await ensureAccessRole(c, d.readRole, `eat:db-catalog:${d.id}:read`);
    await ensureAccessRole(c, d.writeRole, `eat:db-catalog:${d.id}:write`);
    await allowSetRole(c, creatorRole, conn.adminUser);
    const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
    await c.query(`grant ${q(d.readRole)} to ${q(conn.adminUser)}${version >= 160000 ? ' with inherit true, set false' : ''}`);
  }, guard);
  await transaction(conn, d.dbName, async c => {
    await c.query(`set local role ${q(creatorRole)}`);
    await c.query(`revoke connect on database ${q(d.dbName)} from public`);
    await c.query('revoke create on schema public from public');
    await c.query(`grant connect on database ${q(d.dbName)} to ${q(d.readRole)}, ${q(d.writeRole)}`);
    await applySchemaAccess(c, conn, d);
  }, guard);
}

/** 按目标端 ACL 找出旧范围，崩溃后只需持久化新的 schema 列表即可恢复清理。 */
export async function applySchemaAccess(c: Client, conn: AdminConn, d: AccessDatabase): Promise<void> {
  const groups = [d.readRole, d.writeRole];
  const { rows: namespaces } = await c.query<{ name: string; owner: string }>(`
    select n.nspname name, case when pg_get_userbyid(n.nspowner)='pg_database_owner' then (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) else pg_get_userbyid(n.nspowner) end owner from pg_namespace n
    where n.nspname=any($1::text[])
       or exists(select 1 from aclexplode(n.nspacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($2::text[]))
       or exists(select 1 from pg_class t cross join lateral aclexplode(t.relacl) a join pg_roles r on r.oid=a.grantee where t.relnamespace=n.oid and r.rolname=any($2::text[]))
       or exists(select 1 from pg_default_acl p cross join lateral aclexplode(p.defaclacl) a join pg_roles r on r.oid=a.grantee where p.defaclnamespace=n.oid and r.rolname=any($2::text[]))
  `, [d.schemas, groups]);
  for (const name of d.schemas) {
    if (!namespaces.some(n => n.name === name)) throw new Error(`schema ${name} 不存在，请先创建后重新应用授权`);
  }
  const roles = groups.map(q).join(', ');
  for (const ns of namespaces) {
    const included = d.schemas.includes(ns.name);
    await assumeObjectOwner(c, conn, ns.owner, d.source === 'external');
    await c.query(`revoke all privileges on schema ${q(ns.name)} from ${roles}`);
    if (included) await c.query(`grant usage on schema ${q(ns.name)} to ${roles}`);

    // 使用各对象的实际 owner，避免 ALL TABLES 对其他建表角色仅给 warning 而漏授权。
    const { rows: objects } = await c.query<{ name: string; owner: string; kind: string }>(`
      select t.relname name, pg_get_userbyid(t.relowner) owner, t.relkind kind
      from pg_class t join pg_namespace n on n.oid=t.relnamespace
      where n.nspname=$1 and t.relkind in ('r','p','v','m','f','S') order by t.oid
    `, [ns.name]);
    for (const object of objects) {
      await assumeObjectOwner(c, conn, object.owner, d.source === 'external');
      const kind = object.kind === 'S' ? 'sequence' : 'table';
      const identifier = `${q(ns.name)}.${q(object.name)}`;
      await c.query(`revoke all privileges on ${kind} ${identifier} from ${roles}`);
      if (!included) continue;
      if (kind === 'sequence') await c.query(`grant usage, select on sequence ${identifier} to ${q(d.writeRole)}`);
      else {
        await c.query(`grant select on table ${identifier} to ${roles}`);
        await c.query(`grant insert, update, delete on table ${identifier} to ${q(d.writeRole)}`);
      }
    }
    const { rows: defaults } = await c.query<{ owner: string }>(`
      select distinct pg_get_userbyid(p.defaclrole) owner from pg_default_acl p
      join pg_namespace n on n.oid=p.defaclnamespace
      cross join lateral aclexplode(p.defaclacl) a join pg_roles r on r.oid=a.grantee
      where n.nspname=$1 and r.rolname=any($2::text[])
    `, [ns.name, groups]);
    for (const owner of new Set([...(d.creatorRole ? [d.creatorRole] : []), ...defaults.map(p => p.owner)])) {
      await assumeObjectOwner(c, conn, owner, d.source === 'external');
      const base = `alter default privileges for role ${q(owner)} in schema ${q(ns.name)}`;
      await c.query(`${base} revoke all privileges on tables from ${roles}`);
      await c.query(`${base} revoke all privileges on sequences from ${roles}`);
      if (!included || owner !== d.creatorRole) continue;
      await c.query(`${base} grant select on tables to ${roles}`);
      await c.query(`${base} grant insert, update, delete on tables to ${q(d.writeRole)}`);
      await c.query(`${base} grant usage, select on sequences to ${q(d.writeRole)}`);
    }
  }
}

async function assumeObjectOwner(c: Client, conn: AdminConn, owner: string, external = false): Promise<void> {
  await c.query('reset role');
  if (owner === conn.adminUser) return;
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  const { rows: [membership] } = await c.query('select pg_has_role(current_user,$1,$2) allowed', [owner, version >= 160000 ? 'SET' : 'MEMBER']);
  if (!membership.allowed) {
    // 外部库已检查管理角色的 GRANT OPTION，不替 DBA 添加外部 owner 成员关系。
    if (external) return;
    await allowSetRole(c, owner, conn.adminUser);
  }
  await c.query(`set local role ${q(owner)}`);
}

export async function grantPostgresAccess(conn: AdminConn, d: AccessDatabase, level: DbAccessLevel, identity: { id: string; roleName: string; password: string }, guard: () => void): Promise<void> {
  await transaction(conn, 'postgres', async c => {
    await ensureAccessRole(c, identity.roleName, `eat:db-personal-role:${identity.id}`, identity.password);
    await allowSetRole(c, identity.roleName, conn.adminUser);
    const desired = level === 'write' ? d.writeRole : d.readRole;
    const previous = level === 'write' ? d.readRole : d.writeRole;
    // 先加入新组，再退出旧组；同一目标事务保证重试没有权限空窗。
    await c.query(`grant ${q(desired)} to ${q(identity.roleName)}`);
    await revokeAccessMemberships(c,[previous],identity.roleName);
  }, guard);
  // 只读执行包含崩溃后的重放：即使旧写组已退出，也必须补完断会话。
  if (level === 'read') await terminatePostgresAccessSessions(conn, d.dbName, identity.roleName, guard);
}

/** PG16成员关系按grantor分别存储，默认REVOKE会静默保留其他grantor的授予。 */
export async function revokeAccessMemberships(c: Client, groups: string[], member: string): Promise<void> {
  const version=Number((await c.query('show server_version_num')).rows[0].server_version_num);
  const { rows: memberships }=await c.query<{ parent:string; grantor:string }>(`select r.rolname parent,g.rolname grantor from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor where r.rolname=any($1::text[]) and m.rolname=$2`,[groups,member]);
  for (const m of memberships) {
    const statement=`revoke ${q(m.parent)} from ${q(member)}${version>=160000?` granted by ${q(m.grantor)}`:''}`;
    if (version>=160000 && !(await c.query("select pg_has_role(current_user,$1,'SET') ok",[m.grantor])).rows[0].ok) throw new Error(`成员关系由 ${m.grantor} 授予，管理角色不能代为撤销；请 DBA 执行：${statement}; 然后重试`);
    await c.query(statement);
  }
  const { rowCount }=await c.query('select 1 from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member where r.rolname=any($1::text[]) and m.rolname=$2',[groups,member]);
  if (rowCount) throw new Error(`角色 ${member} 的组成员关系尚未撤净，请 DBA 核对后重试`);
}

export async function revokePostgresAccess(conn: AdminConn, d: AccessDatabase, identity: { id: string; roleName: string }, guard: () => void): Promise<void> {
  const { roleName } = identity;
  const exists = await transaction(conn, 'postgres', async c => {
    const { rows: [role] } = await c.query("select shobj_description(oid,'pg_authid') marker from pg_roles where rolname=$1", [roleName]);
    if (!role) return false;
    if (role.marker !== `eat:db-personal-role:${identity.id}`) throw new Error(`个人角色 ${roleName} 来源不明，EAT 不会修改；请管理员核对。`);
    await revokeAccessMemberships(c,[d.readRole,d.writeRole],roleName);
    return true;
  }, guard);
  if (!exists) return;
  // 成员关系必须先提交再断会话，重连不能继续沿用旧权限。
  await terminatePostgresAccessSessions(conn, d.dbName, roleName, guard);
}

async function terminatePostgresAccessSessions(conn: AdminConn, dbName: string, roleName: string, guard: () => void): Promise<void> {
  await withAdmin(conn, 'postgres', async c => {
    guard();
    await allowSetRole(c, roleName, conn.adminUser);
    await c.query(`set role ${q(roleName)}`);
    guard();
    await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and usename=$2 and pid<>pg_backend_pid()', [dbName, roleName]);
    guard();
  });
}
