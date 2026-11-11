process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB, DbModule, PG_POOL, type Db } from '../src/db/db.module';

afterEach(() => vi.restoreAllMocks());

describe('平台数据库连接池', () => {
  it('空闲连接断开时记录错误，不把连接池 error 事件变成进程级异常', async () => {
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const module = await Test.createTestingModule({ imports: [DbModule] }).compile();
    const pool = module.get<Pool>(PG_POOL);
    try {
      expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'), {
        connectionParameters: { password: 'must-not-be-logged' },
      })).not.toThrow();
      expect(warning).toHaveBeenCalledOnce();
      expect(JSON.stringify(warning.mock.calls)).toContain('Connection terminated unexpectedly');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('must-not-be-logged');
    } finally {
      await module.close();
    }
  });

  it('真实空闲连接被数据库终止后，移除失效连接并为后续 Drizzle 查询重建连接', async () => {
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const module = await Test.createTestingModule({ imports: [DbModule] }).compile();
    const pool = module.get<Pool>(PG_POOL);
    const db = module.get<Db>(DB);
    const control = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const before = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      const pid = before.rows[0].pid;
      await control.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => {
        expect(warning).toHaveBeenCalledOnce();
        expect(pool.totalCount).toBe(0);
      });
      const after = await db.execute<{ pid: number; ok: number }>(sql`select pg_backend_pid() as pid, 1 as ok`);
      expect(after.rows[0].pid).not.toBe(pid);
      expect(after.rows[0].ok).toBe(1);
    } finally {
      await control.end();
      await module.close();
    }
  });

  it('执行中的查询断连时仍然报错，后续查询可以恢复', async () => {
    const module = await Test.createTestingModule({ imports: [DbModule] }).compile();
    const pool = module.get<Pool>(PG_POOL);
    const control = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const { rows: [{ pid }] } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
      const query = pool.query('select pg_sleep(30)');
      const rejected = expect(query).rejects.toThrow(/terminating connection|Connection terminated/);
      await vi.waitFor(async () => {
        const { rows } = await control.query('select state, query from pg_stat_activity where pid=$1', [pid]);
        expect(rows[0]).toMatchObject({ state: 'active', query: 'select pg_sleep(30)' });
      });
      await control.query('select pg_terminate_backend($1)', [pid]);
      await rejected;
      expect((await pool.query('select 1 as ok')).rows[0].ok).toBe(1);
    } finally {
      await control.end();
      await module.close();
    }
  });
});
