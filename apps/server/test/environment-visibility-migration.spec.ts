import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

it('已有数据库从 0033 升级时应用环境可见性迁移，保留旧环境为 team，重复迁移不改变 private', async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test' });
  const dir = await mkdtemp(join(tmpdir(), 'eat-environment-visibility-'));
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE');
    await cp(resolve('drizzle'), dir, { recursive: true });
    const journal = JSON.parse(await readFile(join(dir, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 34);
    await writeFile(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: dir });
    const { rows: [owner] } = await pool.query(`INSERT INTO "user"(name,email,role,password_hash) VALUES('owner','owner@migration.test','member','test') RETURNING id`);
    await pool.query(`INSERT INTO environment(slug,name,owner_id) VALUES('existing','既有环境',$1)`, [owner.id]);
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    expect((await pool.query(`SELECT visibility FROM environment WHERE slug='existing'`)).rows[0].visibility).toBe('team');
    await pool.query(`UPDATE environment SET visibility='private' WHERE slug='existing'`);
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    expect((await pool.query(`SELECT visibility FROM environment WHERE slug='existing'`)).rows[0].visibility).toBe('private');
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
