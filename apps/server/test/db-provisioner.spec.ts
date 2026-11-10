import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { provisionPostgres, q, withAdmin, type AdminConn } from '../src/dbs/provisioner';

// Own cluster: these cases change template1 and must never use a configured instance.
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const container = `eat-provisioner-${suffix}`;
const manager = `mgr_${suffix}`;
const assignments: string[] = [];
let root: AdminConn;
let admin: AdminConn;
let started = false;

beforeAll(async () => {
  execFileSync('docker', ['run', '-d', '--name', container, '-e', 'POSTGRES_USER=dev', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', process.env.TEST_PROVISIONER_PG_IMAGE ?? 'postgres:16']);
  started = true;
  const port = Number(execFileSync('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container], { encoding: 'utf8' }).trim());
  root = { host: '127.0.0.1', port, adminUser: 'dev', adminPassword: '' };
  admin = { ...root, adminUser: manager };
  for (let attempt = 0; ; attempt++) {
    try {
      await withAdmin(root, 'postgres', async c => { await c.query('select 1'); });
      break;
    } catch (error) {
      if (attempt === 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await withAdmin(root, 'postgres', async c => {
    await c.query(`create role ${q(manager)} login createdb createrole`);
  });
});

afterAll(() => {
  if (started) execFileSync('docker', ['rm', '-f', container]);
});

async function template(owner?: string) {
  await withAdmin(root, 'template1', async c => {
    await c.query('drop schema if exists public cascade');
    if (owner) {
      await c.query(`create schema public authorization ${q(owner)}`);
      await c.query('revoke all on schema public from public');
    }
  });
}

async function provision(conn: AdminConn, schemaOwner?: string) {
  const name = `provision_${suffix}_${assignments.length}`;
  assignments.push(name);
  const user = `u_${name}`;
  await provisionPostgres(conn, name, user, 'test-password');
  const c = new Client({ host: root.host, port: root.port, user, database: name, password: 'test-password' });
  await c.connect();
  try {
    expect((await c.query("select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname='public'")).rows[0].owner).toBe(schemaOwner ?? user);
    expect((await c.query("select exists(select 1 from pg_namespace n, lateral aclexplode(n.nspacl) a where n.nspname='public' and a.grantee=0 and a.privilege_type='CREATE') as public_create")).rows[0].public_create).toBe(false);
    await c.query('create table smoke(id int); insert into smoke values (1)');
    expect((await c.query('select * from smoke')).rows).toEqual([{ id: 1 }]);
    if (!schemaOwner) await c.query('comment on schema public is $$owned$$');
  } finally { await c.end(); }
}

it('keeps manager privileges to grant CREATE when schema ownership cannot be transferred', async () => {
  await template(manager);
  await provision(admin, manager);
});

it('uses manager GRANT OPTION when a hosted schema belongs to another role', async () => {
  await template('dev');
  await withAdmin(root, 'template1', async c => {
    await c.query(`grant usage, create on schema public to ${q(manager)} with grant option`);
  });
  await provision(admin, 'dev');
});

it('keeps superuser privileges when a hardened template schema belongs to the superuser', async () => {
  await template('dev');
  await provision(root);
});

it('uses the database owner when public belongs to pg_database_owner', async () => {
  await template('pg_database_owner');
  await provision(admin);
});

it('creates a missing public schema as the database owner', async () => {
  await template();
  await provision(admin);
});

it('still rejects a schema that neither the manager nor the database owner can repair', async () => {
  await template('dev');
  await expect(provision(admin)).rejects.toThrow(/public schema 上没有 CREATE 权限/);
});
