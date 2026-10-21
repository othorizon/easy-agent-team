process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://dev@127.0.0.1:5433/eat_test";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import * as bcrypt from "bcryptjs";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { DbsService } from "../src/dbs/dbs.service";
import { RequestNotifications } from "../src/requests/requests.notifications";
import { WebhookService } from "../src/notify/webhook.service";
import { createRequestActionToken } from '../src/requests/request-action-link';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let app: NestFastifyApplication;
const ids = {
  admin: randomUUID(),
  owner: randomUUID(),
  member: randomUUID(),
  other: randomUUID(),
};
const tokens: Record<string, string> = {};
const legacyEnv = randomUUID();
async function api(
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  who = "admin",
  payload?: unknown,
) {
  const r = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokens[who]}` },
    payload: payload as never,
  });
  return { status: r.statusCode, body: r.json() };
}
async function list(who = "admin", q = "scope=inbox") {
  const r = await api("GET", "/api/requests?" + q, who);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function latest(type: string, sourceId: string) {
  return (
    await pool.query(
      "SELECT * FROM approval_request WHERE type=$1 AND source_id=$2 AND latest",
      [type, sourceId],
    )
  ).rows[0];
}
async function envRequest(reason = "需要配置", keys = ["TOKEN"]) {
  const r = await api("POST", "/api/access-requests", "member", {
    environmentSlug: "request-env",
    keys,
    reason,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
beforeAll(async () => {
  await pool.query(
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE",
  );
  const dir = await mkdtemp(join(tmpdir(), "eat-approvals-migration-"));
  try {
    await cp(resolve("drizzle"), dir, { recursive: true });
    const j = JSON.parse(
      await readFile(join(dir, "meta/_journal.json"), "utf8"),
    );
    j.entries = j.entries.filter((e: any) => e.idx < 31);
    await writeFile(join(dir, "meta/_journal.json"), JSON.stringify(j));
    await migrate(drizzle(pool), { migrationsFolder: dir });
    const hash = await bcrypt.hash("password123", 4);
    for (const [name, id] of Object.entries(ids))
      await pool.query(
        'INSERT INTO "user"(id,name,email,role,password_hash) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          name,
          `${name}@requests.test`,
          name === "admin" ? "admin" : "member",
          hash,
        ],
      );
    await pool.query(
      "INSERT INTO environment(id,slug,name,owner_id) VALUES($1,$2,$3,$4)",
      [legacyEnv, "legacy-env", "旧环境", ids.owner],
    );
    // Multiple old pending rows must migrate to a single actionable round.
    for (let i = 0; i < 3; i++)
      await pool.query(
        `INSERT INTO access_request(requester_id,environment_id,keys,reason,created_at) VALUES($1,$2,'["A","B"]',$3,now()+$4::int*interval '1 second')`,
        [ids.member, legacyEnv, "旧申请" + i, i],
      );
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const mod = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  for (const name of Object.keys(ids))
    tokens[name] = (
      await api("POST", "/api/auth/login", name, {
        email: `${name}@requests.test`,
        password: "password123",
      })
    ).body.token;
  await api("POST", "/api/envs", "owner", {
    slug: "request-env",
    name: "审批测试环境",
    description: "测试",
  });
  await api("POST", "/api/envs/request-env/variables", "owner", {
    key: "TOKEN",
    value: "do-not-expose",
    description: "凭据",
  });
  await api("POST", "/api/envs/request-env/variables", "owner", {
    key: "SECOND",
    value: "do-not-expose-2",
    description: "凭据",
  });
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});

it("迁移合并旧待办，未知审批信息不补造，不发送历史通知", async () => {
  const rows = (
    await pool.query(
      "SELECT * FROM approval_request WHERE resource_id=$1 ORDER BY round",
      [legacyEnv],
    )
  ).rows;
  expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
  expect(rows.every((r) => r.rejection_reason === null)).toBe(true);
  expect(
    (await pool.query("SELECT * FROM approval_notification")).rows,
  ).toHaveLength(0);
});
let envSource: string, envId: string;
it("申请人、资源 owner 与管理员拥有正确可见范围，拒绝无关用户和空理由", async () => {
  envSource = (await envRequest()).id;
  envId = (await latest("env", envSource)).id;
  expect((await list("owner")).items.some((r: any) => r.id === envId)).toBe(
    true,
  );
  expect((await list("other")).items).toHaveLength(0);
  expect((await api("GET", "/api/requests/" + envId, "other")).status).toBe(
    404,
  );
  expect(
    (
      await api("POST", `/api/requests/${envId}/decision`, "member", {
        decision: "approved",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await api("POST", `/api/requests/${envId}/decision`, "owner", {
        decision: "rejected",
        reason: "  ",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api("POST", `/api/access-requests/${envSource}/decision`, "owner", {
        decision: "rejected",
      })
    ).status,
  ).toBe(400);
  const duplicate = await envRequest("重复请求");
  expect(duplicate.id).toBe(envSource);
});
it("驳回原因同步网页、旧接口和完整历史；重新申请不覆盖旧轮次", async () => {
  const reject = await api("POST", `/api/requests/${envId}/decision`, "owner", {
    decision: "rejected",
    reason: "请说明使用环境",
  });
  expect(reject.status, JSON.stringify(reject.body)).toBe(201);
  expect(reject.body.request.rejectionReason).toBe("请说明使用环境");
  expect(
    (await api("GET", `/api/access-requests/${envSource}`, "member")).body
      .rejectionReason,
  ).toBe("请说明使用环境");
  expect(
    (await list("member", "scope=mine&status=rejected")).items.some(
      (r: any) => r.id === envId,
    ),
  ).toBe(true);
  const next = await api("POST", `/api/requests/${envId}/resubmit`, "member", {
    reason: "用于预发布验证",
  });
  expect(next.status, JSON.stringify(next.body)).toBe(201);
  expect(next.body.rounds).toHaveLength(2);
  expect(next.body.rounds[1].rejectionReason).toBe("请说明使用环境");
  envId = next.body.request.id;
  expect(
    (await list("member", "scope=mine&type=env")).items.filter(
      (r: any) => r.sourceId === envSource,
    ),
  ).toHaveLength(1);
});
it("新旧审批入口并发只授权一次，申请人可读取全部信息但看不到密钥值", async () => {
  const results = await Promise.all([
    api("POST", `/api/requests/${envId}/decision`, "owner", {
      decision: "approved",
    }),
    api("POST", `/api/access-requests/${envSource}/decision`, "admin", {
      decision: "approved",
    }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(
    (
      await pool.query("SELECT * FROM variable_grant WHERE user_id=$1", [
        ids.member,
      ])
    ).rows,
  ).toHaveLength(1);
  const detail = (await api("GET", "/api/requests/" + envId, "member")).body;
  expect(JSON.stringify(detail)).not.toContain("do-not-expose");
  expect(detail.request.decidedByName).toBeTruthy();
  expect(
    (await api("POST", `/api/requests/${envId}/withdraw`, "member")).status,
  ).toBe(409);
});
it("撤回、提醒限频、重新申请与删除资源失效", async () => {
  const src = (await envRequest("第二个变量", ["SECOND"])).id;
  const r = await latest("env", src);
  expect(
    (await api("POST", `/api/requests/${r.id}/remind`, "member", {})).status,
  ).toBe(201);
  expect(
    (await api("POST", `/api/requests/${r.id}/remind`, "member", {})).status,
  ).toBe(409);
  expect(
    (await api("POST", `/api/requests/${r.id}/withdraw`, "other", {})).status,
  ).toBe(404);
  expect(
    (await api("POST", `/api/requests/${r.id}/withdraw`, "member", {})).body
      .request.status,
  ).toBe("withdrawn");
  expect(
    (
      await api("POST", `/api/access-requests/${src}/decision`, "admin", {
        decision: "approved",
      })
    ).status,
  ).toBe(409);
  const next = await api("POST", `/api/requests/${r.id}/resubmit`, "member", {
    reason: "恢复需求",
  });
  expect(next.status).toBe(201);
  await pool.query("DELETE FROM environment WHERE id=$1", [legacyEnv]);
  const legacy = (await list("member", "scope=mine&status=invalid")).items.find(
    (r: any) => r.resourceId === legacyEnv,
  );
  expect(legacy.status).toBe("invalid");
});
it("MCP 退订撤回与重新申请保存独立轮次，owner 变更及时更新审批权限", async () => {
  const created = await api("POST", "/api/mcp-configs", "owner", {
    slug: "review-mcp",
    name: "工具配置",
    description: "测试",
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    visibility: "team",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(
    (
      await api("POST", "/api/mcp-configs/review-mcp/subscribe", "member", {
        reason: "需要工具",
      })
    ).status,
  ).toBe(201);
  const rows = (await list("owner", "scope=inbox&type=mcp")).items;
  expect(rows).toHaveLength(1);
  const r = rows[0];
  expect(
    (
      await api("POST", `/api/requests/${r.id}/decision`, "owner", {
        decision: "rejected",
        reason: "请补充用途",
      })
    ).status,
  ).toBe(201);
  const next = await api("POST", `/api/requests/${r.id}/resubmit`, "member", {
    reason: "排查接口",
  });
  expect(next.status, JSON.stringify(next.body)).toBe(201);
  expect(next.body.rounds).toHaveLength(2);
  await pool.query("UPDATE mcp_config SET owner_id=$2 WHERE id=$1", [
    r.resourceId,
    ids.other,
  ]);
  expect(
    (
      await api(
        "POST",
        `/api/requests/${next.body.request.id}/decision`,
        "owner",
        { decision: "approved" },
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await api(
        "POST",
        `/api/requests/${next.body.request.id}/withdraw`,
        "member",
        {},
      )
    ).body.request.status,
  ).toBe("withdrawn");
  expect(
    (
      await api(
        "POST",
        `/api/requests/${next.body.request.id}/resubmit`,
        "member",
        { reason: "再次需要" },
      )
    ).body.rounds,
  ).toHaveLength(3);
});
it("应用自动进入审批，换分支不重审，换仓库作废旧申请，撤销后必须显式重新申请", async () => {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app(id,slug,name,owner_id,dokploy_application_id,repo_url) VALUES($1,'approval-app','测试应用',$2,'mock-app','https://github.com/eat/one')`,
    [id, ids.member],
  );
  let r = await latest("app", id);
  expect(r.status).toBe("pending");
  await pool.query("UPDATE app SET branch='develop' WHERE id=$1", [id]);
  expect((await latest("app", id)).id).toBe(r.id);
  await pool.query(
    "UPDATE app SET repo_url='https://github.com/eat/two',repo_version=2 WHERE id=$1",
    [id],
  );
  expect(
    (
      await api("POST", `/api/requests/${r.id}/decision`, "admin", {
        decision: "approved",
      })
    ).status,
  ).toBe(409);
  r = await latest("app", id);
  expect(r.round).toBe(2);
  expect(
    (
      await api("POST", `/api/requests/${r.id}/decision`, "admin", {
        decision: "approved",
      })
    ).body.request.status,
  ).toBe("approved");
  await api("DELETE", "/api/apps/approval-app/approve");
  expect((await list("admin", "scope=inbox&type=app")).items).toHaveLength(0);
  expect(
    (await api("GET", "/api/requests/" + r.id, "member")).body.request
      .canResubmit,
  ).toBe(true);
  const next = await api("POST", `/api/requests/${r.id}/resubmit`, "member", {
    reason: "已修复配置",
  });
  expect(next.status, JSON.stringify(next.body)).toBe(201);
  await pool.query("DELETE FROM app WHERE id=$1", [id]);
  expect(
    (await api("GET", "/api/requests/" + next.body.request.id, "member")).body
      .request.status,
  ).toBe("invalid");
});
it("数据库和 OSS 批准与执行失败分开展示，驳回后重新申请复用安全的资源标识", async () => {
  const instance = randomUUID(),
    dbid = randomUUID(),
    ossid = randomUUID();
  await pool.query(
    `INSERT INTO db_instance(id,name,engine,host,port,admin_user,admin_password_encrypted,created_by) VALUES($1,'测试实例','postgres','localhost',5433,'dev','test',$2)`,
    [instance, ids.admin],
  );
  await pool.query(
    `INSERT INTO db_assignment(id,instance_id,requester_id,db_name,db_user,purpose) VALUES($1,$2,$3,'test_review','u_test_review','测试')`,
    [dbid, instance, ids.member],
  );
  const r = await latest("db", dbid);
  await api("POST", `/api/requests/${r.id}/decision`, "admin", {
    decision: "rejected",
    reason: "用途不明确",
  });
  expect(
    (await api("GET", `/api/db/assignments/${dbid}`, "member")).body
      .rejectionReason,
  ).toBe("用途不明确");
  const next = await api("POST", `/api/requests/${r.id}/resubmit`, "member", {
    reason: "测试环境的数据",
  });
  expect(next.status).toBe(201);
  const spy = vi
    .spyOn(app.get(DbsService), "approve")
    .mockImplementation(async (user, id) => {
      await pool.query(
        `UPDATE db_assignment SET status='failed',error='连接失败',decided_by=$2 WHERE id=$1`,
        [id, user.id],
      );
      return {} as never;
    });
  const result = await api(
    "POST",
    `/api/requests/${next.body.request.id}/decision`,
    "admin",
    { decision: "approved" },
  );
  spy.mockRestore();
  expect(result.body.request).toMatchObject({
    status: "approved",
    execution: "failed",
    canResubmit: false,
  });
  await pool.query(
    `INSERT INTO oss_space(id,owner_id,request_id,name,purpose,prefix) VALUES($1,$2,$3,'测试目录','测试用途',$4)`,
    [ossid, ids.member, randomUUID(), ossid + "/"],
  );
  const oss = await latest("oss", ossid);
  expect(
    (
      await api("POST", `/api/requests/${oss.id}/decision`, "owner", {
        decision: "approved",
      })
    ).status,
  ).toBe(404);
  await pool.query(
    `UPDATE oss_space SET status='provisioning',decided_by=$2 WHERE id=$1`,
    [ossid, ids.admin],
  );
  expect(
    (await api("GET", "/api/requests/" + oss.id, "member")).body.request,
  ).toMatchObject({
    status: "approved",
    execution: "provisioning",
  });
  await pool.query(
    `UPDATE oss_space SET status='failed',last_error='云端暂不可用' WHERE id=$1`,
    [ossid],
  );
  expect(
    (await list("member", "scope=mine&status=ongoing&type=oss")).items[0],
  ).toMatchObject({
    status: "approved",
    execution: "failed",
  });
});
it("服务端筛选分页和历史时间窗；通知无渠道不影响审批，失败可见且成功收件人不重复投递", async () => {
  const all = await list("admin", "scope=history&pageSize=1");
  expect(all.items).toHaveLength(1);
  expect(all.total).toBeGreaterThan(1);
  expect((await list("admin", "scope=history&type=env&q=不存在")).total).toBe(
    0,
  );
  await pool.query(
    "UPDATE approval_request SET decided_at=now()-interval '60 days' WHERE id=$1",
    [envId],
  );
  expect(
    (await list("admin", "scope=history&days=30&type=env")).items.some(
      (r: any) => r.id === envId,
    ),
  ).toBe(false);
  expect(
    (await list("admin", "scope=history&days=0&type=env")).items.some(
      (r: any) => r.id === envId,
    ),
  ).toBe(true);
  const worker = app.get(RequestNotifications);
  await worker.tick();
  expect(
    (await api("GET", "/api/requests/" + envId, "member")).body.request
      .notificationError,
  ).toContain("飞书");
  await pool.query(
    `INSERT INTO user_notification(user_id,webhook_url,verified_at) VALUES($1,'https://open.feishu.cn/open-apis/bot/v2/hook/test',now())`,
    [ids.member],
  );
  await pool.query(
    `UPDATE approval_notification SET state='skipped' WHERE state='pending'`,
  );
  const spy = vi
    .spyOn(app.get(WebhookService), "sendCardOnce")
    .mockResolvedValue();
  await pool.query(
    `UPDATE approval_notification SET state='pending',retry_at=now(),attempts=0 WHERE request_id=$1 AND event='approved'`,
    [envId],
  );
  await worker.tick();
  await worker.tick();
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

it("不同申请并发批准不会耗尽连接池，重复申请保持同一待办", async () => {
  const sources = await Promise.all(
    Array.from({ length: 12 }, async (_, i) => {
      const key = `PARALLEL_${i}`;
      await api("POST", "/api/envs/request-env/variables", "owner", {
        key,
        value: "never-return",
        description: "并发验证",
      });
      return envRequest("并发授权", [key]);
    }),
  );
  const results = await Promise.all(
    sources.map((s) =>
      api("POST", `/api/access-requests/${s.id}/decision`, "admin", {
        decision: "approved",
      }),
    ),
  );
  expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
});

it("变量删除和申请人停用使待办失效，重新启用不会复活旧审批", async () => {
  const created = await api("POST", "/api/access-requests", "other", {
    environmentSlug: "request-env",
    keys: ["TOKEN"],
    reason: "新用途",
  });
  const r = await latest("env", created.body.id);
  await pool.query(`UPDATE "user" SET status='disabled' WHERE id=$1`, [
    ids.other,
  ]);
  expect((await api("GET", "/api/requests/" + r.id)).body.request.status).toBe(
    "invalid",
  );
  await pool.query(`UPDATE "user" SET status='active' WHERE id=$1`, [
    ids.other,
  ]);
  expect(
    (
      await api("POST", `/api/requests/${r.id}/decision`, "admin", {
        decision: "approved",
      })
    ).status,
  ).toBe(409);
  expect(
    (await api("GET", `/api/access-requests/${created.body.id}`, "other")).body
      .status,
  ).toBe("invalid");
  const next = await api("POST", "/api/access-requests", "other", {
    environmentSlug: "request-env",
    keys: ["TOKEN"],
    reason: "恢复后的新用途",
  });
  expect(next.status).toBe(201);
  expect(next.body.id).not.toBe(created.body.id);
  const current = await latest("env", next.body.id);
  await pool.query(
    `DELETE FROM env_variable WHERE key='TOKEN' AND environment_id=$1`,
    [current.resource_id],
  );
  expect(
    (await api("GET", "/api/requests/" + current.id)).body.request.status,
  ).toBe("invalid");
});

it("后续资源管理不改写审批人和处理时间，数据库失败重试不新增审批轮次", async () => {
  const {
    rows: [r],
  } = await pool.query(
    `SELECT * FROM approval_request WHERE type='db' AND status='approved' AND latest`,
  );
  const decided = r.decided_at;
  await pool.query(
    `UPDATE db_assignment SET decided_by=$2,updated_at=now() WHERE id=$1`,
    [r.source_id, ids.other],
  );
  const after = await latest("db", r.source_id);
  expect(after.decided_by).toBe(r.decided_by);
  expect(after.decided_at).toEqual(decided);
  expect(
    (
      await api(
        "POST",
        `/api/db/assignments/${r.source_id}/retry`,
        "member",
        {},
      )
    ).status,
  ).toBe(403);
  // Broken test credentials keep provisioning local and fail safely before network I/O.
  const retry = await api(
    "POST",
    `/api/db/assignments/${r.source_id}/retry`,
    "admin",
    {},
  );
  expect(retry.status).toBe(201);
  expect(retry.body.status).toBe("failed");
  const retried = await latest("db", r.source_id);
  expect(retried.id).toBe(r.id);
  expect(retried.status).toBe("approved");
  expect(retried.decided_at).toEqual(decided);
  await pool.query(
    `UPDATE db_assignment SET status='provisioning' WHERE id=$1`,
    [r.source_id],
  );
  const {
    rows: [assignment],
  } = await pool.query("SELECT instance_id FROM db_assignment WHERE id=$1", [
    r.source_id,
  ]);
  expect(
    (
      await api(
        "DELETE",
        `/api/db/instances/${assignment.instance_id}`,
        "admin",
      )
    ).status,
  ).toBe(409);
  expect(
    (await api("DELETE", `/api/db/assignments/${r.source_id}`, "admin")).status,
  ).toBe(409);
  expect((await latest("db", r.source_id)).execution).toBe("provisioning");
  await pool.query(`UPDATE db_assignment SET status='failed' WHERE id=$1`, [
    r.source_id,
  ]);
});

it("通知重试不会重复投递已成功收件人，最终失败仍可在页面查看", async () => {
  await pool.query(
    `UPDATE approval_notification SET state='skipped' WHERE state='pending'`,
  );
  const source = (await envRequest("通知恢复验证", ["PARALLEL_0"])).id;
  const r = await latest("env", source);
  for (const [id, hook] of [
    [ids.admin, "admin"],
    [ids.owner, "owner"],
  ])
    await pool.query(
      `INSERT INTO user_notification(user_id,webhook_url,verified_at) VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET webhook_url=excluded.webhook_url,verified_at=now()`,
      [id, `https://open.feishu.cn/open-apis/bot/v2/hook/${hook}`],
    );
  const sends: string[] = [];
  const spy = vi
    .spyOn(app.get(WebhookService), "sendCardOnce")
    .mockImplementation(async (url) => {
      sends.push(url);
      if (url.endsWith("/owner")) throw new Error("network failed");
    });
  try {
    const worker = app.get(RequestNotifications);
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `UPDATE approval_notification SET retry_at=now() WHERE request_id=$1 AND state='pending'`,
        [r.id],
      );
      await worker.tick();
    }
    expect(sends.filter((u) => u.endsWith("/admin"))).toHaveLength(1);
    expect(sends.filter((u) => u.endsWith("/owner"))).toHaveLength(5);
    const state = (
      await pool.query(
        `SELECT * FROM approval_notification WHERE request_id=$1 AND event='submitted'`,
        [r.id],
      )
    ).rows[0];
    expect(state.state).toBe("failed");
    expect(
      (await api("GET", "/api/requests/" + r.id, "member")).body.request
        .notificationError,
    ).toContain("投递失败");
    expect((await latest("env", source)).status).toBe("pending");
  } finally {
    spy.mockRestore();
    await pool.query("UPDATE user_notification SET verified_at=NULL");
  }
});

it('通知包含申请人和原因，快捷同意绑定收件人、轮次和权限，结果通知遵守独立偏好', async () => {
  await pool.query(`UPDATE approval_notification SET state='skipped' WHERE state='pending'`);
  for (const [name, id] of Object.entries(ids)) {
    expect((await api('GET', '/api/account', name)).body.notification).toMatchObject({ notifyApprovalRequest: true, notifyApprovalResult: true });
    await pool.query(`INSERT INTO user_notification(user_id,webhook_url,verified_at) VALUES($1,$2,now())
      ON CONFLICT(user_id) DO UPDATE SET webhook_url=excluded.webhook_url,verified_at=now(),notify_approval_request=true,notify_approval_result=true`,
      [id, `https://open.feishu.cn/open-apis/bot/v2/hook/${name}`]);
  }
  expect((await api('POST', '/api/envs', 'owner', { slug: 'notice-env', name: '通知环境', description: '测试' })).status).toBe(201);
  await api('POST', '/api/envs/notice-env/variables', 'owner', { key: 'NOTICE_KEY', value: 'never-in-notification', description: '通知测试变量' });
  const submit = async (reason: string) => {
    const res = await api('POST', '/api/access-requests', 'member', { environmentSlug: 'notice-env', keys: ['NOTICE_KEY'], reason });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return latest('env', res.body.id);
  };
  const worker = app.get(RequestNotifications);
  const spy = vi.spyOn(app.get(WebhookService), 'sendCardOnce').mockResolvedValue(undefined);
  try {
    await api('PATCH', '/api/account/notification/preferences', 'owner', { notifyApprovalRequest: false });
    let r = await submit('排查支付接口，申请读取网关配置');
    await worker.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    const [url,, card] = spy.mock.calls[0];
    expect(url).toContain('/admin');
    expect(JSON.stringify(card)).toContain('member@requests.test');
    expect(JSON.stringify(card)).toContain('排查支付接口，申请读取网关配置');
    expect(JSON.stringify(card)).toContain('NOTICE_KEY');
    expect(JSON.stringify(card)).not.toContain('never-in-notification');
    const actions = (card.elements as any[]).find(e => e.tag === 'action').actions;
    expect(actions.map((a: any) => a.text.content)).toEqual(['同意', '驳回', '查看详情']);
    expect(new URL(actions[1].url).searchParams.get('action')).toBe('reject');
    const token = new URL(actions[0].url).searchParams.get('token')!;
    const path = `/api/requests/${r.id}/notification-approve`;
    expect((await app.inject({ method: 'POST', url: path, payload: { token } })).statusCode).toBe(401);
    expect((await api('POST', path, 'owner', { token })).status).toBe(403);
    expect((await api('POST', path, 'admin', { token: token + 'tampered' })).status).toBe(403);
    expect((await api('POST', path, 'admin', { token: createRequestActionToken(r.id, ids.admin, Date.now() - 8 * 86400000) })).status).toBe(403);
    await app.inject({ method: 'GET', url: `/requests/${r.id}/approve?token=${token}` });
    expect((await latest('env', r.source_id)).status).toBe('pending');
    // Role revocation after the notification must invalidate the old action.
    await pool.query(`UPDATE "user" SET role='member' WHERE id=$1`, [ids.admin]);
    expect([403, 404]).toContain((await api('POST', path, 'admin', { token })).status);
    await pool.query(`UPDATE "user" SET role='admin' WHERE id=$1`, [ids.admin]);
    const approved = await api('POST', path, 'admin', { token });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.request.status).toBe('approved');
    expect((await api('POST', path, 'admin', { token })).status).toBe(409);
    spy.mockClear();
    await worker.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('/member');
    expect(JSON.stringify(spy.mock.calls[0][2])).toContain('已批准');
    expect(JSON.stringify(spy.mock.calls[0][2])).not.toContain('notification-approve');

    spy.mockClear();
    await api('PATCH', '/api/account/notification/preferences', 'admin', { notifyApprovalRequest: false });
    r = await submit('第二次申请，检查驳回消息');
    await worker.tick();
    expect(spy).not.toHaveBeenCalled();
    expect((await api('GET', '/api/requests/' + r.id, 'member')).body.request.notificationError).toBeNull();
    await api('POST', `/api/requests/${r.id}/decision`, 'admin', { decision: 'rejected', reason: '请提供工单编号' });
    await worker.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('/member');
    expect(JSON.stringify(spy.mock.calls[0][2])).toContain('请提供工单编号');
    spy.mockClear();
    const old = r;
    r = (await api('POST', `/api/requests/${r.id}/resubmit`, 'member', { reason: '补充工单 123' })).body.request;
    expect((await api('POST', `/api/requests/${r.id}/notification-approve`, 'admin', { token })).status).toBe(403);
    expect((await api('POST', `/api/requests/${old.id}/notification-approve`, 'admin', { token: createRequestActionToken(old.id, ids.admin) })).status).toBe(409);
    await api('PATCH', '/api/account/notification/preferences', 'member', { notifyApprovalResult: false });
    // Legacy PUT omits new fields and must preserve the explicit opt-out.
    const prefs = await api('PUT', '/api/account/notification/preferences', 'member', { notifyHelp: true, notifyReply: false, notifyMention: true });
    expect(prefs.body.notifyApprovalResult).toBe(false);
    await api('POST', `/api/requests/${r.id}/decision`, 'admin', { decision: 'approved' });
    await worker.tick();
    expect(spy).not.toHaveBeenCalled();
    // A preference change must also stop a previously queued delivery retry.
    await api('PATCH', '/api/account/notification/preferences', 'admin', { notifyApprovalRequest: true });
    r = await submit('等待重试时关闭通知');
    spy.mockRejectedValue(new Error('temporary network failure'));
    await worker.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    await api('PATCH', '/api/account/notification/preferences', 'admin', { notifyApprovalRequest: false });
    await pool.query(`UPDATE approval_notification SET retry_at=now() WHERE request_id=$1 AND state='pending'`, [r.id]);
    await worker.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await pool.query(`SELECT state FROM approval_notification WHERE request_id=$1 AND event='submitted'`, [r.id])).rows[0].state).toBe('skipped');
  } finally {
    spy.mockRestore();
    await pool.query(`UPDATE "user" SET role='admin' WHERE id=$1`, [ids.admin]);
    await pool.query(`UPDATE user_notification SET verified_at=NULL,notify_approval_request=true,notify_approval_result=true`);
  }
});
