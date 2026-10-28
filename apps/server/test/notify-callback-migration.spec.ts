import { afterAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test' });
afterAll(async () => pool.end());

it('0038 快照只在 0037 上新增回复回调与广播权限，不覆盖上游结构', async () => {
  const previous = JSON.parse(await readFile(resolve('drizzle/meta/0037_snapshot.json'), 'utf8'));
  const current = JSON.parse(await readFile(resolve('drizzle/meta/0038_snapshot.json'), 'utf8'));
  expect(current.prevId).toBe(previous.id);
  expect(current.tables['public.user'].columns.can_notify_all).toMatchObject({ type: 'boolean', notNull: true, default: false });
  expect(current.tables['public.help_request'].columns.reply_callback_url).toMatchObject({ type: 'text', notNull: false });
  delete current.tables['public.user'].columns.can_notify_all;
  delete current.tables['public.help_request'].columns.reply_callback_url;
  for (const snapshot of [previous, current]) { delete snapshot.id; delete snapshot.prevId; }
  expect(current).toEqual(previous);
});

it('0037 升级至 0038 保留数据库凭证、飞书配置与绑定、求助历史；新权限默认关闭且重跑不重置', async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  const old = await mkdtemp(join(tmpdir(), 'eat-before-notify-callback-'));
  try {
    await cp(resolve('drizzle'), old, { recursive: true });
    const journal = JSON.parse(await readFile(join(old, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 38);
    await writeFile(join(old, 'meta/_journal.json'), JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: old });
    const user = (await pool.query(`insert into "user" (name,email,password_hash,role) values ('old admin','migration@notify.test','hash','admin') returning id`)).rows[0].id;
    const member = (await pool.query(`insert into "user" (name,email,password_hash) values ('old member','member@notify.test','hash') returning id`)).rows[0].id;
    const help = (await pool.query(`insert into help_request (requester_id,helper_id,title,description) values ($1,$2,'历史求助','原始内容') returning id`, [user, member])).rows[0].id;
    await pool.query(`insert into help_message (request_id,sender_id,content) values ($1,$2,'历史回复')`, [help, member]);
    await pool.query(`update feishu_setting set channel='app',app_id='cli_test',app_secret_encrypted='encrypted-app-secret'`);
    await pool.query(`insert into feishu_binding (user_id,app_id,open_id) values ($1,'cli_test','ou_test')`, [user]);
    await pool.query(`insert into user_notification (user_id,webhook_url,verified_at) values ($1,'https://example.test/webhook',now())`, [user]);
    const instance = (await pool.query(`insert into db_instance (name,engine,host,port,admin_user,admin_password_encrypted,created_by) values ('test','postgres','127.0.0.1',5432,'test','encrypted-admin',$1) returning id`, [user])).rows[0].id;
    await pool.query(`insert into db_assignment (instance_id,requester_id,db_name,db_user,purpose,status,password_encrypted) values ($1,$2,'existing_db','existing_user','existing','active','encrypted-password')`, [instance, user]);
    const tables = ['"user"', 'help_request', 'help_message', 'feishu_setting', 'feishu_binding', 'user_notification', 'db_instance', 'db_assignment'];
    const before = await Promise.all(tables.map(t => pool.query(`select * from ${t}`)));
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    for (let i = 0; i < tables.length; i++) {
      const after = (await pool.query(`select * from ${tables[i]}`)).rows;
      const expected = before[i].rows.map(row => tables[i] === '"user"' ? { ...row, can_notify_all: false }
        : tables[i] === 'help_request' ? { ...row, reply_callback_url: null } : row);
      expect(after).toEqual(expected);
    }
    await pool.query(`update "user" set can_notify_all=true where id=$1`, [user]);
    const callback = 'codex://threads/test?prompt={message}';
    await pool.query(`update help_request set reply_callback_url=$1 where id=$2`, [callback, help]);
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    expect((await pool.query(`select can_notify_all from "user" where id=$1`, [user])).rows[0].can_notify_all).toBe(true);
    expect((await pool.query(`select reply_callback_url from help_request where id=$1`, [help])).rows[0].reply_callback_url).toBe(callback);
  } finally { await rm(old, { recursive: true, force: true }); }
});
