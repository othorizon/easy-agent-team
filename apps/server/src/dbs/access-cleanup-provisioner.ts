import type { Client } from 'pg';
import { q, withAdmin, type AdminConn } from './provisioner';

export interface ManagedDbRole { name: string; marker: string }
interface Dependency { role: string; database: string | null; databaseId: number; classId: number; objectId: number; subId: number; kind: string; className: string }
interface AclAction { sql: string; owner: string }

/** 集群级来源/所有权预检在任何 REVOKE 之前完成；不存在的本记录角色视为已清理。 */
async function dependencies(c: Client, roles: ManagedDbRole[]): Promise<Dependency[]> {
  const names = roles.map(r => r.name);
  const { rows: existing } = await c.query<{ name: string; marker: string }>("select rolname name, shobj_description(oid,'pg_authid') marker from pg_roles where rolname=any($1::text[])", [names]);
  for (const r of existing) if (roles.find(x => x.name === r.name)?.marker !== r.marker) throw new Error(`角色 ${r.name} 来源不明，停止删除；请 DBA 核对，EAT 不会接管。`);
  return (await c.query<Dependency>(`select r.rolname role, b.datname database, d.dbid::int "databaseId", d.classid::int "classId", d.objid::int "objectId", d.objsubid "subId", d.deptype kind, d.classid::regclass::text "className"
    from pg_shdepend d join pg_roles r on r.oid=d.refobjid left join pg_database b on b.oid=d.dbid
    where d.refclassid='pg_authid'::regclass and r.rolname=any($1::text[]) order by r.rolname,d.dbid,d.classid,d.objid`, [names])).rows;
}
async function describe(conn: AdminConn, d: Dependency): Promise<string> {
  try { return await withAdmin(conn, d.database ?? 'postgres', async c => (await c.query('select pg_describe_object($1,$2,$3) description', [d.classId, d.objectId, d.subId])).rows[0].description); }
  catch { return `${d.className} OID ${d.objectId}${d.subId ? ` column ${d.subId}` : ''}`; }
}
async function assume(c: Client, conn: AdminConn, owner: string) {
  await c.query('reset role');
  if (owner === conn.adminUser) return;
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  if ((await c.query('select pg_has_role(current_user,$1,$2) ok', [owner, version >= 160000 ? 'SET' : 'MEMBER'])).rows[0].ok) await c.query(`set local role ${q(owner)}`);
  // 否则使用管理员已具备的 GRANT OPTION；剩余依赖会明确阻止 DROP。
}
/** 从实际 ACL 构造精确 REVOKE；不删除对象、不修改 PUBLIC、不使用 CASCADE。 */
async function aclActions(c: Client, names: string[], shared: boolean): Promise<AclAction[]> {
  const actions: AclAction[] = [];
  const add = async (query: string, render: (r: any) => string) => {
    const { rows } = await c.query(query, [names]);
    for (const r of rows) actions.push({ owner: r.owner, sql: render(r) });
  };
  if (shared) {
    await add(`select distinct b.datname name, pg_get_userbyid(b.datdba) owner, r.rolname role from pg_database b cross join lateral aclexplode(b.datacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => `revoke all privileges on database ${q(r.name)} from ${q(r.role)}`);
    await add(`select distinct t.spcname name, pg_get_userbyid(t.spcowner) owner, r.rolname role from pg_tablespace t cross join lateral aclexplode(t.spcacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => `revoke all privileges on tablespace ${q(r.name)} from ${q(r.role)}`);
    return actions;
  }
  await add(`select distinct n.nspname name, case when pg_get_userbyid(n.nspowner)='pg_database_owner' then (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) else pg_get_userbyid(n.nspowner) end owner, r.rolname role from pg_namespace n cross join lateral aclexplode(n.nspacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => `revoke all privileges on schema ${q(r.name)} from ${q(r.role)}`);
  await add(`select distinct n.nspname schema,t.relname name,t.relkind kind,pg_get_userbyid(t.relowner) owner,r.rolname role from pg_class t join pg_namespace n on n.oid=t.relnamespace cross join lateral aclexplode(t.relacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => `revoke all privileges on ${r.kind === 'S' ? 'sequence' : 'table'} ${q(r.schema)}.${q(r.name)} from ${q(r.role)}`);
  await add(`select distinct n.nspname schema,t.relname name,p.attname column,pg_get_userbyid(t.relowner) owner,r.rolname role from pg_attribute p join pg_class t on t.oid=p.attrelid join pg_namespace n on n.oid=t.relnamespace cross join lateral aclexplode(p.attacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => `revoke all privileges (${q(r.column)}) on table ${q(r.schema)}.${q(r.name)} from ${q(r.role)}`);
  await add(`select distinct n.nspname schema,p.defaclobjtype kind,pg_get_userbyid(p.defaclrole) owner,r.rolname role from pg_default_acl p left join pg_namespace n on n.oid=p.defaclnamespace cross join lateral aclexplode(p.defaclacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => {
    const kinds: Record<string,string> = { r: 'tables', S: 'sequences', f: 'functions', T: 'types', n: 'schemas' };
    if (!kinds[r.kind]) throw new Error(`不支持的默认权限 ${r.kind}，请 DBA 核对`);
    return `alter default privileges for role ${q(r.owner)}${r.schema ? ` in schema ${q(r.schema)}` : ''} revoke all privileges on ${kinds[r.kind]} from ${q(r.role)}`;
  });
  await add(`select distinct n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) args,pg_get_userbyid(p.proowner) owner,r.rolname role from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => `revoke all privileges on routine ${q(r.schema)}.${q(r.name)}(${r.args}) from ${q(r.role)}`);
  await add(`select distinct n.nspname schema,t.typname name,pg_get_userbyid(t.typowner) owner,r.rolname role from pg_type t join pg_namespace n on n.oid=t.typnamespace cross join lateral aclexplode(t.typacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, r => `revoke all privileges on type ${q(r.schema)}.${q(r.name)} from ${q(r.role)}`);
  return actions;
}

export async function cleanupPostgresAccessRoles(conn: AdminConn, roles: ManagedDbRole[], guard: () => void, beforeCleanup: () => Promise<void> = async () => {}): Promise<void> {
  if (!roles.length) { guard(); await beforeCleanup(); return; }
  const deps = await withAdmin(conn, 'postgres', c => dependencies(c, roles));
  const owned = deps.filter(d => d.kind === 'o');
  if (owned.length) {
    const descriptions = await Promise.all(owned.map(async d => `${d.role}：${d.database ?? '集群'} / ${await describe(conn, d)}`));
    throw new Error(`角色名下仍有对象，停止删除；请 DBA 先处理所有权：\n${descriptions.join('\n')}`);
  }
  const supported = new Set(['pg_database','pg_tablespace','pg_namespace','pg_class','pg_attribute','pg_default_acl','pg_proc','pg_type']);
  const unsupported = deps.filter(d => d.kind !== 'a' || !supported.has(d.className));
  if (unsupported.length) throw new Error(`角色仍有需 DBA 处理的依赖，停止删除：\n${(await Promise.all(unsupported.map(async d => `${d.role}：${d.database ?? '集群'} / ${await describe(conn,d)}`))).join('\n')}`);
  const names = roles.map(r => r.name);
  // 先在所有涉及的库完成可连接性和 ACL 计划检查；任何预检失败均未改权限。
  const plans: Array<{ database: string; actions: AclAction[] }> = [];
  for (const database of new Set(deps.filter(d => d.databaseId !== 0).map(d => d.database!))) {
    guard();
    plans.push({ database, actions: await withAdmin(conn, database, c => aclActions(c,names,false)) });
  }
  guard(); await beforeCleanup();
  for (const plan of plans) await withAdmin(conn, plan.database, async c => {
    await c.query('begin');
    try {
      for (const action of plan.actions) { guard(); await assume(c,conn,action.owner); guard(); await c.query(action.sql); }
      guard(); await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; }
  });
  await withAdmin(conn, 'postgres', async c => {
    await c.query('begin');
    try {
      // CONNECT 属于共享 ACL；与 DROP 同事务，失败后仍能靠原组连接并重试。
      for (const action of await aclActions(c,names,true)) { guard(); await assume(c,conn,action.owner); guard(); await c.query(action.sql); }
      await c.query('reset role');
      const remaining = await dependencies(c,roles);
      if (remaining.length) throw new Error(`角色依赖未清理，未删除任何角色；请 DBA 核对后重试：${remaining.map(d => `${d.role} / ${d.database ?? '集群'} / ${d.className} OID ${d.objectId}`).join('; ')}`);
      // 明确移除组内成员。保留管理账号的 ADMIN 到 DROP，DROP 同事务自动撤掉其 SET/INHERIT/ADMIN。
      const { rows: memberships } = await c.query<{ parent: string; member: string }>('select r.rolname parent,m.rolname member from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member where r.rolname=any($1::text[]) and m.rolname<>$2', [names,conn.adminUser]);
      for (const m of memberships) { guard(); await c.query(`revoke ${q(m.parent)} from ${q(m.member)}`); }
      for (const role of roles) { guard(); await c.query(`drop role if exists ${q(role.name)}`); }
      guard(); await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; }
  });
}
