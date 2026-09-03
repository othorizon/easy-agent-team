/** Skill 模块端到端测试：推送/版本/可见性/订阅/sync-bundle/防护 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let authorToken: string;
let readerToken: string;

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { token?: string; payload?: unknown } = {},
) {
  const res = await app.inject({
    method,
    url,
    payload: opts.payload as never,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '作者', email: 'author@test.dev', role: 'member', passwordHash: hash },
    { name: '读者', email: 'reader@test.dev', role: 'member', passwordHash: hash },
  ]);
  await pool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  authorToken = (await api('POST', '/api/auth/login', { payload: { email: 'author@test.dev', password: 'password123' } })).body.token;
  readerToken = (await api('POST', '/api/auth/login', { payload: { email: 'reader@test.dev', password: 'password123' } })).body.token;
});

afterAll(async () => {
  await app?.close();
});

const basePush = {
  slug: 'weekly-report',
  name: '运营周报生成',
  description: '根据运营数据生成周报，适用于每周一汇报',
  content: '# 周报生成\n\n按模板整理数据并输出周报。',
  files: [
    { path: 'scripts/fetch.sh', content: '#!/bin/sh\necho data', encoding: 'utf8', executable: true },
    { path: 'templates/report.md', content: '# 模板', encoding: 'utf8' },
  ],
};

describe('推送与版本', () => {
  it('首次推送创建 skill（v1），但不自动订阅（订阅由用户自行决定）', async () => {
    const r = await api('POST', '/api/skills/push', { token: authorToken, payload: basePush });
    expect(r.status).toBe(201);
    expect(r.body.currentVersion).toBe(1);
    expect(r.body.subscribed).toBe(false);
    expect(r.body.files).toHaveLength(2);
    // 没订阅 = 不进自己的 sync 范围，作者身份不代表自动落到本地
    const bundle = await api('GET', '/api/skills/sync-bundle', { token: authorToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).not.toContain('weekly-report');
  });

  it('作者自行订阅后才进入自己的 sync 范围（relation=own）', async () => {
    expect((await api('POST', '/api/skills/weekly-report/subscribe', { token: authorToken })).status).toBe(201);
    const bundle = await api('GET', '/api/skills/sync-bundle', { token: authorToken });
    expect(bundle.body.find((s: { slug: string }) => s.slug === 'weekly-report').relation).toBe('own');
  });

  it('退订自己的 skill 后再推新版本，不会被重新订阅上', async () => {
    expect((await api('DELETE', '/api/skills/weekly-report/subscribe', { token: authorToken })).status).toBe(200);
    const push = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { ...basePush, content: '# 周报生成 v1.1' },
    });
    expect(push.body.subscribed).toBe(false);
    // 后续用例仍以「作者已订阅」为前提，订回来
    expect((await api('POST', '/api/skills/weekly-report/subscribe', { token: authorToken })).status).toBe(201);
  });

  it('再次推送出新版本并更新元信息', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { ...basePush, content: '# 周报生成 v2', changelog: '优化模板' },
    });
    expect(r.body.currentVersion).toBe(3);
    const versions = await api('GET', '/api/skills/weekly-report/versions', { token: authorToken });
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    expect(versions.body[0].changelog).toBe('优化模板');
  });

  it('他人不能对既有 slug 推送新版本', async () => {
    const r = await api('POST', '/api/skills/push', { token: readerToken, payload: basePush });
    expect(r.status).toBe(403);
  });
});

describe('推送防护', () => {
  it('路径穿越被拒绝', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { ...basePush, slug: 'evil', files: [{ path: '../escape.sh', content: 'x' }] },
    });
    expect(r.status).toBe(400);
  });

  it('超大文件被拒绝', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { ...basePush, slug: 'big', files: [{ path: 'big.txt', content: 'x'.repeat(300 * 1024) }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('256KB');
  });

  it('疑似密钥内容被拒绝', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { ...basePush, slug: 'leaky', content: `token: eat_${'a'.repeat(48)}` },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('密钥');
  });
});

describe('可见性与订阅', () => {
  it('团队可见：读者能看到并订阅', async () => {
    const list = await api('GET', '/api/skills', { token: readerToken });
    expect(list.body.map((s: { slug: string }) => s.slug)).toContain('weekly-report');
    const sub = await api('POST', '/api/skills/weekly-report/subscribe', { token: readerToken });
    expect(sub.status).toBe(201);
  });

  it('sync-bundle 包含订阅的 skill 与当前版本内容', async () => {
    const r = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    const item = r.body.find((s: { slug: string }) => s.slug === 'weekly-report');
    expect(item).toBeTruthy();
    expect(item.version).toBe(3);
    expect(item.content).toBe('# 周报生成 v2');
    expect(item.relation).toBe('subscribed');
    expect(item.files.find((f: { path: string }) => f.path === 'scripts/fetch.sh').executable).toBe(true);
  });

  it('改为私有后：读者不可见，sync-bundle 中消失', async () => {
    await api('PATCH', '/api/skills/weekly-report', { token: authorToken, payload: { visibility: 'private' } });
    const list = await api('GET', '/api/skills', { token: readerToken });
    expect(list.body.map((s: { slug: string }) => s.slug)).not.toContain('weekly-report');
    const detail = await api('GET', '/api/skills/weekly-report', { token: readerToken });
    expect(detail.status).toBe(404);
    const bundle = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).not.toContain('weekly-report');
    // 作者自己仍在
    const own = await api('GET', '/api/skills/sync-bundle', { token: authorToken });
    expect(own.body.find((s: { slug: string }) => s.slug === 'weekly-report').relation).toBe('own');
  });

  it('退订后从 sync-bundle 消失', async () => {
    await api('PATCH', '/api/skills/weekly-report', { token: authorToken, payload: { visibility: 'team' } });
    await api('DELETE', '/api/skills/weekly-report/subscribe', { token: readerToken });
    const bundle = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).not.toContain('weekly-report');
  });

  it('删除 skill（仅作者），列表与详情随之消失', async () => {
    const forbidden = await api('DELETE', '/api/skills/weekly-report', { token: readerToken });
    expect(forbidden.status).toBe(403);
    const ok = await api('DELETE', '/api/skills/weekly-report', { token: authorToken });
    expect(ok.status).toBe(200);
    const detail = await api('GET', '/api/skills/weekly-report', { token: authorToken });
    expect(detail.status).toBe(404);
  });
});

describe('内置平台使用指南（决策 11）', () => {
  it('对任何用户始终出现在 sync-bundle 首位，relation=builtin', async () => {
    for (const token of [authorToken, readerToken]) {
      const r = await api('GET', '/api/skills/sync-bundle', { token });
      expect(r.status).toBe(200);
      expect(r.body[0].slug).toBe('eat-platform-guide');
      expect(r.body[0].relation).toBe('builtin');
      expect(r.body[0].source).toBe('builtin');
      expect(r.body[0].version).toBeGreaterThanOrEqual(1);
      expect(r.body[0].content).toContain('search_experiences');
      expect(r.body[0].content).toContain('PERMISSION_REQUIRED');
    }
  });

  it('保留 slug：不允许 push 同名 skill', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug: 'eat-platform-guide', name: '假指南', description: 'x', content: '# x', files: [] },
    });
    expect(r.status).toBe(400);
  });
});
