/**
 * 公网演示模式的封禁清单（纯函数，不需要数据库）。
 * 这份清单挡的是「匿名访客拿到管理员身份后能干的越界事」，漏一条就是一个洞，所以逐条钉住。
 */
import { describe, expect, it } from 'vitest';
import { demoDenyReason } from '../src/demo/demo.rules';

const ALLOW = ['http://a2c:3000/mcp/'];
const deny = (method: string, path: string, body: unknown = {}) => demoDenyReason({ method, path, body }, ALLOW);

describe('demoDenyReason', () => {
  it('封掉成员管理的全部写操作，读不受影响', () => {
    expect(deny('POST', '/api/users')).toMatch(/成员管理/);
    expect(deny('PATCH', '/api/users/u1')).toMatch(/成员管理/);
    expect(deny('POST', '/api/users/u1/password')).toMatch(/成员管理/);
    expect(deny('GET', '/api/users')).toBeNull();
  });

  it('封掉平台接入设置，包括会带着已存密钥往外发请求的连通性测试', () => {
    expect(deny('PUT', '/api/admin/dokploy-settings')).toMatch(/平台接入设置/);
    expect(deny('POST', '/api/admin/dokploy-settings/test')).toMatch(/平台接入设置/);
    expect(deny('PUT', '/api/admin/ai-settings')).toMatch(/平台接入设置/);
    expect(deny('POST', '/api/admin/ai-settings/test')).toMatch(/平台接入设置/);
    expect(deny('PUT', '/api/admin/registration-settings')).toMatch(/平台接入设置/);
    expect(deny('GET', '/api/admin/dokploy-settings')).toBeNull();
  });

  it('封掉自助注册与数据库实例的增删改，申请和审批照常', () => {
    expect(deny('POST', '/api/auth/register')).toMatch(/自助注册/);
    expect(deny('POST', '/api/db/instances')).toMatch(/数据库实例/);
    expect(deny('DELETE', '/api/db/instances/i1')).toMatch(/数据库实例/);
    expect(deny('GET', '/api/db/instances')).toBeNull();
    expect(deny('POST', '/api/db/assignments')).toBeNull();
    expect(deny('POST', '/api/db/assignments/a1/approve')).toBeNull();
  });

  it('可求助登记可以改，但不能带 webhook 地址', () => {
    expect(deny('PUT', '/api/helpers/me', { description: '问我', available: true })).toBeNull();
    expect(deny('PUT', '/api/helpers/me', { webhookUrl: '   ' })).toBeNull();
    expect(deny('PUT', '/api/helpers/me', { webhookUrl: 'http://10.0.0.1/x' })).toMatch(/webhook/);
  });

  it('MCP 配置的上游只能是内置的 anytocontext；stdio 配置（没有 url）不受限', () => {
    expect(deny('POST', '/api/mcp-configs', { url: 'http://a2c:3000/mcp/at_abc' })).toBeNull();
    expect(deny('POST', '/api/mcp-configs', { transport: 'stdio', command: 'npx' })).toBeNull();
    expect(deny('POST', '/api/mcp-configs', { url: 'http://100.100.100.200/latest/meta-data' })).toMatch(/MCP 上游/);
    expect(deny('PATCH', '/api/mcp-configs/x', { url: 'http://eat-db:5432/' })).toMatch(/MCP 上游/);
    // 订阅、审批这些子路径没有 url 字段，也不该被这条规则碰到
    expect(deny('POST', '/api/mcp-configs/x/subscribe', { reason: '答疑要用' })).toBeNull();
    expect(deny('POST', '/api/mcp-configs/subscription-requests/r1/decision', { approve: true })).toBeNull();
  });

  it('演示要用到的日常动作全部放行', () => {
    for (const [m, p] of [
      ['POST', '/api/skills/push'],
      ['POST', '/api/envs'],
      ['POST', '/api/access-requests/r1/decision'],
      ['POST', '/api/help-requests'],
      ['POST', '/api/auth/device/approve'],
      ['POST', '/api/auth/api-keys'],
      ['POST', '/api/apps'],
    ] as const) {
      expect(deny(m, p), `${m} ${p}`).toBeNull();
    }
  });
});
