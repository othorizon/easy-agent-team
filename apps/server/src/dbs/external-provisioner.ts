import type { DbPublicCheck } from '@eat/shared';
import type { Client } from 'pg';
import { applySchemaAccess, ensureAccessRole, type AccessDatabase } from './access-provisioner';
import { q, withAdmin, type AdminConn } from './provisioner';

const tablePrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const aclRole = (name: string | null) => name === null ? 'PUBLIC' : q(name);

async function canSet(c: Client, role: string): Promise<boolean> {
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  return (await c.query('select pg_has_role(session_user,$1,$2) allowed', [role, version >= 160000 ? 'SET' : 'MEMBER'])).rows[0].allowed;
}
function needRole(owner: string, admin: string, version: number): string {
  return `GRANT ${q(owner)} TO ${q(admin)}${version >= 160000 ? ' WITH SET TRUE, INHERIT FALSE' : ''};`;
}

/** GRANT 缺权限有时只发 warning；先验证每个对象的实际授权能力，不能据此假报成功。 */
async function validate(c: Client, conn: AdminConn, d: AccessDatabase): Promise<string> {
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  const { rows: [admin] } = await c.query('select rolcreaterole or rolsuper allowed from pg_roles where rolname=session_user');
  const missing = new Set<string>();
  if (!admin.allowed) missing.add(`ALTER ROLE ${q(conn.adminUser)} CREATEROLE;`);
  const { rows: [database] } = await c.query('select oid, pg_get_userbyid(datdba) owner from pg_database where datname=current_database()');
  if (!await canSet(c, database.owner) && !(await c.query("select has_database_privilege(session_user,$1::oid,'CONNECT WITH GRANT OPTION') allowed", [database.oid])).rows[0].allowed) missing.add(needRole(database.owner, conn.adminUser, version));
  // 也检查移出范围上的旧组 ACL，以免配置变更只完成一半。
  const groups = [d.readRole, d.writeRole];
  const { rows: namespaces } = await c.query<{ name: string; owner: string; oid: number }>(`
    select n.oid, n.nspname name, case when pg_get_userbyid(n.nspowner)='pg_database_owner' then $3 else pg_get_userbyid(n.nspowner) end owner
    from pg_namespace n where n.nspname=any($1::text[])
      or exists(select 1 from aclexplode(n.nspacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($2::text[]))
      or exists(select 1 from pg_class t cross join lateral aclexplode(t.relacl) a join pg_roles r on r.oid=a.grantee where t.relnamespace=n.oid and r.rolname=any($2::text[]))
      or exists(select 1 from pg_default_acl p cross join lateral aclexplode(p.defaclacl) a join pg_roles r on r.oid=a.grantee where p.defaclnamespace=n.oid and r.rolname=any($2::text[]))
  `, [d.schemas, groups, database.owner]);
  for (const name of d.schemas) if (!namespaces.some(ns => ns.name === name)) throw new Error(`schema ${name} 不存在；请 DBA 执行：CREATE SCHEMA ${q(name)};`);
  for (const ns of namespaces) {
    if (!await canSet(c, ns.owner) && !(await c.query("select has_schema_privilege(session_user,$1::oid,'USAGE WITH GRANT OPTION') allowed", [ns.oid])).rows[0].allowed) missing.add(needRole(ns.owner, conn.adminUser, version));
    const { rows: objects } = await c.query<{ oid: number; owner: string; kind: string }>("select oid, pg_get_userbyid(relowner) owner, relkind kind from pg_class where relnamespace=$1 and relkind in ('r','p','v','m','f','S')", [ns.oid]);
    for (const object of objects) {
      if (await canSet(c, object.owner)) continue;
      const privileges = object.kind === 'S' ? ['USAGE', 'SELECT'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
      const fn = object.kind === 'S' ? 'has_sequence_privilege' : 'has_table_privilege';
      const result = await c.query(`select bool_and(${fn}(session_user,$1::oid,p || ' WITH GRANT OPTION')) allowed from unnest($2::text[]) p`, [object.oid, privileges]);
      if (!result.rows[0].allowed) missing.add(needRole(object.owner, conn.adminUser, version));
    }
  }
  const { rows: defaults } = await c.query<{ owner: string }>(`select distinct pg_get_userbyid(p.defaclrole) owner from pg_default_acl p cross join lateral aclexplode(p.defaclacl) a join pg_roles r on r.oid=a.grantee where r.rolname=any($1::text[])`, [groups]);
  for (const role of new Set([...(d.creatorRole ? [d.creatorRole] : []), ...defaults.map(x => x.owner)])) {
    const exists = (await c.query('select 1 from pg_roles where rolname=$1', [role])).rowCount;
    if (!exists) throw new Error(`建表角色 ${role} 不存在；请 DBA 执行：CREATE ROLE ${q(role)} NOLOGIN;`);
    if (!await canSet(c, role)) missing.add(needRole(role, conn.adminUser, version));
  }
  if (missing.size) throw new Error(`管理账号缺少建组角色或授予权限的能力。请有权限的 DBA 执行：\n${[...missing].join('\n')}`);
  return database.owner;
}

/** 检查只读；包括 PUBLIC、现有角色的有效权限及继承链，SQL 交给 DBA 决定。 */
async function inspect(c: Client, d: AccessDatabase): Promise<DbPublicCheck> {
  const { rows: dbAcl } = await c.query<{ role: string | null }>(`select r.rolname role from pg_database d cross join lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a left join pg_roles r on r.oid=a.grantee where d.datname=current_database() and a.privilege_type='CONNECT' and a.grantee<>d.datdba`);
  const { rows: schemaAcl } = await c.query<{ schema: string; role: string | null; privilege: string }>(`select n.nspname schema, r.rolname role, a.privilege_type privilege from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a left join pg_roles r on r.oid=a.grantee where (n.nspname='public' or n.nspname=any($1::text[])) and a.grantee<>n.nspowner`, [d.schemas]);
  const { rows: tableAcl } = await c.query<{ schema: string; table: string; role: string | null; privilege: string }>(`select n.nspname schema,t.relname "table",r.rolname role,a.privilege_type privilege from pg_class t join pg_namespace n on n.oid=t.relnamespace cross join lateral aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a left join pg_roles r on r.oid=a.grantee where n.nspname=any($1::text[]) and t.relkind in ('r','p','v','m','f') and a.grantee<>t.relowner order by n.nspname,t.relname,a.privilege_type`, [d.schemas]);
  const { rows: columnAcl } = await c.query<{ schema: string; table: string; column: string; role: string | null; privilege: string }>(`select n.nspname schema,t.relname "table",col.attname "column",r.rolname role,a.privilege_type privilege from pg_attribute col join pg_class t on t.oid=col.attrelid join pg_namespace n on n.oid=t.relnamespace cross join lateral aclexplode(col.attacl) a left join pg_roles r on r.oid=a.grantee where n.nspname=any($1::text[]) and col.attnum>0 and not col.attisdropped and a.grantee<>t.relowner order by n.nspname,t.relname,col.attname,a.privilege_type`, [d.schemas]);
  const tables: DbPublicCheck['tables'] = [];
  const allTableAcl = [...tableAcl, ...columnAcl.map(row => ({ ...row, privilege: `${row.privilege} (${q(row.column)})` }))];
  for (const row of allTableAcl.filter(a => a.role === null && schemaAcl.some(s => s.schema === a.schema && s.role === null && s.privilege === 'USAGE'))) {
    let entry = tables.find(t => t.schema === row.schema && t.table === row.table);
    if (!entry) { entry = { schema: row.schema, table: row.table, privileges: [] }; tables.push(entry); }
    entry.privileges.push(row.privilege);
  }
  const { rows: roles } = await c.query<{ role: string; inheritedFrom: string[]; connect: boolean; schemaCreate: string[] }>(`
    select r.rolname role, array(select p.rolname::text from pg_roles p where p.oid<>r.oid and pg_has_role(r.oid,p.oid,'USAGE') order by p.rolname) "inheritedFrom",
      has_database_privilege(r.oid,current_database(),'CONNECT') connect,
      array(select n.nspname::text from pg_namespace n where (n.nspname='public' or n.nspname=any($1::text[])) and has_schema_privilege(r.oid,n.oid,'CREATE') order by n.nspname) "schemaCreate"
    from pg_roles r where not r.rolsuper and r.rolname !~ '^pg_' and r.rolname<>all($2::text[]) order by r.rolname
  `, [d.schemas, [d.readRole, d.writeRole]]);
  const effective = [];
  for (const role of roles) {
    const { rows: permissions } = await c.query<DbPublicCheck['tables'][number]>(`
      select n.nspname schema,t.relname "table",array(select p from unnest($3::text[]) p where has_table_privilege($1,t.oid,p)) || array(select p || ' (' || string_agg(quote_ident(col.attname), ', ' order by col.attnum) || ')' from unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) p join pg_attribute col on col.attrelid=t.oid and col.attnum>0 and not col.attisdropped where not has_table_privilege($1,t.oid,p) and has_column_privilege($1,t.oid,col.attnum,p) group by p) privileges
      from pg_class t join pg_namespace n on n.oid=t.relnamespace where n.nspname=any($2::text[]) and t.relkind in ('r','p','v','m','f') and has_schema_privilege($1,n.oid,'USAGE') order by n.nspname,t.relname
    `, [role.role, d.schemas, tablePrivileges]);
    effective.push({ ...role, tables: permissions.filter(p => p.privileges.length) });
  }
  const managed = new Set([d.readRole, d.writeRole]);
  const tighteningSql = new Set<string>();
  for (const row of dbAcl) if (!managed.has(row.role!)) tighteningSql.add(`REVOKE CONNECT ON DATABASE ${q(d.dbName)} FROM ${aclRole(row.role)};`);
  for (const row of schemaAcl) if (row.privilege === 'CREATE' && !managed.has(row.role!)) tighteningSql.add(`REVOKE CREATE ON SCHEMA ${q(row.schema)} FROM ${aclRole(row.role)};`);
  for (const row of tableAcl) if (!managed.has(row.role!)) tighteningSql.add(`REVOKE ${row.privilege} ON TABLE ${q(row.schema)}.${q(row.table)} FROM ${aclRole(row.role)};`);
  for (const row of columnAcl) if (!managed.has(row.role!)) tighteningSql.add(`REVOKE ${row.privilege} (${q(row.column)}) ON TABLE ${q(row.schema)}.${q(row.table)} FROM ${aclRole(row.role)};`);
  // 对象 owner 和预定义的全库读写角色没有可撤回的对象 ACL，需要提示 DBA 处理继承入口。
  const version = Number((await c.query('show server_version_num')).rows[0].server_version_num);
  const { rows: inheritedOwners } = await c.query<{ parent: string; member: string }>(`
    select parent.rolname parent,child.rolname member from pg_auth_members membership
    join pg_roles parent on parent.oid=membership.roleid join pg_roles child on child.oid=membership.member
    where ${version >= 160000 ? 'membership.inherit_option' : 'child.rolinherit'} and (parent.rolname in ('pg_read_all_data','pg_write_all_data')
      or parent.oid=(select datdba from pg_database where datname=current_database())
      or parent.oid in(select nspowner from pg_namespace where nspname='public' or nspname=any($1::text[]))
      or parent.oid in(select relowner from pg_class t join pg_namespace n on n.oid=t.relnamespace where n.nspname=any($1::text[])))
    order by parent.rolname,child.rolname
  `, [d.schemas]);
  for (const row of inheritedOwners) tighteningSql.add(`REVOKE ${q(row.parent)} FROM ${q(row.member)};`);
  return { checkedAt: new Date().toISOString(), connect: dbAcl.some(a => a.role === null), publicSchemaCreate: schemaAcl.some(a => a.schema === 'public' && a.role === null && a.privilege === 'CREATE'), tables, roles: effective, tighteningSql: [...tighteningSql] };
}

export async function checkExternalPostgresAccess(conn: AdminConn, d: AccessDatabase): Promise<DbPublicCheck> {
  try { return await withAdmin(conn, d.dbName, async c => { await validate(c, conn, d); return inspect(c, d); }); }
  catch (e) {
    if ((e as { code?: string }).code === '42501') throw new Error(`${(e as Error).message}；请 DBA 执行：GRANT CONNECT ON DATABASE ${q(d.dbName)} TO ${q(conn.adminUser)};`);
    throw e;
  }
}

export async function openExternalPostgresAccess(conn: AdminConn, d: AccessDatabase, guard: () => void): Promise<DbPublicCheck> {
  return withAdmin(conn, d.dbName, async c => {
    await c.query('begin');
    try {
      guard();
      const databaseOwner = await validate(c, conn, d);
      const check = await inspect(c, d);
      await ensureAccessRole(c, d.readRole, `eat:db-catalog:${d.id}:read`);
      await ensureAccessRole(c, d.writeRole, `eat:db-catalog:${d.id}:write`);
      if (await canSet(c, databaseOwner)) await c.query(`set local role ${q(databaseOwner)}`);
      await c.query(`grant connect on database ${q(d.dbName)} to ${q(d.readRole)}, ${q(d.writeRole)}`);
      await applySchemaAccess(c, conn, { ...d, source: 'external' });
      guard();
      await c.query('commit');
      return check;
    } catch (e) { await c.query('rollback'); throw e; }
  });
}
