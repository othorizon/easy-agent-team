import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { SiteCdnClient } from '../src/sites/site-cdn.client';
import {
  SiteCdnInfrastructure,
  cdnMarker,
  cdnFunctions,
  checkCdnOrigin,
  configDigest,
  cdnConfigsToCheck,
} from '../src/sites/site-cdn.infrastructure';
import { SiteDns } from '../src/sites/site-dns.service';
import { encryptSecret } from '../src/common/crypto';
import type { SiteCdnRow } from '../src/sites/site-cdn.store';
import type { SiteSettingRow } from '../src/sites/site-settings.store';

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
    addresses: async () => ['203.0.113.20'],
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
  it('does not accept a successful API save as proof of certificate propagation, cache HIT or authentication', async () => {
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
      if (uri.includes('cdn-deny')) return { status: 403, body: '', headers: {}, fingerprint: 'expected' };
      if (uri.endsWith('probe.css'))
        return {
          status: headers?.cookie ? 403 : 200,
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
