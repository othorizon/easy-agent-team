import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';
const pool = new Pool({ connectionString });
const migrationDir = resolve('drizzle');
const owner = randomUUID(), site = randomUUID(), legacy = randomUUID(), current = randomUUID();
const hash = createHash('sha256').update('new content').digest('hex');
const manifest = { 'index.html': { hash, size: 11, type: 'text/html' } };
let previousDir: string;

beforeAll(async () => {
  if (!decodeURIComponent(new URL(connectionString).pathname).endsWith('_test'))
    throw new Error('布局迁移测试只允许使用名称以 _test 结尾的独立 TEST_DATABASE_URL');
  previousDir = await mkdtemp(join(tmpdir(), 'eat-folio-pre-layout-'));
  await mkdir(join(previousDir, 'meta'));
  const journal = JSON.parse(await readFile(join(migrationDir, 'meta/_journal.json'), 'utf8'));
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 19);
  await Promise.all(entries.map((entry: { tag: string }) =>
    copyFile(join(migrationDir, entry.tag + '.sql'), join(previousDir, entry.tag + '.sql'))));
  await writeFile(join(previousDir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: previousDir });
  await pool.query('insert into "user" (id, name, email, password_hash) values ($1, $2, $3, $4)',
    [owner, 'Layout migration', 'layout@folio.test', 'unused-test-hash']);
  await pool.query('insert into site (id, slug, name, owner_id) values ($1, $2, $3, $4)',
    [site, 'layout-upgrade', 'Layout upgrade', owner]);
  for (const [id, number, layout] of [[legacy, 1, 'legacy-v0'], [current, 2, 'blobs-v1']] as const)
    await pool.query(`insert into site_version (id, site_id, number, publisher_id, file_count, total_bytes, storage, layout, manifest)
      values ($1, $2, $3, $4, 1, 11, 'oss', $5, $6)`, [id, site, number, owner, layout, JSON.stringify(manifest)]);
  await pool.query('update site set current_version_id = $1, next_version = 3 where id = $2', [current, site]);
});
afterAll(async () => {
  await pool.end();
  if (previousDir) await rm(previousDir, { recursive: true, force: true });
});

describe('仅 blobs-v1 布局的增量迁移', () => {
  it('遗留旧版本时中止并回滚，不删除、重标记或修改当前版本', async () => {
    const before = (await pool.query('select * from site_version order by number')).rows;
    await expect(migrate(drizzle(pool), { migrationsFolder: migrationDir })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '23514', message: expect.stringContaining('旧布局版本尚未处理') }),
    });
    expect((await pool.query('select * from site_version order by number')).rows).toEqual(before);
    expect((await pool.query('select current_version_id from site where id = $1', [site])).rows[0].current_version_id).toBe(current);
  });

  it('旧版本归零后保留新版本和完整清单，固定 OSS 元数据并拒绝写入旧布局/本地存储', async () => {
    // Only this test database's deliberately seeded legacy fixture is removed.
    await pool.query('delete from site_version where id = $1', [legacy]);
    await migrate(drizzle(pool), { migrationsFolder: migrationDir });
    const row = (await pool.query('select * from site_version where id = $1', [current])).rows[0];
    expect(row).toMatchObject({ id: current, site_id: site, number: 2, layout: 'blobs-v1', manifest });
    expect(row.storage).toBe('oss');
    expect((await pool.query('select current_version_id from site where id = $1', [site])).rows[0].current_version_id).toBe(current);
    await expect(pool.query("update site_version set layout = 'legacy-v0' where id = $1", [current]))
      .rejects.toMatchObject({ code: '23514', constraint: 'site_version_layout_check' });
    await expect(pool.query("update site_version set storage = 'local' where id = $1", [current]))
      .rejects.toMatchObject({ code: '23514', constraint: 'site_version_storage_check' });
    const result = await pool.query(`insert into site_version
      (id, site_id, number, publisher_id, file_count, total_bytes, manifest)
      values ($1, $2, 3, $3, 1, 11, $4) returning layout, storage`, [randomUUID(), site, owner, JSON.stringify(manifest)]);
    expect(result.rows[0]).toEqual({ layout: 'blobs-v1', storage: 'oss' });
  });
});
