import { allowSetRole, q, withAdmin, type AdminConn } from './provisioner';

/** 只切断个人身份，不改密码、组成员关系或分配的 owner。NOLOGIN 必须先提交。 */
export async function syncPostgresPersonalLogin(conn: AdminConn, identity: { id: string; roleName: string }, enabled: boolean, guard: () => void): Promise<void> {
  await withAdmin(conn, 'postgres', async c => {
    guard();
    const { rows: [role] } = await c.query("select shobj_description(oid,'pg_authid') marker from pg_roles where rolname=$1", [identity.roleName]);
    // 尚未创建或已经删除的身份没有登录能力；恢复不创建角色、不重放授权。
    if (!role) return;
    if (role.marker !== `eat:db-personal-role:${identity.id}`) throw new Error('个人角色来源不明，EAT 不会修改；请管理员核对。');
    guard();
    await c.query(`alter role ${q(identity.roleName)} ${enabled ? 'login' : 'nologin'}`);
    if (!enabled) {
      guard();
      await allowSetRole(c, identity.roleName, conn.adminUser);
      await c.query(`set role ${q(identity.roleName)}`);
      guard();
      const { rows } = await c.query<{ terminated: boolean }>('select pg_terminate_backend(pid) terminated from pg_stat_activity where usename=$1 and pid<>pg_backend_pid()', [identity.roleName]);
      if (rows.some(r => !r.terminated)) throw new Error('部分个人会话尚未终止，将自动重试');
    }
    guard();
  });
}

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
