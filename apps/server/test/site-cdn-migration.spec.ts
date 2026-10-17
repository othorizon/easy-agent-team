import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
const url = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';
const pool = new Pool({ connectionString: url });
let previous: string, withPurges: string;
async function migrationFolder(before: number) {
  const destination = await mkdtemp(join(tmpdir(), 'eat-pre-cdn-'));
  await mkdir(join(destination, 'meta'));
  const folder = resolve('drizzle'),
    journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  const entries = journal.entries.filter((e: { idx: number }) => e.idx < before);
  await Promise.all(
    entries.map((e: { tag: string }) =>
      copyFile(join(folder, e.tag + '.sql'), join(destination, e.tag + '.sql')),
    ),
  );
  await writeFile(join(destination, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return destination;
}
async function expectNoInvalidation() {
  expect(
    (await pool.query("select to_regclass('public.site_cdn_purge') as queue")).rows[0].queue,
  ).toBeNull();
  expect(
    (await pool.query("select to_regprocedure('eat_folio_cdn_invalidate()') as function")).rows[0].function,
  ).toBeNull();
  expect(
    (await pool.query("select 1 from pg_trigger where tgname = 'eat_folio_cdn_invalidate'")).rows,
  ).toEqual([]);
}
beforeAll(async () => {
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Migration test requires isolated _test database');
  previous = await migrationFolder(20);
  withPurges = await migrationFolder(22);
});
beforeEach(async () => {
  await pool.query('drop schema public cascade;create schema public;drop schema if exists drizzle cascade');
  await migrate(drizzle(pool), { migrationsFolder: previous });
  await pool.query(`insert into site_setting(status,domain,oss_region,oss_bucket,oss_access_key_id_encrypted,oss_access_key_secret_encrypted,tls_mode,platform_application_id,gateway_target,route_configured)
 values('enabled','sites.example.com','oss-cn-hangzhou','test-bucket','preexisting-encrypted-id','preexisting-encrypted-secret','resolver','test-app','203.0.113.10',true)`);
});
afterAll(async () => {
  await pool.end();
  if (previous) await rm(previous, { recursive: true, force: true });
  if (withPurges) await rm(withPurges, { recursive: true, force: true });
});
describe('CDN additive migration', () => {
  it('preserves every old setting and leaves CDN absent/off without enqueuing DNS or cloud mutations', async () => {
    const before = (await pool.query('select * from site_setting')).rows;
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    expect((await pool.query('select * from site_setting')).rows).toEqual(before);
    expect((await pool.query('select * from site_cdn')).rows).toEqual([]);
    await expectNoInvalidation();
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    expect((await pool.query('select status,route_configured from site_setting')).rows[0]).toEqual({
      status: 'enabled',
      route_configured: true,
    });
  });
  it('removes existing invalidation triggers and pending/retrying work while preserving CDN and Folio state', async () => {
    await migrate(drizzle(pool), { migrationsFolder: withPurges });
    await pool.query(`insert into site_cdn(enabled, connected, status, origin_secret_encrypted, resources)
      values(true, true, 'enabled', 'existing-encrypted-secret', '{"owned":true,"configured":true}')`);
    const owner = (
      await pool.query(`insert into "user"(email, name, password_hash)
        values('migration@example.test', 'Migration', 'unused-test-hash') returning id`)
    ).rows[0].id;
    const site = (
      await pool.query(
        `insert into site(slug, name, owner_id) values('migration', 'Migration', $1) returning id`,
        [owner],
      )
    ).rows[0].id;
    await pool.query('update site set access_revision = access_revision + 1 where id = $1', [site]);
    await pool.query('update site_cdn_purge set attempts = 2');
    expect((await pool.query('select * from site_cdn_purge')).rows).toHaveLength(1);
    const settings = (await pool.query('select * from site_setting')).rows;
    const cdn = (await pool.query('select * from site_cdn')).rows;
    const sites = (await pool.query('select * from site')).rows;

    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    await expectNoInvalidation();
    expect((await pool.query('select * from site_setting')).rows).toEqual(settings);
    expect((await pool.query('select * from site_cdn')).rows).toEqual(cdn);
    expect((await pool.query('select * from site')).rows).toEqual(sites);
    // Publication/permission updates and deletion must work after the queue/function are gone.
    await pool.query('update site set access_revision = access_revision + 1 where id = $1', [site]);
    await pool.query('delete from site where id = $1', [site]);
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    await expectNoInvalidation();
  });
});
