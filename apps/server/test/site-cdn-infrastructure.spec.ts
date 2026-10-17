import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import type { TLSSocket } from 'node:tls';
import { SiteCdnClient } from '../src/sites/site-cdn.client';
import {
  SiteCdnInfrastructure,
  cdnMarker,
  cdnFunctions,
  checkCdnOrigin,
  configDigest,
  cdnConfigsToCheck,
  cdnProbeHost,
  cdnSni,
} from '../src/sites/site-cdn.infrastructure';
import { SiteDns } from '../src/sites/site-dns.service';
import { encryptSecret } from '../src/common/crypto';
import type { SiteCdnRow } from '../src/sites/site-cdn.store';
import type { SiteSettingRow } from '../src/sites/site-settings.store';
import { aliyunCdnContract } from './fixtures/aliyun-cdn-contract';

let root: string, pem: string, key: string;
const base = {
  domain: 'sites.example.com',
  platformUrl: 'https://eat.example.test',
  tlsMode: 'alidns',
  resourceKey: 'c0ed53a3-537f-40ce-a640-e6991dd8768b',
  serverId: null,
  gatewayTarget: '203.0.113.10',
} as SiteSettingRow;
const row = { originSecretEncrypted: encryptSecret('isolated-origin-secret'), resources: {} } as SiteCdnRow;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'eat-cdn-cert-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '30',
      '-subj',
      '/CN=*.sites.example.com',
      '-addext',
      'subjectAltName=DNS:*.sites.example.com',
    ],
    { stdio: 'ignore' },
  );
  pem = await readFile(join(root, 'cert.pem'), 'utf8');
  key = await readFile(join(root, 'key.pem'), 'utf8');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  const resolver = `eat-sites-${base.resourceKey}`;
  const read = vi.fn(async () =>
    JSON.stringify({
      [resolver]: {
        Certificates: [
          {
            domain: { main: '*.sites.example.com' },
            certificate: Buffer.from(pem).toString('base64'),
            key: Buffer.from(key).toString('base64'),
          },
        ],
      },
    }),
  );
  const client = { siteRequest: read };
  const infra = {
    addresses: async (_address: string) => ['203.0.113.20'],
    readMain: vi.fn(async () => ({
      config: {
        certificatesResolvers: {
          [resolver]: { acme: { storage: `/etc/dokploy/traefik/dynamic/${resolver}-acme.json` } },
        },
      },
    })),
  };
  const service = new SiteCdnInfrastructure(
    { client: async () => client } as never,
    infra as never,
    new SiteCdnClient(),
  );
  return { service, read, infra };
}
describe('CDN certificate, signing and DNS adapter contracts', () => {
  it('reads only the matching Traefik ACME certificate, verifies its key and wildcard and never issues another certificate', async () => {
    const f = fixture(),
      cert = await f.service.certificate(base);
    expect(cert.fingerprint).toBe(new X509Certificate(pem).fingerprint256);
    expect(cert.pem).toBe(pem);
    expect(cert.key).toBe(key);
    expect(f.read).toHaveBeenCalledWith('settings.readTraefikFile', undefined, {
      path: expect.stringContaining('eat-sites-'),
    });
    expect(f.read.mock.calls).toHaveLength(1);
  });
  it('rejects an incompatible certificate and unsafe ACME paths', async () => {
    const f = fixture();
    await expect(f.service.certificate({ ...base, domain: 'different.example.com' })).rejects.toThrow('源站');
    f.infra.readMain.mockResolvedValue({
      config: {
        certificatesResolvers: { [`eat-sites-${base.resourceKey}`]: { acme: { storage: '/etc/shadow' } } },
      },
    });
    await expect(f.service.certificate(base)).rejects.toThrow('无法安全读取');
  });
  it('does not accept a successful API save as proof of certificate propagation, cache HIT or origin cache policy', async () => {
    const f = fixture(),
      path = `/__eat/cdn-probe/${base.resourceKey}`;
    const probe = vi.spyOn(f.service, 'probe').mockResolvedValue({
      status: 200,
      body: cdnMarker(row, path),
      headers: { 'cache-control': 'private, no-store' },
      fingerprint: 'wrong',
    });
    row.resources.certificateFingerprint = 'expected';
    await expect(f.service.verify(base, row, 'cdn.example.net', true)).rejects.toThrow('边缘证书尚未');
    probe.mockImplementation(async (_host, _address, uri, headers) => {
      if (uri.endsWith('probe.css'))
        return {
          status: 200,
          body: cdnMarker(row, uri),
          headers: { 'x-cache': 'MISS', 'cache-control': 'private, no-store' },
          fingerprint: 'expected',
        };
      return {
        status: 200,
        body: cdnMarker(row, uri),
        headers: { 'cache-control': 'private, no-store' },
        fingerprint: 'expected',
      };
    });
    await expect(f.service.verify(base, row, 'cdn.example.net', true)).rejects.toThrow('缓存命中');
  });
  it('accepts source-controlled public static HIT without custom origin headers, edge response rewriting or remote authentication', async () => {
    const f = fixture();
    row.resources.certificateFingerprint = 'expected';
    const probe = vi.spyOn(f.service, 'probe').mockImplementation(async (_host, _address, uri) => ({
      status: 200, body: cdnMarker(row, uri), fingerprint: 'expected',
      headers: uri.endsWith('probe.css')
        ? { 'cache-control': 'public, max-age=2592000', 'x-cache': 'HIT' }
        : { 'cache-control': 'private, no-store' },
    }));
    await f.service.verify(base, row, 'cdn.example.net', true);
    expect(probe.mock.calls).toHaveLength(3);
    expect(probe.mock.calls.some((c) => c[2].includes('cdn-deny'))).toBe(false);
    expect(probe.mock.calls[0][3]).toEqual({});
    expect(probe.mock.calls[0][4]).toBe(cdnProbeHost(base));
  });
  it('connects to each pinned destination instead of reusing the source socket for the CDN host', async () => {
    const realRequest = https.request;
    const agent = new https.Agent({ keepAlive: true });
    const received: string[] = [];
    const server = (label: string) =>
      https.createServer({ cert: pem, key }, (req, res) => {
        received.push(label);
        expect(req.headers.host).toBe(cdnProbeHost(base));
        res.setHeader('cache-control', 'private, no-store');
        res.end(label);
      });
    const source = server('source'),
      edge = server('cdn');
    // macOS does not bind arbitrary 127/8 aliases without system configuration.
    const edgeAddress = process.platform === 'darwin' ? '::1' : '127.0.0.2';
    const listen = (s: https.Server, port: number, host: string) =>
      new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(port, host, () => {
          s.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(source, 0, '127.0.0.1');
      const port = (source.address() as { port: number }).port;
      await listen(edge, port, edgeAddress);
      vi.spyOn(https, 'request').mockImplementation(
        ((options: https.RequestOptions, callback: Parameters<typeof realRequest>[2]) =>
          realRequest(
            { ...options, port, ca: pem, agent: options.agent === false ? false : agent },
            callback,
          )) as typeof https.request,
      );
      syncBuiltinESMExports();
      const f = fixture();
      f.infra.addresses = async (address) => [address];
      const host = cdnProbeHost(base);
      expect((await f.service.probe(host, '127.0.0.1', '/probe')).body).toBe('source');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await f.service.probe(host, edgeAddress, '/probe')).body).toBe('cdn');
      expect((await f.service.probe(host, '127.0.0.1', '/probe')).body).toBe('source');
      expect(received).toEqual(['source', 'cdn', 'source']);
    } finally {
      agent.destroy();
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await Promise.all(
        [source, edge].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
    }
  });
  it('verifies the actual origin SNI independently of the Folio Host and keeps certificate validation enabled', async () => {
    const requests: { host: string | undefined; sni: string | false | null }[] = [];
    const server = https.createServer({ cert: pem, key }, (req, res) => {
      const sni = (req.socket as TLSSocket).servername;
      requests.push({ host: req.headers.host, sni });
      res.statusCode = sni === cdnSni(base) ? 200 : 421;
      res.setHeader('cache-control', 'private, no-store');
      res.end(cdnMarker(row, req.url!));
    });
    const realRequest = https.request;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      vi.spyOn(https, 'request').mockImplementation(
        ((options: https.RequestOptions, callback: Parameters<typeof realRequest>[2]) =>
          realRequest({ ...options, port, ca: pem }, callback)) as typeof https.request,
      );
      syncBuiltinESMExports();
      const f = fixture();
      f.infra.addresses = async () => ['127.0.0.1'];
      await expect(f.service.verify(base, row, '127.0.0.1', false)).resolves.toBeUndefined();
      expect(requests).toEqual([{ host: cdnProbeHost(base), sni: cdnSni(base) }]);
      await expect(
        f.service.probe(cdnProbeHost(base), '127.0.0.1', '/probe', {}, 'wrong.example.test'),
      ).rejects.toThrow('HTTPS 证书域名与 SNI 不匹配');
      expect(requests).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([
    { detail: 'SSL handshake failed', category: 'TLS / 证书握手' },
    { detail: 'forward retry timeout', category: '回源超时' },
    { detail: 'orig response 5xx error', category: '源站或上游返回 5xx' },
    { detail: 'unknown', category: '' },
  ])('classifies provider 502 hints without exposing arbitrary error headers: $detail', async ({ detail, category }) => {
    const f = fixture();
    vi.spyOn(f.service, 'probe').mockResolvedValue({
      status: 502,
      body: 'private upstream response',
      headers: { 'x-swift-error': `${detail} private-origin-secret`, 'x-tengine-error': 'private-details' },
      fingerprint: '',
    });
    const error = await f.service.verify(base, row, 'cdn.example.net', true).catch((e) => e);
    expect(error.message).toContain('CDN 接入检查失败：HTTP 502');
    if (category) expect(error.message).toContain(`CDN 错误类型：${category}`);
    else expect(error.message).not.toContain('CDN 错误类型');
    expect(error.message).not.toContain('private');
  });
  it.each([
    { edge: false, status: 404, body: 'private upstream response', noStore: true, error: '源站直连检查失败：HTTP 404' },
    { edge: true, status: 404, body: 'private upstream response', noStore: true, error: 'CDN 接入检查失败：HTTP 404，未见 CDN 节点标记' },
    { edge: true, status: 403, body: 'private upstream response', noStore: true, error: 'CDN 接入检查失败：HTTP 403，请检查源站访问策略' },
    { edge: true, status: 502, body: 'private upstream response', noStore: true, error: 'CDN 接入检查失败：HTTP 502，请检查 HTTPS 回源' },
    { edge: false, status: 200, body: 'private upstream response', noStore: true, error: '源站直连检查失败：HTTP 200，但 EAT 实例标记不匹配' },
    { edge: true, status: 200, body: 'private upstream response', noStore: true, error: 'CDN 接入检查失败：HTTP 200，但 EAT 实例标记不匹配' },
    { edge: false, status: 200, body: '', noStore: false, error: '源站直连检查失败：HTTP 200，但客户端响应缺少 Cache-Control: no-store' },
    { edge: true, status: 200, body: '', noStore: false, error: 'CDN 接入检查失败：HTTP 200，但客户端响应缺少 Cache-Control: no-store' },
  ])('reports the failing verification stage without echoing upstream content: $error', async (test) => {
    const f = fixture();
    vi.spyOn(f.service, 'probe').mockResolvedValue({
      status: test.status,
      body: test.body || cdnMarker(row, `/__eat/cdn-probe/${base.resourceKey}`),
      headers: test.noStore ? { 'cache-control': 'private, no-store' } : {},
      fingerprint: '',
    });
    const error = await f.service.verify(base, row, 'cdn.example.net', test.edge).catch((e) => e);
    expect(error.message).toContain(test.error);
    expect(error.message).not.toContain('private upstream response');
    expect(error.message).not.toContain('isolated-origin-secret');
  });
  it.each([false, true])('identifies the stage of a failed TLS connection (edge=%s)', async (edge) => {
    const f = fixture();
    vi.spyOn(f.service, 'probe').mockRejectedValue(new Error('private TLS details'));
    const error = await f.service.verify(base, row, 'cdn.example.net', edge).catch((e) => e);
    expect(error.message).toContain(`${edge ? 'CDN 接入' : '源站直连'}检查失败：HTTPS 连接未完成`);
    expect(error.message).not.toContain('private TLS details');
  });
  it('rejects indirect CNAME loops before DNS cutover while allowing independent origins', async () => {
    const origin = { ...base, gatewayTarget: 'origin.example.net' };
    await expect(
      checkCdnOrigin(origin, 'cdn.example.net', async () => ['demo.sites.example.com']),
    ).rejects.toThrow('循环回源');
    await expect(checkCdnOrigin(origin, 'cdn.example.net', async () => ['cdn.example.net'])).rejects.toThrow(
      '循环回源',
    );
    await expect(
      checkCdnOrigin(origin, 'cdn.example.net', async (host) =>
        host === 'origin.example.net' ? ['direct.example.net'] : [],
      ),
    ).resolves.toBeUndefined();
  });
  it('signs POST RPC requests and redacts untrusted cloud responses', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const params = new URLSearchParams(String(init.body));
      expect(params.get('Version')).toBe('2018-05-10');
      expect(params.get('AccessKeyId')).toBe('test-id');
      expect(params.get('Signature')).toMatch(/^[a-zA-Z0-9+/]+=*$/);
      return new Response(JSON.stringify({ Code: 'Forbidden.RAM', Message: 'SECRET SHOULD NOT ESCAPE' }), {
        status: 403,
      });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      new SiteCdnClient().call(
        { accessKeyId: 'test-id', accessKeySecret: 'test-secret' },
        'DescribeCdnService',
      ),
    ).rejects.toThrow('Forbidden.RAM');
    try {
      await new SiteCdnClient().call(
        { accessKeyId: 'test-id', accessKeySecret: 'test-secret' },
        'DescribeCdnService',
      );
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
      expect(String(e)).not.toContain('test-secret');
    }
  });
  it('matches the published function argument contract and defaults origin certificate verification off', () => {
    for (const fn of cdnFunctions(row, base)) {
      const contract = aliyunCdnContract[fn.functionName];
      expect(contract, fn.functionName).toBeDefined();
      const names = fn.functionArgs.map((arg) => arg.argName);
      expect(contract.required.every((name) => names.includes(name)), fn.functionName).toBe(true);
      expect(names.every((name) => [...contract.required, ...(contract.optional ?? [])].includes(name)), fn.functionName).toBe(true);
    }
    expect(cdnFunctions(row, base).find((f) => f.functionName === 'origin_certificate_verification')!.functionArgs)
      .toEqual([{ argName: 'enable', argValue: 'off' }]);
  });
  it('identifies a rejected function and argument without exposing any response text or argument value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      Code: 'InvalidArgName.ValueNotSupported',
      Message: 'The specified ArgName[enable] is not supported. PRIVATE_RESPONSE test-secret-value',
    }), { status: 400 })));
    const client = new SiteCdnClient();
    try {
      await client.call({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' }, 'BatchSetCdnDomainConfig', {
        DomainNames: '.sites.example.com',
        Functions: JSON.stringify([{ functionName: 'origin_certificate_verification', functionArgs: [{ argName: 'enable', argValue: 'test-secret-value' }] }]),
      });
      throw new Error('Expected cloud rejection');
    } catch (e) {
      expect(String(e)).toContain('功能：origin_certificate_verification');
      expect(String(e)).toContain('参数：enable');
      expect(String(e)).not.toContain('PRIVATE_RESPONSE');
      expect(String(e)).not.toContain('test-secret-value');
      expect(String(e)).not.toContain('RAM');
    }
  });
  it('limits concurrent configuration calls to the documented 3 requests per second', async () => {
    const times: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      times.push(Date.now());
      return new Response('{}');
    }));
    const client = new SiteCdnClient();
    await Promise.all([1, 2, 3].map(() => client.call(
      { accessKeyId: 'test-id', accessKeySecret: 'test-secret' }, 'BatchSetCdnDomainConfig',
    )));
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(300);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(300);
  });
  it('compares cloud configs independent of IDs and ordering while detecting drift', () => {
    const functions = cdnFunctions(row, base);
    const configs = functions
      .map((f, i) => ({
        ConfigId: i,
        ParentId: i % 2 ? 0 : '0',
        FunctionName: f.functionName,
        FunctionArgs: {
          FunctionArg: f.functionArgs.map((a) => ({ ArgName: a.argName, ArgValue: a.argValue })).reverse(),
        },
      }))
      .reverse();
    expect(configDigest(configs)).toBe(configDigest(functions));
    configs[0].FunctionArgs.FunctionArg[0].ArgValue = 'external change';
    expect(configDigest(configs)).not.toBe(configDigest(functions));
  });
  it('only omits recognized unbound service defaults, preserving unknown functions and real rule bindings', () => {
    const defaults = { FunctionName: 'https_option', ParentId: 0, FunctionArgs: { FunctionArg: [] } };
    const unknown = { ...defaults, FunctionName: 'custom_cache_rule' };
    const bound = { ...defaults, ParentId: 'condition-123' };
    expect(cdnConfigsToCheck([defaults, unknown, bound])).toEqual([unknown, bound]);
    expect(configDigest([{ ...defaults, ParentId: '0' }])).toBe(
      configDigest([{ ...defaults, ParentId: -1 }]),
    );
    expect(configDigest([bound])).not.toBe(configDigest([defaults]));
  });
  it('updates AliDNS and Cloudflare records in place, retaining record IDs and original TTL', async () => {
    for (const mode of ['alidns', 'cloudflare']) {
      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          if (mode === 'cloudflare')
            return new Response(
              JSON.stringify({
                success: true,
                result: url.includes('/zones?') ? [{ id: 'zone' }] : { id: 'record' },
              }),
            );
          const p = new URLSearchParams(String(init.body));
          return new Response(
            JSON.stringify(
              p.get('Action') === 'DescribeDomains'
                ? { TotalCount: 1, Domains: { Domain: [{ DomainName: 'example.com' }] } }
                : {},
            ),
          );
        }),
      );
      const service = new SiteDns({
        secrets: () => ({ dnsAccessKeyId: 'dns-test-id', dnsAccessKeySecret: 'dns-test-secret' }),
      } as never);
      const client = await service.connect({ ...base, tlsMode: mode } as SiteSettingRow);
      await client.update({
        id: 'record',
        name: '*.sites.example.com',
        type: 'CNAME',
        content: 'cdn.example.net',
        ttl: 1200,
      });
      const last = calls[calls.length - 1];
      if (mode === 'cloudflare') {
        expect(last.init.method).toBe('PUT');
        expect(JSON.parse(String(last.init.body))).toMatchObject({ ttl: 1200, proxied: false });
      } else {
        const p = new URLSearchParams(String(last.init.body));
        expect(p.get('Action')).toBe('UpdateDomainRecord');
        expect(p.get('RecordId')).toBe('record');
        expect(p.get('TTL')).toBe('1200');
      }
    }
  });
});
