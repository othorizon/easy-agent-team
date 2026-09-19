import { Logger } from '@nestjs/common';
import { Client } from 'pg';

/**
 * PostgreSQL 建库执行器：用实例的管理账号执行建库/建号/回收。
 * 标识符（dbName/dbUser）已由 zod 从严校验（^[a-z][a-z0-9_]{2,30}$），可安全内插；
 * 密码由平台生成（hex），单引号转义仅为双保险。
 */
export interface AdminConn {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
}

const logger = new Logger('DbProvisioner');

async function withAdmin<T>(conn: AdminConn, database: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.adminUser,
    password: conn.adminPassword || undefined,
    database,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const q = (s: string) => `"${s}"`;
const escapePassword = (s: string) => s.replace(/'/g, "''");

/**
 * 把新库里的 public schema 归到分配账号名下。
 *
 * `CREATE DATABASE ... OWNER x` 只改库的归属，public schema 是从 template1 复制过来的，归属跟着模板走：
 * - PG 15+ 干净集群：owner 是 pg_database_owner（库 owner 隐式是它的成员，能建表，但 `\dn` 显示的不是自己的账号，
 *   `DROP SCHEMA public` / `ALTER SCHEMA` / `COMMENT ON SCHEMA` 之外的迁移工具动作也就都做不了）；
 * - PG 14 及更早（含 pg_upgrade 上来的集群）：owner 是超级用户，建表只靠 PUBLIC 默认的 CREATE 授权兜底，
 *   DBA 一句 `REVOKE ALL ON SCHEMA public FROM PUBLIC`（PG 15 默认就是这个方向）分配账号连建表都做不了；
 * - 模板里 public 被删过：新库压根没有 public，分配账号 `create table` 直接报 "no schema has been selected to create in"。
 *
 * 所以建完库必须再连进新库把 public 摆正。改不动归属不一定等于库不能用（管理账号非超级用户时很常见），
 * 最后按实际的 CREATE 权限判定：能建表就只告警，连建表都不行才算建库失败。
 */
async function ensurePublicSchema(conn: AdminConn, dbName: string, dbUser: string): Promise<void> {
  await withAdmin(conn, dbName, async (c) => {
    const exists = (await c.query(`select 1 from pg_namespace where nspname = 'public'`)).rowCount ?? 0;
    try {
      if (exists === 0) {
        await c.query(`create schema public authorization ${q(dbUser)}`);
      } else {
        await c.query(`alter schema public owner to ${q(dbUser)}`);
      }
    } catch (err) {
      logger.warn(`库 ${dbName} 的 public schema 未能归属到 ${dbUser}（管理账号权限不足？）：${(err as Error).message}`);
    }
    const ok = (await c.query(`select has_schema_privilege($1, 'public', 'CREATE') as ok`, [dbUser])).rows[0]?.ok;
    if (!ok) {
      throw new Error(
        `账号 ${dbUser} 在库 ${dbName} 的 public schema 上没有 CREATE 权限，且管理账号 ${conn.adminUser} 权限不足以修正；` +
          `请用超级用户执行：ALTER SCHEMA public OWNER TO ${q(dbUser)};`,
      );
    }
  });
}

export async function provisionPostgres(conn: AdminConn, dbName: string, dbUser: string, password: string): Promise<void> {
  await withAdmin(conn, 'postgres', async (c) => {
    await c.query(`create role ${q(dbUser)} login password '${escapePassword(password)}'`);
    await c.query(`create database ${q(dbName)} owner ${q(dbUser)}`);
  });
  await ensurePublicSchema(conn, dbName, dbUser);
}

export async function disablePostgres(conn: AdminConn, dbName: string, dbUser: string): Promise<void> {
  await withAdmin(conn, 'postgres', async (c) => {
    await c.query(`alter role ${q(dbUser)} nologin`);
    await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
  });
}

export async function enablePostgres(conn: AdminConn, dbUser: string): Promise<void> {
  await withAdmin(conn, 'postgres', async (c) => {
    await c.query(`alter role ${q(dbUser)} login`);
  });
}

// 平台不做物理删库（决策 13）：删除分配仅记录级，DROP DATABASE/ROLE 由管理员在实例上手动执行。
