/** CLI 更新检测端到端测试（决策 26）：响应头搭车、指纹随订阅/版本变化、version.json */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_VERSION, CLI_VERSION_HEADER, CLIENT_HEADER, SKILL_VERSION_HEADER } from '@eat/shared';
import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/auth/auth.decorators';
import { SkillsService } from '../src/skills/skills.service';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let authorToken: string;
let readerToken: string;
let authorUser: AuthUser;
let readerUser: AuthUser;

/** asCli=false 模拟控制台请求（不带 x-eat-client） */
async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { token?: string; payload?: unknown; asCli?: boolean } = {},
) {
  const res = await app.inject({
    method,
    url,
    payload: opts.payload as never,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.asCli === false ? {} : { [CLIENT_HEADER]: `eat-cli/${CLI_VERSION}` }),
    },
  });
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : undefined,
    headers: res.headers as Record<string, string | undefined>,
  };
}

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  const created = await db
    .insert(schema.users)
    .values([
      { name: '作者', email: 'author@test.dev', role: 'member', passwordHash: hash },
      { name: '读者', email: 'reader@test.dev', role: 'member', passwordHash: hash },
    ])
    .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name });
  const asAuthUser = (email: string): AuthUser => {
    const row = created.find((u) => u.email === email)!;
    return { id: row.id, name: row.name, email: row.email, role: 'member', tokenId: '' };
  };
  authorUser = asAuthUser('author@test.dev');
  readerUser = asAuthUser('reader@test.dev');
  await pool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  authorToken = (
    await api('POST', '/api/auth/login', { payload: { email: 'author@test.dev', password: 'password123' } })
  ).body.token;
  readerToken = (
    await api('POST', '/api/auth/login', { payload: { email: 'reader@test.dev', password: 'password123' } })
  ).body.token;
});

afterAll(async () => {
  await app?.close();
});

const basePush = {
  slug: 'update-check-demo',
  name: '更新检测样例',
  description: '用于验证 Skill 集合指纹随版本变化',
  content: '# demo\n\n初版内容',
  files: [],
};

describe('更新检测响应头搭车', () => {
  it('CLI 请求带回 CLI 版本与 Skill 指纹两个头', async () => {
    const res = await api('GET', '/api/skills', { token: authorToken });
    expect(res.status).toBe(200);
    expect(res.headers[CLI_VERSION_HEADER]).toBe(CLI_VERSION);
    expect(res.headers[SKILL_VERSION_HEADER]).toMatch(/^[0-9a-f]{16}$/);
  });

  it('响应头里的指纹就是服务层算出来的那个（端到端接线正确）', async () => {
    const res = await api('GET', '/api/skills', { token: readerToken });
    expect(res.headers[SKILL_VERSION_HEADER]).toBe(await computeFor(readerUser));
  });

  it('控制台请求（无 x-eat-client）不带这两个头，不为它多查一次库', async () => {
    const res = await api('GET', '/api/skills', { token: authorToken, asCli: false });
    expect(res.status).toBe(200);
    expect(res.headers[CLI_VERSION_HEADER]).toBeUndefined();
    expect(res.headers[SKILL_VERSION_HEADER]).toBeUndefined();
  });

  it('未登录的 CLI 请求仍拿得到 CLI 版本头（Skill 指纹是 per-user 的，此时没有）', async () => {
    const res = await api('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.headers[CLI_VERSION_HEADER]).toBe(CLI_VERSION);
    expect(res.headers[SKILL_VERSION_HEADER]).toBeUndefined();
  });

  it('业务请求失败时也带回 CLI 版本头（异常路径复用同一个 reply）', async () => {
    const res = await api('GET', '/api/skills/不存在的-slug', { token: authorToken });
    expect(res.status).toBe(404);
    expect(res.headers[CLI_VERSION_HEADER]).toBe(CLI_VERSION);
  });
});

describe('Skill 集合指纹：三类变化都要能被发现', () => {
  /** 从响应头读指纹（走拦截器与它的 60 秒缓存） */
  const fingerprint = async (token: string): Promise<string> => {
    const res = await api('GET', '/api/health', { token });
    return res.headers[SKILL_VERSION_HEADER] ?? '';
  };

  it('同一用户重复请求指纹稳定', async () => {
    expect(await fingerprint(readerToken)).toBe(await fingerprint(readerToken));
  });

  it('新建 Skill 会改变作者的指纹（集合新增）', async () => {
    const before = await fingerprint(authorToken);
    const push = await api('POST', '/api/skills/push', { token: authorToken, payload: basePush });
    expect(push.status).toBe(201);
    const after = await computeFor(authorUser);
    expect(after).not.toBe(before);
  });

  it('Skill 出新版本会改变指纹（版本递增）', async () => {
    const before = await computeFor(authorUser);
    const push = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { ...basePush, content: '# demo\n\n第二版内容' },
    });
    expect(push.status).toBe(201);
    expect(await computeFor(authorUser)).not.toBe(before);
  });

  it('订阅与退订都会改变订阅者的指纹', async () => {
    const before = await computeFor(readerUser);
    expect((await api('POST', `/api/skills/${basePush.slug}/subscribe`, { token: readerToken })).status).toBe(201);
    const subscribed = await computeFor(readerUser);
    expect(subscribed).not.toBe(before);

    expect((await api('DELETE', `/api/skills/${basePush.slug}/subscribe`, { token: readerToken })).status).toBe(200);
    expect(await computeFor(readerUser)).toBe(before);
  });

  it('不同用户的指纹相互独立（Skill 更新本就是 per-user 的）', async () => {
    expect(await computeFor(authorUser)).not.toBe(await computeFor(readerUser));
  });
});

/**
 * 直接问服务层要指纹：绕开拦截器的 60 秒 per-user 缓存。
 * 这几个用例验证的是「变化能不能被算出来」，而不是「缓存什么时候过期」。
 */
async function computeFor(user: AuthUser): Promise<string> {
  return app.get(SkillsService).bundleVersion(user);
}

describe('version.json：未登录场景的版本入口', () => {
  it('免鉴权返回平台当前分发的 CLI 版本与下载地址', async () => {
    const res = await api('GET', '/install/version.json');
    expect(res.status).toBe(200);
    expect(res.body.cli).toBe(CLI_VERSION);
    expect(res.body.url).toMatch(/\/install\/eat\.js$/);
  });
});
