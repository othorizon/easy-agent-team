import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { NewApiClient, type NewApiToken } from '../src/llm-gateway/newapi.client';

let server: Server, client: NewApiClient;
let token: NewApiToken;
let debit = 0;

beforeAll(async () => {
  // Reproduce v1.0.0-rc.36 controller.UpdateToken + model.Token.Update SQL semantics:
  // both quota and status_only write remain_quota from a snapshot, but never used_quota.
  server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (req.method === 'PUT') {
      const snapshot = { ...token };
      token.remain_quota -= debit;
      token.used_quota += debit;
      if (req.url?.includes('status_only')) {
        token.status = body.status;
        token.remain_quota = snapshot.remain_quota;
      } else token.remain_quota = body.remain_quota;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data: token }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = new NewApiClient(`http://127.0.0.1:${(server.address() as any).port}`, 'test-access');
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function initial() {
  token = {
    id: 1,
    name: 'test',
    key: 'masked',
    status: 1,
    remain_quota: 100,
    used_quota: 0,
    unlimited_quota: false,
    expired_time: -1,
  };
  debit = 7;
}

describe('New API 原生额度配置的已接受行为（源码语义复现）', () => {
  it('检测扣费发生在最后读取与调额写入之间：总额度被多写 7', async () => {
    initial();
    await client.setQuota({ ...token }, 150);
    expect(token.used_quota).toBe(7);
    expect(token.remain_quota).toBe(150);
    expect(token.used_quota + token.remain_quota).not.toBe(150);
  });
  it('检测 status_only 同样会覆盖并发扣费；仅停用不等于原子配置', async () => {
    initial();
    await client.status(1, false);
    expect(token.status).toBe(2);
    expect(token.used_quota).toBe(7);
    expect(token.remain_quota).toBe(100);
    expect(token.used_quota + token.remain_quota).not.toBe(100);
  });
});
