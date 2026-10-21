import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test' });
afterAll(async () => pool.end());

it('adds the setup wizard without changing existing App credentials, approval, membership or pending grants', async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  const old = await mkdtemp(join(tmpdir(), 'eat-before-github-setup-'));
  try {
    await cp(resolve('drizzle'), old, { recursive: true });
    const journal = JSON.parse(await readFile(join(old, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 30);
    await writeFile(join(old, 'meta/_journal.json'), JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: old });
    const user = (await pool.query(`insert into "user" (name,email,password_hash,role) values ('test','migration@example.test','hash','admin') returning id`)).rows[0].id;
    await pool.query(`insert into github_setting (organization,app_id,client_id,installation_id,client_secret_encrypted,private_key_encrypted,organization_id,enabled)
      values ('eat-org','10','client','20','encrypted-client-secret','encrypted-private-key','30',true)`);
    await pool.query(`insert into github_account (user_id,github_id,login,access_token_encrypted,refresh_token_encrypted,org_state) values ($1,'40','test','encrypted-user','encrypted-refresh','active')`, [user]);
    const app = (await pool.query(`insert into app (slug,name,owner_id,dokploy_application_id,repo_url,deploy_approved,approved_repo_version) values ('demo','demo',$1,'dok','https://github.com/eat-org/demo',true,1) returning id`, [user])).rows[0].id;
    await pool.query(`insert into app_member (app_id,user_id) values ($1,$2)`, [app, user]);
    await pool.query(`insert into github_task (key,kind,payload) values ('pending-grant','grant',$1)`, [JSON.stringify({ appId: app, userId: user, actorId: user, version: 1 })]);
    const tables = ['github_setting', 'github_account', 'github_task', 'app', 'app_member'];
    const before = await Promise.all(tables.map(t => pool.query(`select * from ${t}`)));
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    for (let i = 0; i < tables.length; i++) {
      const after = (await pool.query(`select * from ${tables[i]}`)).rows;
      if (tables[i] === 'github_setting') {
        expect(after[0]).toMatchObject(before[i].rows[0]);
        expect(after[0].revision).toMatch(/^[a-f0-9-]{36}$/);
        expect(after[0].connection_state).toBe('app_ready');
      } else expect(after).toEqual(before[i].rows);
    }
    expect((await pool.query('select * from github_setup_state')).rows).toEqual([]);
  } finally { await rm(old, { recursive: true, force: true }); }
});
