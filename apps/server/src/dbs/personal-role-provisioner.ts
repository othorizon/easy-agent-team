import { q, withAdmin, type AdminConn } from './provisioner';

/** 密码修改不改变 LOGIN；来源标记检查与 ALTER 在同一目标事务中完成。 */
export async function resetPostgresPersonalPassword(conn: AdminConn, identity: { id: string; roleName: string }, password: string, guard: () => void): Promise<void> {
  await withAdmin(conn, 'postgres', async c => {
    await c.query('begin');
    try {
      guard();
      const { rows: [role] } = await c.query("select shobj_description(oid,'pg_authid') marker from pg_roles where rolname=$1", [identity.roleName]);
      if (role?.marker !== `eat:db-personal-role:${identity.id}`) throw new Error('个人角色不存在或来源不明，EAT 不会修改；请管理员核对。');
      await c.query(`alter role ${q(identity.roleName)} password '${password.replaceAll("'", "''")}'`);
      guard();
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; }
  });
}
