import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, globalAgent, type Server } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import type { DokployClient } from '../src/deploy/dokploy.client';
import { stringify } from 'yaml';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteInfrastructure, siteRoutes } from '../src/sites/site-infrastructure.service';
import { SiteDns } from '../src/sites/site-dns.service';
import type { SiteSettingRow, SiteSettingsStore } from '../src/sites/site-settings.store';
import type { SiteStorage } from '../src/sites/site-storage.service';
const settings = {
  secrets: () => ({ dnsAccessKeyId: 'id', dnsAccessKeySecret: 'secret' }),
} as unknown as SiteSettingsStore;
const base = {
  domain: 'sites.example.com',
  ossRegion: 'oss-cn-hangzhou',
  ossBucket: 'private-bucket',
  resourceKey: '1d965ae2-164b-4661-a3c1-89f029939fc3',
  gatewayTarget: '203.0.113.10',
};
const row = (mode = 'alidns') => ({ ...base, tlsMode: mode }) as SiteSettingRow;
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('DNS 服务商实际协议与权限探测', () => {
  it('AliDNS 通过签名请求测试 TXT 创建/读取/删除，已有通配记录不会覆盖', async () => {
    const records: any[] = [];
    const actions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        const p = new URLSearchParams(options.body as string);
        const action = p.get('Action')!;
        actions.push(action);
        expect(p.get('AccessKeyId')).toBe('id');
        expect(p.get('SignatureMethod')).toBe('HMAC-SHA1');
        expect(p.get('Signature')).toMatch(/^[a-zA-Z0-9+/]+=*$/);
        let result: unknown = {};
        if (action === 'DescribeDomains')
          result = { TotalCount: 1, Domains: { Domain: [{ DomainName: 'example.com' }] } };
        if (action === 'AddDomainRecord') {
          records.push({ RecordId: 'record1', RR: p.get('RR'), Type: p.get('Type'), Value: p.get('Value') });
          result = { RecordId: 'record1' };
        }
        if (action === 'DescribeDomainRecords') result = { DomainRecords: { Record: records } };
        if (action === 'DeleteDomainRecord') records.splice(0);
        return new Response(JSON.stringify(result), { status: 200 });
      }),
    );
    const service = new SiteDns(settings);
    const client = await service.connect(row());
    await service.checkPermissions(client, row());
    expect(records).toHaveLength(0);
    expect(actions).toEqual([
      'DescribeDomains',
      'AddDomainRecord',
      'DescribeDomainRecords',
      'DeleteDomainRecord',
      'DescribeDomainRecords',
    ]);
    records.push({ RecordId: 'existing', RR: '*.sites', Type: 'A', Value: '203.0.113.20' });
    await expect(service.ensureWildcard(client, row())).rejects.toThrow('不会覆盖');
    expect(records[0].Value).toBe('203.0.113.20');
  });
  it('Cloudflare 使用限区域 Token，测试失败仍删除自己创建的 TXT', async () => {
    const calls: string[] = [];
    let addedName = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        expect((options.headers as any).authorization).toBe('Bearer secret');
        calls.push(`${options.method} ${url}`);
        let result: unknown = [];
        if (url.includes('/zones?name=example.com')) result = [{ id: 'zone1' }];
        if (options.method === 'POST') {
          addedName = JSON.parse(options.body as string).name;
          result = { id: 'created' };
        }
        // 模拟写入后无法读回，也必须清理临时记录。
        return new Response(JSON.stringify({ success: true, result }), { status: 200 });
      }),
    );
    const service = new SiteDns(settings);
    const client = await service.connect(row('cloudflare'));
    await expect(service.checkPermissions(client, row('cloudflare'))).rejects.toThrow('无法读回');
    expect(addedName).toMatch(/^_eat-check-.+\.sites\.example\.com$/);
    expect(calls).toContain('DELETE https://api.cloudflare.com/client/v4/zones/zone1/dns_records/created');
  });
  it('DNS API 错误不暴露凭证和原始响应', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ Code: 'Forbidden', Message: 'secret credential leaked' }), { status: 403 }),
        ),
    );
    await expect(new SiteDns(settings).connect(row())).rejects.toThrow('Forbidden');
    try {
      await new SiteDns(settings).connect(row());
    } catch (e) {
      expect((e as Error).message).not.toContain('secret');
    }
  });
});
describe('OSS 前置检查', () => {
  function fixture(acl = 'private') {
    const objects = new Map<string, Buffer>();
    const client = {
      getBucketACL: vi.fn().mockResolvedValue({ acl }),
      put: vi.fn(async (key: string, value: Buffer) => {
        objects.set(key, value);
      }),
      get: vi.fn(async (key: string) => {
        if (!objects.has(key)) throw { status: 404 };
        return { content: objects.get(key) };
      }),
      deleteMulti: vi.fn(async (keys: string[]) => {
        for (const k of keys) objects.delete(k);
      }),
    };
    const storage = { client: () => client } as unknown as SiteStorage;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    return { infra: new SiteInfrastructure(storage, settings), objects, client };
  }
  it('验证私有 ACL、上传、读回、匿名拒绝、删除及删除后不可读取', async () => {
    const { infra, objects, client } = fixture();
    await infra.checkOss(row());
    expect(objects.size).toBe(0);
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.deleteMulti).toHaveBeenCalledOnce();
    expect(client.put.mock.calls[0][0]).toMatch(/^sites\/_checks\//);
  });
  it('公共 Bucket 不上传；对象被公开访问时拒绝启用并清理测试文件', async () => {
    const publicBucket = fixture('public-read');
    await expect(publicBucket.infra.checkOss(row())).rejects.toThrow('私有读写');
    expect(publicBucket.client.put).not.toHaveBeenCalled();
    const test = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('public', { status: 200 })));
    await expect(test.infra.checkOss(row())).rejects.toThrow('匿名访问');
    expect(test.objects.size).toBe(0);
  });
  it('删除权限缺失不能通过检查，提示清理具体测试对象', async () => {
    const { infra, client } = fixture();
    client.deleteMulti.mockRejectedValue(new Error('Access denied secret'));
    await expect(infra.checkOss(row())).rejects.toThrow('清理失败');
  });
  it('通配 DNS 必须解析到入口的全部有效地址，拒绝其他入口', async () => {
    const { infra } = fixture();
    vi.spyOn(infra, 'addresses').mockImplementation(async (host) =>
      host === '203.0.113.10' ? ['203.0.113.10'] : ['203.0.113.10', '203.0.113.99'],
    );
    await expect(infra.checkDns(row())).rejects.toThrow('指向');
  });
});
describe('真实 HTTPS 客户端检查', () => {
  let server: Server, untrusted: Server, dir: string, url: string, badUrl: string;
  const previousCa = globalAgent.options.ca;
  let response = 'marker';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eat-site-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '30',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'bad-key.pem'),
        '-out',
        join(dir, 'bad-cert.pem'),
        '-days',
        '30',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    const cert = await readFile(join(dir, 'cert.pem'));
    const key = await readFile(join(dir, 'key.pem'));
    globalAgent.options.ca = cert;
    server = createServer({ cert, key }, (_req, res) => res.end(response));
    untrusted = createServer(
      { cert: await readFile(join(dir, 'bad-cert.pem')), key: await readFile(join(dir, 'bad-key.pem')) },
      (_req, res) => res.end('marker'),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => untrusted.listen(0, '127.0.0.1', () => r()));
    url = `https://localhost:${(server.address() as any).port}/probe`;
    badUrl = `https://localhost:${(untrusted.address() as any).port}/probe`;
  });
  afterAll(async () => {
    globalAgent.options.ca = previousCa;
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => untrusted.close(() => r())),
    ]);
    await rm(dir, { recursive: true, force: true });
  });
  const infra = new SiteInfrastructure({} as SiteStorage, settings);
  it('只接受受信证书、正确域名和精确的 EAT 探针响应', async () => {
    await expect(infra.probeHttps(url, 'marker', new AbortController().signal)).resolves.toBeUndefined();
    response = 'another-platform';
    await expect(infra.probeHttps(url, 'marker', new AbortController().signal)).rejects.toThrow('未到达当前 EAT');
    response = 'marker';
    await expect(
      infra.probeHttps(url.replace('localhost', '127.0.0.1'), 'marker', new AbortController().signal),
    ).rejects.toThrow();
    await expect(infra.probeHttps(badUrl, 'marker', new AbortController().signal)).rejects.toThrow();
  });
  it('路由限定单层页面子域名，保留 Host，并显式申请泛域名证书', () => {
    const config = siteRoutes(row(), 'http://eat:3000', 'resolver');
    const router = Object.values(config.http.routers)[1];
    expect(router.tls).toEqual({ certResolver: 'resolver', domains: [{ main: '*.sites.example.com' }] });
    const regexp = new RegExp(router.rule.slice('HostRegexp(`'.length, -2));
    expect(regexp.test('demo.sites.example.com')).toBe(true);
    expect(regexp.test('a.b.sites.example.com')).toBe(false);
    expect(regexp.test('demo.sitesXexample.com')).toBe(false);
  });
});

describe('共享证书配置与 HTTP 后置检查', () => {
  const infra = new SiteInfrastructure({} as SiteStorage, settings);
  it('不能用新的 DNS 凭证覆盖其他应用使用的证书解析器', async () => {
    const config = {
      entryPoints: { web: {}, websecure: {} },
      providers: { file: { directory: '/etc/dokploy/traefik/dynamic', watch: true } },
      certificatesResolvers: { shared: { acme: { dnsChallenge: { provider: 'alidns' } } } },
    };
    const call = vi.fn(async (endpoint: string) =>
      endpoint === 'settings.readTraefikFile'
        ? stringify(config)
        : 'ALICLOUD_ACCESS_KEY=someone-else\nALICLOUD_SECRET_KEY=another-secret',
    );
    await expect(
      infra.configure({ siteRequest: call } as unknown as DokployClient, row(), 'http://eat:3000'),
    ).rejects.toThrow('避免影响其他服务');
    expect(call.mock.calls.every(([name]) => name.startsWith('settings.read'))).toBe(true);
  });
  it('代理已运行时复用，未安装时明确阻止，已停止时自动请求启动', async () => {
    const call = vi.fn().mockResolvedValue([{ name: 'dokploy-traefik', state: 'running', status: 'Up' }]);
    await infra.ensureGateway({ siteRequest: call } as unknown as DokployClient, row(), new AbortController().signal);
    expect(call).toHaveBeenCalledTimes(1);
    call.mockReset().mockResolvedValue([]);
    await expect(
      infra.ensureGateway({ siteRequest: call } as unknown as DokployClient, row(), new AbortController().signal),
    ).rejects.toThrow('未安装');
    const abort = new AbortController();
    call.mockReset().mockImplementation(async (endpoint) => {
      if (endpoint === 'settings.reloadTraefik') {
        abort.abort();
        return true;
      }
      return [{ name: 'dokploy-traefik', state: 'exited', status: 'Exited' }];
    });
    await expect(
      infra.ensureGateway({ siteRequest: call } as unknown as DokployClient, row(), abort.signal),
    ).rejects.toThrow('未就绪');
    expect(call).toHaveBeenCalledWith('settings.reloadTraefik', {});
  });
  it('真实 HTTP 服务必须重定向到同域名、同路径的 HTTPS，拒绝外站与循环跳转', async () => {
    let redirect = 'correct';
    const server = createHttpServer((req, res) => {
      const origin = `http://localhost:${(server.address() as any).port}`;
      res.statusCode = 301;
      res.setHeader(
        'location',
        redirect === 'correct'
          ? origin.replace('http:', 'https:') + req.url
          : redirect === 'loop'
            ? origin + req.url
            : 'https://another.example.com/',
      );
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://localhost:${(server.address() as any).port}/probe`;
      await expect(infra.probeHttpRedirect(url, new AbortController().signal)).resolves.toBeUndefined();
      redirect = 'wrong';
      await expect(infra.probeHttpRedirect(url, new AbortController().signal)).rejects.toThrow('未正确跳转');
      redirect = 'loop';
      await expect(infra.probeHttpRedirect(url, new AbortController().signal)).rejects.toThrow('未正确跳转');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
