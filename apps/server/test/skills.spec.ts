/** Skill 模块端到端测试：推送/版本/可见性/订阅/sync-bundle/防护 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { repairSkillDescriptions } from '../src/db/repair-descriptions';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let authorToken: string;
let readerToken: string;
let adminToken: string;
let readerId: string;

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
  ]);
  await pool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  authorToken = (await api('POST', '/api/auth/login', { payload: { email: 'author@test.dev', password: 'password123' } })).body.token;
  readerToken = (await api('POST', '/api/auth/login', { payload: { email: 'reader@test.dev', password: 'password123' } })).body.token;
  adminToken = (await api('POST', '/api/auth/login', { payload: { email: 'admin@test.dev', password: 'password123' } })).body.token;
  readerId = (await api('GET', '/api/users', { token: adminToken })).body.find(
    (u: { email: string }) => u.email === 'reader@test.dev',
  ).id;
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
    expect(list.body.items.map((s: { slug: string }) => s.slug)).toContain('weekly-report');
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
    expect(list.body.items.map((s: { slug: string }) => s.slug)).not.toContain('weekly-report');
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

describe('元信息回退到 SKILL.md frontmatter', () => {
  // description 常写成折叠块标量，早期客户端解析不了，只能把 `>-` 本身推上来
  const content = [
    '---',
    'name: pdf-tools',
    'description: >-',
    '  处理 PDF 文件时使用：读取、合并、',
    '  拆分与填表单。',
    '---',
    '',
    '# 正文',
  ].join('\n');
  const folded = '处理 PDF 文件时使用：读取、合并、 拆分与填表单。';

  it('网页创建只贴了正文没填描述时，从 frontmatter 取（显式填的名称不被覆盖）', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug: 'pdf-tools', name: 'PDF 工具', description: '', content, files: [] },
    });
    expect(r.status).toBe(201);
    expect(r.body.description).toBe(folded);
    expect(r.body.name).toBe('PDF 工具');
  });

  it('旧版 CLI 把块标量指示符本身当元信息推上来时，同样回退到 frontmatter', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug: 'pdf-tools-old-cli', name: '>-', description: '>-', content, files: [] },
    });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('pdf-tools');
    expect(r.body.description).toBe(folded);
  });

  it('显式传的描述优先于 frontmatter', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug: 'pdf-tools-explicit', name: 'PDF 工具', description: '我自己写的描述', content, files: [] },
    });
    expect(r.body.description).toBe('我自己写的描述');
  });

  it('推新版本时描述跟着 frontmatter 一起更新（老版本的 `>-` 就此被修好）', async () => {
    const fixed = content.replace('拆分与填表单。', '拆分、填表单与 OCR。');
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug: 'pdf-tools-old-cli', name: '>-', description: '>-', content: fixed, files: [] },
    });
    expect(r.body.description).toBe('处理 PDF 文件时使用：读取、合并、 拆分、填表单与 OCR。');
  });
});

describe('不传 name / description 时保持平台上的原值（决策 44）', () => {
  const slug = 'keep-meta';
  // 目录里只有正文、没写 frontmatter：CLI 此时既读不到 name 也读不到 description，两个字段都不传
  const bare = '# 正文\n\n没有 frontmatter 的 skill 目录。';

  it('推新版本时不传 name/description → 名称与触发描述原样留着', async () => {
    const created = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug, name: '运营周报生成', description: '每周一汇报时使用', content: '# 初版', files: [] },
    });
    expect(created.status).toBe(201);

    const r = await api('POST', '/api/skills/push', { token: authorToken, payload: { slug, content: bare, files: [] } });
    expect(r.status).toBe(201);
    expect(r.body.currentVersion).toBe(2);
    expect(r.body.name).toBe('运营周报生成');
    expect(r.body.description).toBe('每周一汇报时使用');
  });

  it('正文 frontmatter 写了就以它为准（与在线编辑同一套语义）', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug, content: '---\nname: 周报生成 v2\ndescription: 改过的触发描述\n---\n\n正文', files: [] },
    });
    expect(r.body.name).toBe('周报生成 v2');
    expect(r.body.description).toBe('改过的触发描述');
  });

  it('新建时没有原值可留：name 回落到 slug', async () => {
    const r = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug: 'brand-new-no-meta', content: bare, files: [] },
    });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('brand-new-no-meta');
    expect(r.body.description).toBe('');
  });
});

describe('存量数据订正（启动时随迁移跑）', () => {
  // 决策 36 的解析器只影响「之后推的版本」，已经躺在库里的坏描述得靠这一步修
  const content = ['---', 'name: legacy-skill', 'description: >-', '  旧版 CLI 推坏的描述，', '  真正的内容在正文 frontmatter 里。', '---', '', '# 正文'].join('\n');

  it('把 `>-` 与空描述按 SKILL.md 正文重新解析回来，正常的行不动', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool, { schema });
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.email, 'author@test.dev'));

    // 直接造三行存量数据：坏的 `>-`、空描述、以及一条正常的
    const seeded = await db
      .insert(schema.skills)
      .values([
        { slug: 'legacy-block', name: 'legacy-skill', description: '>-', ownerId: owner.id, currentVersion: 1 },
        { slug: 'legacy-empty', name: 'legacy-skill', description: '', ownerId: owner.id, currentVersion: 1 },
        { slug: 'legacy-ok', name: 'legacy-skill', description: '本来就是好的', ownerId: owner.id, currentVersion: 1 },
      ])
      .returning();
    await db.insert(schema.skillVersions).values(
      seeded.map((row) => ({ skillId: row.id, version: 1, content, createdBy: owner.id })),
    );

    const repaired = await repairSkillDescriptions(db);
    expect(repaired.map((r) => r.slug).sort()).toEqual(['legacy-block', 'legacy-empty']);

    const after = await db.select().from(schema.skills).where(inArray(schema.skills.slug, ['legacy-block', 'legacy-empty', 'legacy-ok']));
    const bySlug = Object.fromEntries(after.map((r) => [r.slug, r.description]));
    expect(bySlug['legacy-block']).toBe('旧版 CLI 推坏的描述， 真正的内容在正文 frontmatter 里。');
    expect(bySlug['legacy-empty']).toBe('旧版 CLI 推坏的描述， 真正的内容在正文 frontmatter 里。');
    expect(bySlug['legacy-ok']).toBe('本来就是好的');

    // 幂等：再跑一次没有可订正的行
    expect(await repairSkillDescriptions(db)).toEqual([]);
    await pool.end();
  });
});

describe('清单筛选与分页（决策 37）', () => {
  const slugs = ['flt-alpha', 'flt-beta', 'flt-gamma'];

  beforeAll(async () => {
    for (const slug of slugs) {
      await api('POST', '/api/skills/push', {
        token: authorToken,
        payload: { slug, name: `筛选测试 ${slug}`, description: `关键词 zebra ${slug}`, content: `# ${slug}` },
      });
    }
    // 读者自己的一条私有 skill，用来验证 scope=mine 与 kind=private
    await api('POST', '/api/skills/push', {
      token: readerToken,
      payload: { slug: 'flt-mine', name: '读者私有', description: '关键词 zebra 私有', content: '# mine', visibility: 'private' },
    });
    await api('POST', '/api/skills/flt-alpha/subscribe', { token: readerToken });
  });

  it('返回分页信封，pageSize 生效且 total 是筛选后的总数', async () => {
    const r = await api('GET', '/api/skills?q=zebra&pageSize=2', { token: readerToken });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.total).toBe(4);
    expect(r.body.page).toBe(1);
    expect(r.body.pageSize).toBe(2);
  });

  it('翻页取到的是不同条目，且各页并集等于全量', async () => {
    const p1 = await api('GET', '/api/skills?q=zebra&pageSize=2&page=1', { token: readerToken });
    const p2 = await api('GET', '/api/skills?q=zebra&pageSize=2&page=2', { token: readerToken });
    const all = [...p1.body.items, ...p2.body.items].map((s: { slug: string }) => s.slug);
    expect(new Set(all).size).toBe(4);
    expect(all).toEqual(expect.arrayContaining([...slugs, 'flt-mine']));
    // 越界页返回空列表而不是报错，total 不变（前端跳页时不必先校验上界）
    const p9 = await api('GET', '/api/skills?q=zebra&pageSize=2&page=9', { token: readerToken });
    expect(p9.body.items).toHaveLength(0);
    expect(p9.body.total).toBe(4);
  });

  it('关键词匹配 slug / 名称 / 触发描述，大小写不敏感', async () => {
    const bySlug = await api('GET', '/api/skills?q=FLT-BETA', { token: readerToken });
    expect(bySlug.body.items.map((s: { slug: string }) => s.slug)).toEqual(['flt-beta']);
    const byName = await api('GET', '/api/skills?q=读者私有', { token: readerToken });
    expect(byName.body.items.map((s: { slug: string }) => s.slug)).toEqual(['flt-mine']);
  });

  it('scope 按订阅关系与归属过滤', async () => {
    const mine = await api('GET', '/api/skills?scope=mine', { token: readerToken });
    expect(mine.body.items.map((s: { slug: string }) => s.slug)).toEqual(['flt-mine']);
    const subscribed = await api('GET', '/api/skills?scope=subscribed&q=zebra', { token: readerToken });
    expect(subscribed.body.items.map((s: { slug: string }) => s.slug)).toEqual(['flt-alpha']);
    const unsubscribed = await api('GET', '/api/skills?scope=unsubscribed&q=zebra', { token: readerToken });
    expect(unsubscribed.body.items.map((s: { slug: string }) => s.slug)).not.toContain('flt-alpha');
  });

  it('counts 给出各范围的条数，关键词参与、scope 自身不参与（决策 38）', async () => {
    const all = await api('GET', '/api/skills?q=zebra', { token: readerToken });
    expect(all.body.counts).toEqual({ all: 4, subscribed: 1, unsubscribed: 3, mine: 1 });
    // 切到某个范围后 total 变、counts 不变——分段切换上的数字就是靠这点稳定的
    const scoped = await api('GET', '/api/skills?q=zebra&scope=subscribed', { token: readerToken });
    expect(scoped.body.total).toBe(1);
    expect(scoped.body.counts).toEqual(all.body.counts);
    // kind 参与计数：私有只有读者自己那条
    const priv = await api('GET', '/api/skills?q=zebra&kind=private', { token: readerToken });
    expect(priv.body.counts).toEqual({ all: 1, subscribed: 0, unsubscribed: 1, mine: 1 });
  });

  it('kind 按可见性 / 来源筛选', async () => {
    const priv = await api('GET', '/api/skills?kind=private', { token: readerToken });
    expect(priv.body.items.map((s: { slug: string }) => s.slug)).toEqual(['flt-mine']);
    const team = await api('GET', '/api/skills?kind=team&q=zebra', { token: readerToken });
    expect(team.body.items.map((s: { slug: string }) => s.slug)).not.toContain('flt-mine');
  });

  it('pageSize 超上限与非法 scope 取值被拒', async () => {
    expect((await api('GET', '/api/skills?pageSize=1001', { token: readerToken })).status).toBe(400);
    expect((await api('GET', '/api/skills?scope=nope', { token: readerToken })).status).toBe(400);
    // 上限本身可用：CLI 用它一次拉全
    expect((await api('GET', '/api/skills?pageSize=1000', { token: readerToken })).status).toBe(200);
  });
});

describe('捆绑模式（决策 37）', () => {
  const slug = 'bundle-kit';

  beforeAll(async () => {
    await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug, name: '全员必装', description: '捆绑测试', content: '# bundle' },
    });
  });

  it('仅管理员可设捆绑：作者与普通成员都被拒', async () => {
    const byAuthor = await api('PATCH', `/api/skills/${slug}`, { token: authorToken, payload: { bundled: true } });
    expect(byAuthor.status).toBe(403);
    const byReader = await api('PATCH', `/api/skills/${slug}`, { token: readerToken, payload: { bundled: true } });
    expect(byReader.status).toBe(403);
  });

  it('捆绑要求团队可见：私有 skill 不能捆绑', async () => {
    await api('PATCH', `/api/skills/${slug}`, { token: authorToken, payload: { visibility: 'private' } });
    const r = await api('PATCH', `/api/skills/${slug}`, { token: adminToken, payload: { bundled: true } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_FAILED');
    await api('PATCH', `/api/skills/${slug}`, { token: authorToken, payload: { visibility: 'team' } });
  });

  it('管理员开启捆绑后：成员恒为已订阅、订阅被锁定，sync-bundle 带上且 relation=bundled', async () => {
    const r = await api('PATCH', `/api/skills/${slug}`, { token: adminToken, payload: { bundled: true } });
    expect(r.status).toBe(200);
    expect(r.body.bundled).toBe(true);

    const list = await api('GET', `/api/skills?q=${slug}`, { token: readerToken });
    const item = list.body.items[0];
    expect(item.bundled).toBe(true);
    expect(item.subscribed).toBe(true);
    expect(item.subscriptionLocked).toBe(true);

    const bundle = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    expect(bundle.body.find((s: { slug: string }) => s.slug === slug).relation).toBe('bundled');
  });

  it('成员退订被拒（SKILL_BUNDLED），退不掉也不影响 sync', async () => {
    const r = await api('DELETE', `/api/skills/${slug}/subscribe`, { token: readerToken });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('SKILL_BUNDLED');
    const bundle = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).toContain(slug);
  });

  it('捆绑期间不能改为私有（否则会「被强制订阅却看不到」）', async () => {
    const r = await api('PATCH', `/api/skills/${slug}`, { token: adminToken, payload: { visibility: 'private' } });
    expect(r.status).toBe(400);
  });

  it('管理员自己不受捆绑影响：默认未订阅、可自由订阅与退订', async () => {
    const list = await api('GET', `/api/skills?q=${slug}`, { token: adminToken });
    expect(list.body.items[0].subscribed).toBe(false);
    expect(list.body.items[0].subscriptionLocked).toBe(false);
    let bundle = await api('GET', '/api/skills/sync-bundle', { token: adminToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).not.toContain(slug);

    await api('POST', `/api/skills/${slug}/subscribe`, { token: adminToken });
    bundle = await api('GET', '/api/skills/sync-bundle', { token: adminToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).toContain(slug);

    expect((await api('DELETE', `/api/skills/${slug}/subscribe`, { token: adminToken })).status).toBe(200);
    bundle = await api('GET', '/api/skills/sync-bundle', { token: adminToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).not.toContain(slug);
  });

  it('kind=bundled 能筛出捆绑 skill', async () => {
    const r = await api('GET', '/api/skills?kind=bundled', { token: readerToken });
    expect(r.body.items.map((s: { slug: string }) => s.slug)).toEqual([slug]);
  });

  it('取消捆绑后成员回到未订阅，sync-bundle 里消失', async () => {
    const r = await api('PATCH', `/api/skills/${slug}`, { token: adminToken, payload: { bundled: false } });
    expect(r.body.bundled).toBe(false);
    const list = await api('GET', `/api/skills?q=${slug}`, { token: readerToken });
    expect(list.body.items[0].subscribed).toBe(false);
    const bundle = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).not.toContain(slug);
  });
});

describe('订阅人数与订阅者管理（决策 37）', () => {
  const slug = 'subs-kit';

  beforeAll(async () => {
    await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: { slug, name: '订阅者测试', description: '统计与代订阅', content: '# subs' },
    });
  });

  it('订阅人数按有效同步人数统计', async () => {
    const before = await api('GET', `/api/skills?q=${slug}`, { token: authorToken });
    expect(before.body.items[0].subscriberCount).toBe(0);
    await api('POST', `/api/skills/${slug}/subscribe`, { token: readerToken });
    const after = await api('GET', `/api/skills?q=${slug}`, { token: authorToken });
    expect(after.body.items[0].subscriberCount).toBe(1);
    // 详情页与清单口径一致
    const detail = await api('GET', `/api/skills/${slug}`, { token: authorToken });
    expect(detail.body.subscriberCount).toBe(1);
  });

  it('订阅者明细仅管理员可读，作者也不行', async () => {
    expect((await api('GET', `/api/skills/${slug}/subscribers`, { token: authorToken })).status).toBe(403);
    const r = await api('GET', `/api/skills/${slug}/subscribers`, { token: adminToken });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      expect.objectContaining({ email: 'reader@test.dev', source: 'manual', removable: true }),
    ]);
  });

  it('管理员可代他人订阅与取消订阅，对方 sync-bundle 随之变化', async () => {
    const removed = await api('DELETE', `/api/skills/${slug}/subscribers/${readerId}`, { token: adminToken });
    expect(removed.status).toBe(200);
    let bundle = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).not.toContain(slug);

    const added = await api('POST', `/api/skills/${slug}/subscribers`, { token: adminToken, payload: { userId: readerId } });
    expect(added.status).toBe(201);
    bundle = await api('GET', '/api/skills/sync-bundle', { token: readerToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).toContain(slug);
  });

  it('成员不能替别人订阅', async () => {
    const r = await api('POST', `/api/skills/${slug}/subscribers`, { token: authorToken, payload: { userId: readerId } });
    expect(r.status).toBe(403);
  });

  it('私有 skill 不能代订阅（对方看不到）', async () => {
    await api('PATCH', `/api/skills/${slug}`, { token: authorToken, payload: { visibility: 'private' } });
    const r = await api('POST', `/api/skills/${slug}/subscribers`, { token: adminToken, payload: { userId: readerId } });
    expect(r.status).toBe(400);
    await api('PATCH', `/api/skills/${slug}`, { token: authorToken, payload: { visibility: 'team' } });
  });

  it('捆绑 skill：人数含全体成员，且不能单独增减', async () => {
    await api('PATCH', `/api/skills/${slug}`, { token: adminToken, payload: { bundled: true } });
    const list = await api('GET', `/api/skills?q=${slug}`, { token: adminToken });
    // 作者与读者两名成员（管理员自己没订阅，不计入）
    expect(list.body.items[0].subscriberCount).toBe(2);
    const subs = await api('GET', `/api/skills/${slug}/subscribers`, { token: adminToken });
    expect(subs.body.every((r: { removable: boolean }) => !r.removable)).toBe(true);
    expect(subs.body.find((r: { email: string }) => r.email === 'author@test.dev').source).toBe('bundled');

    const add = await api('POST', `/api/skills/${slug}/subscribers`, { token: adminToken, payload: { userId: readerId } });
    expect(add.body.error).toBe('SKILL_BUNDLED');
    const remove = await api('DELETE', `/api/skills/${slug}/subscribers/${readerId}`, { token: adminToken });
    expect(remove.body.error).toBe('SKILL_BUNDLED');
    await api('PATCH', `/api/skills/${slug}`, { token: adminToken, payload: { bundled: false } });
  });

  it('禁用的用户不计入人数，也不能为其订阅', async () => {
    await api('PATCH', `/api/users/${readerId}`, { token: adminToken, payload: { status: 'disabled' } });
    const list = await api('GET', `/api/skills?q=${slug}`, { token: adminToken });
    expect(list.body.items[0].subscriberCount).toBe(0);
    const r = await api('POST', `/api/skills/${slug}/subscribers`, { token: adminToken, payload: { userId: readerId } });
    expect(r.status).toBe(400);
    await api('PATCH', `/api/users/${readerId}`, { token: adminToken, payload: { status: 'active' } });
  });
});


describe('控制台在线编辑 SKILL.md（决策 42）', () => {
  const slug = 'edit-online';
  const withFm = (body: string) => `---\nname: 在线编辑\ndescription: 用来验证在线编辑\n---\n\n${body}`;
  // 上一个 describe 停用过 reader，停用会吊销 token，这里重新登一次拿有效的
  let memberToken = '';
  beforeAll(async () => {
    memberToken = (await api('POST', '/api/auth/login', { payload: { email: 'reader@test.dev', password: 'password123' } }))
      .body.token;
  });

  it('作者编辑正文 → 新版本、附属文件沿用、changelog 进版本历史', async () => {
    const created = await api('POST', '/api/skills/push', {
      token: authorToken,
      payload: {
        slug,
        name: '在线编辑',
        description: '用来验证在线编辑',
        content: withFm('原始正文'),
        files: [{ path: 'ref.md', content: '# 附件', encoding: 'utf8' }],
      },
    });
    expect(created.body.currentVersion).toBe(1);

    const r = await api('PUT', `/api/skills/${slug}/content`, {
      token: authorToken,
      payload: { content: withFm('改过的正文'), changelog: '补充了排查步骤', baseVersion: 1 },
    });
    expect(r.status).toBe(200);
    expect(r.body.currentVersion).toBe(2);
    expect(r.body.content).toContain('改过的正文');
    expect(r.body.files).toHaveLength(1); // 附件没在这个入口里传，必须原样留着

    const versions = await api('GET', `/api/skills/${slug}/versions`, { token: authorToken });
    expect(versions.body[0]).toMatchObject({ version: 2, changelog: '补充了排查步骤', createdBy: '作者' });
    // 老版本仍可追溯
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('正文 frontmatter 是元信息事实源：写了就跟着更新，没写就保持原值', async () => {
    const renamed = await api('PUT', `/api/skills/${slug}/content`, {
      token: authorToken,
      payload: {
        content: '---\nname: 改了名字\ndescription: 也改了触发描述\n---\n\n正文',
        baseVersion: 2,
      },
    });
    expect(renamed.body.name).toBe('改了名字');
    expect(renamed.body.description).toBe('也改了触发描述');

    const noFm = await api('PUT', `/api/skills/${slug}/content`, {
      token: authorToken,
      payload: { content: '# 只有正文，没有 frontmatter', baseVersion: 3 },
    });
    expect(noFm.body.name).toBe('改了名字');
    expect(noFm.body.description).toBe('也改了触发描述');
    expect(noFm.body.currentVersion).toBe(4);
  });

  it('管理员可编辑他人的 skill；无关成员 403', async () => {
    expect(
      (await api('PUT', `/api/skills/${slug}/content`, { token: memberToken, payload: { content: '# 我改', baseVersion: 4 } }))
        .status,
    ).toBe(403);
    const byAdmin = await api('PUT', `/api/skills/${slug}/content`, {
      token: adminToken,
      payload: { content: '# 管理员改的', baseVersion: 4 },
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.currentVersion).toBe(5);
  });

  it('基于过期版本编辑被拒（409），内容没变也不产生新版本（400）', async () => {
    const stale = await api('PUT', `/api/skills/${slug}/content`, {
      token: authorToken,
      payload: { content: '# 基于老版本改的', baseVersion: 2 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toContain('v5');

    const same = await api('PUT', `/api/skills/${slug}/content`, {
      token: authorToken,
      payload: { content: '# 管理员改的', baseVersion: 5 },
    });
    expect(same.status).toBe(400);
    expect((await api('GET', `/api/skills/${slug}`, { token: authorToken })).body.currentVersion).toBe(5);
  });

  it('密钥扫描同样生效', async () => {
    const r = await api('PUT', `/api/skills/${slug}/content`, {
      token: authorToken,
      payload: { content: `token: eat_${'a'.repeat(48)}`, baseVersion: 5 },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('密钥');
  });
});
