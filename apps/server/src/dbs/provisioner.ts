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

async function withAdmin<T>(conn: AdminConn, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.adminUser,
    password: conn.adminPassword || undefined,
    database: 'postgres',
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

export async function provisionPostgres(conn: AdminConn, dbName: string, dbUser: string, password: string): Promise<void> {
  await withAdmin(conn, async (c) => {
    await c.query(`create role ${q(dbUser)} login password '${escapePassword(password)}'`);
    await c.query(`create database ${q(dbName)} owner ${q(dbUser)}`);
  });
}

export async function disablePostgres(conn: AdminConn, dbName: string, dbUser: string): Promise<void> {
  await withAdmin(conn, async (c) => {
    await c.query(`alter role ${q(dbUser)} nologin`);
    await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
  });
}

export async function enablePostgres(conn: AdminConn, dbUser: string): Promise<void> {
  await withAdmin(conn, async (c) => {
    await c.query(`alter role ${q(dbUser)} login`);
  });
}

export async function dropPostgres(conn: AdminConn, dbName: string, dbUser: string): Promise<void> {
  await withAdmin(conn, async (c) => {
    await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
    await c.query(`drop database if exists ${q(dbName)}`);
    await c.query(`drop role if exists ${q(dbUser)}`);
  });
}
