import { Injectable } from '@nestjs/common';
import { createHash, createHmac, createPrivateKey, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { resolveCname } from 'node:dns/promises';
import { SiteInfrastructure, siteResource } from './site-infrastructure.service';
import { SiteSetupError } from './site-dns.service';
import { SiteCdnClient, cdnFunction, type CdnCredentials } from './site-cdn.client';
import { decryptSecret } from '../common/crypto';
import { DokploySettingsService } from '../deploy/dokploy-settings.service';
import type { SiteSettingRow } from './site-settings.store';
import type { SiteCdnRow } from './site-cdn.store';

export const CDN_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const cdnDomain = (base: SiteSettingRow) => `.${base.domain}`;
export const cdnSni = (base: SiteSettingRow) => `eat-origin-${base.resourceKey.slice(0, 8)}.${base.domain}`;
export const cdnProbeHost = (base: SiteSettingRow) =>
  `eat-cdn-${base.resourceKey.slice(0, 8)}.${base.domain}`;
export const cdnMarker = (row: SiteCdnRow, path: string) =>
  createHmac('sha256', decryptSecret(row.originSecretEncrypted)).update(path).digest('hex');
export async function checkCdnOrigin(
  base: SiteSettingRow,
  cname = '',
  lookup: (host: string) => Promise<string[]> = resolveCname,
) {
  let host = base.gatewayTarget
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  const seen = new Set<string>();
  for (let i = 0; i < 16; i++) {
    if (
      host === base.domain ||
      host.endsWith(`.${base.domain}`) ||
      (cname && host === cname) ||
      seen.has(host)
    )
      throw new SiteSetupError('源站 CNAME 链会回到 Folio CDN，禁止循环回源');
    if (isIP(host)) return;
    seen.add(host);
    let aliases: string[];
    try {
      aliases = await lookup(host);
    } catch (e) {
      if (['ENODATA', 'ENOTFOUND'].includes(String((e as { code?: string }).code))) return;
      throw new SiteSetupError('无法检查源站 CNAME 链，请检查独立源站解析');
    }
    if (!aliases.length) return;
    if (aliases.length !== 1) throw new SiteSetupError('源站 CNAME 链不唯一，请使用独立源站地址');
    host = aliases[0].toLowerCase().replace(/\.$/, '');
  }
  throw new SiteSetupError('源站 CNAME 链过长，请使用独立源站地址');
}
export function cdnFunctions(row: SiteCdnRow, base: SiteSettingRow) {
  const secret = decryptSecret(row.originSecretEncrypted);
  return [
    cdnFunction('forward_scheme', { enable: 'on', scheme_origin: 'https', scheme_origin_port: '443' }),
    // HTTP Host remains the actual incoming Folio host; SNI selects its wildcard certificate.
    cdnFunction('https_origin_sni', { enabled: 'on', https_origin_sni: cdnSni(base) }),
    // The official example uses enable, while the parameter table says enabled.
    cdnFunction('origin_certificate_verification', {
      [row.resources.certificateVerificationArg ?? 'enable']: 'on',
    }),
    cdnFunction('origin_request_header', {
      header_operation_type: 'modify',
      header_name: 'X-Eat-Cdn-Origin',
      header_value: secret,
    }),
    cdnFunction('cdn_remote_auth', {
      enable: 'on',
      remote_auth_addr: `${base.platformUrl}/api/sites/cdn-auth`,
      remote_auth_method: 'get',
      remote_auth_type: 'all',
      remote_auth_reserve_args: 'ali_delete_all_args',
      remote_auth_reserve_header: 'Cookie|Authorization|Service-Worker',
      remote_auth_custom_header: `X-Eat-Cdn-Auth=${secret}|X-Eat-Cdn-Host=$http_host|X-Eat-Cdn-Uri=$request_uri|X-Eat-Cdn-Method=$request_method`,
      remote_auth_success_code: '200',
      remote_auth_fail_code: '403',
      remote_auth_other_code_act: 'reject',
      remote_auth_fail_resp_code: '403',
      remote_auth_timeout: '3000',
      remote_auth_timeout_action: 'reject',
    }),
    cdnFunction('path_based_ttl_set', {
      path: '/',
      ttl: '0',
      weight: '1',
      swift_origin_cache_high: 'on',
      swift_no_cache_low: 'off',
      swift_follow_cachetime: 'off',
    }),
    // Only the gateway's explicitly marked, anonymous static responses have public origin headers.
    cdnFunction('path_based_ttl_set', {
      path: '/__eat/cdn/',
      ttl: String(CDN_CACHE_TTL_SECONDS),
      weight: '99',
      swift_origin_cache_high: 'on',
      swift_no_cache_low: 'off',
      swift_follow_cachetime: 'off',
    }),
    cdnFunction('self_defined_cachekey', { headers: 'Host' }),
    cdnFunction('set_resp_header', {
      key: 'Cache-Control',
      value: 'private, no-store',
      header_operation_type: 'modify',
    }),
  ];
}
const configParent = (c: any) => {
  const parent = String(c.ParentId ?? c.parentId ?? '');
  // Aliyun returns numeric 0 for unbound rules; requests omit parentId or use -1.
  return ['', '0', '-1'].includes(parent) ? '' : parent;
};
// Service-generated TLS, transport, scheduling and lifecycle settings are retained in place.
// Do not ignore arbitrary functions: cache/header/auth functions still require exact ownership checks.
const providerFunctions = new Set([
  'https_option',
  'https_tls_version',
  'domain_status',
  'dm_coverage',
  'p2pqos',
  'ipv6',
  'cc_defense',
  'alicdn_v2_architecture',
  'consistent_hash',
  'domain_schdm',
]);
export const cdnConfigsToCheck = (configs: any[]) =>
  configs.filter((c) => configParent(c) || !providerFunctions.has(c.FunctionName ?? c.functionName));
export function configDigest(configs: any[]) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        configs
          .map((c) => ({
            name: c.FunctionName ?? c.functionName,
            parent: configParent(c),
            args: (c.FunctionArgs?.FunctionArg ?? c.functionArgs ?? [])
              .map((a: any) => [a.ArgName ?? a.argName, String(a.ArgValue ?? a.argValue)])
              .sort(),
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    )
    .digest('hex');
}
@Injectable()
export class SiteCdnInfrastructure {
  constructor(
    private readonly dokploy: DokploySettingsService,
    private readonly infra: SiteInfrastructure,
    private readonly api: SiteCdnClient,
  ) {}
  async certificate(base: SiteSettingRow) {
    const client = await this.dokploy.client();
    let pem = '',
      key = '';
    if (base.tlsMode === 'certificate') {
      const c = await client.siteRequest<any>('certificates.one', undefined, {
        certificateId: base.certificateId,
      });
      if ((c.serverId ?? null) !== base.serverId) throw new SiteSetupError('源站证书不在同一服务器');
      pem = c.certificateData;
      key = c.privateKey;
    } else {
      const { config } = await this.infra.readMain(client, base.serverId);
      const resolver = base.tlsMode === 'resolver' ? base.resolverName : siteResource(base);
      const storage = config.certificatesResolvers?.[resolver]?.acme?.storage;
      if (
        typeof storage !== 'string' ||
        !/^\/etc\/dokploy\/traefik\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/.test(storage)
      )
        throw new SiteSetupError('无法安全读取源站 ACME 存储；需要标准 Traefik ACME JSON 路径及读取权限');
      const raw = await client.siteRequest<string>('settings.readTraefikFile', undefined, {
        path: storage,
        ...(base.serverId ? { serverId: base.serverId } : {}),
      });
      try {
        const certificates = JSON.parse(raw)?.[resolver]?.Certificates ?? [];
        const c = certificates.find(
          (v: any) => v.domain?.main === `*.${base.domain}` || v.domain?.sans?.includes(`*.${base.domain}`),
        );
        if (!c) throw new Error();
        pem = Buffer.from(c.certificate, 'base64').toString();
        key = Buffer.from(c.key, 'base64').toString();
      } catch {
        throw new SiteSetupError('源站 ACME 泛域名证书尚未就绪，Traefik 继续负责签发和续期');
      }
    }
    try {
      const cert = new X509Certificate(pem);
      if (
        !cert.checkHost(cdnSni(base)) ||
        !cert.checkHost(`v1--example.${base.domain}`) ||
        !cert.checkPrivateKey(createPrivateKey(key)) ||
        Date.parse(cert.validTo) < Date.now() + 7 * 86400_000 ||
        Date.parse(cert.validFrom) > Date.now()
      )
        throw new Error();
      return { pem, key, expiresAt: new Date(cert.validTo), fingerprint: cert.fingerprint256 };
    } catch {
      throw new SiteSetupError('源站泛域名证书无效、私钥不匹配或剩余有效期不足七天');
    }
  }
  async configurations(credentials: CdnCredentials, domain: string) {
    const json = await this.api.call(credentials, 'DescribeCdnDomainConfigs', { DomainName: domain });
    return json.DomainConfigs?.DomainConfig ?? [];
  }
  async probe(host: string, address: string, path: string, headers: Record<string, string> = {}) {
    const ips = await this.infra.addresses(address);
    if (!ips.length) throw new SiteSetupError('链路检查目标无法解析');
    return new Promise<{ status: number; body: string; headers: Record<string, any>; fingerprint: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: host,
            servername: host,
            port: 443,
            // Source and edge share Host/SNI but have different pinned addresses.
            // Node's default keep-alive agent pools by hostname, ignoring lookup changes.
            agent: false,
            path,
            method: 'GET',
            headers: { ...headers, host },
            lookup: (_hostname: any, options: any, callback: any) =>
              options?.all
                ? callback(null, [{ address: ips[0], family: isIP(ips[0]) }])
                : callback(null, ips[0], isIP(ips[0])),
            timeout: 10_000,
          },
          (res) => {
            const fingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256 ?? '';
            let body = '';
            res.on('data', (c) => {
              body += c;
              if (body.length > 8192) req.destroy(new Error('probe response too large'));
            });
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body,
                headers: res.headers,
                fingerprint,
              }),
            );
            res.on('error', reject);
          },
        );
        req.on('error', () =>
          reject(new SiteSetupError('HTTPS 链路检查失败，请检查证书、SNI、Host、443 端口及回源地址')),
        );
        req.on('timeout', () => req.destroy());
        req.end();
      },
    );
  }
  async verify(base: SiteSettingRow, row: SiteCdnRow, address: string, edge: boolean) {
    const stage = edge ? 'CDN 接入检查' : '源站直连检查';
    const destinations = await this.infra.addresses(address);
    if (!destinations.length) throw new SiteSetupError(`${stage}失败：目标地址无法解析`);
    const targetAddress = destinations[0];
    const path = `/__eat/cdn-probe/${base.resourceKey}`;
    let res: Awaited<ReturnType<SiteCdnInfrastructure['probe']>>;
    try {
      res = await this.probe(
        cdnProbeHost(base),
        targetAddress,
        path,
        edge ? {} : { 'x-eat-cdn-origin': decryptSecret(row.originSecretEncrypted) },
      );
    } catch {
      throw new SiteSetupError(`${stage}失败：HTTPS 连接未完成，请检查证书、Host/SNI、443 端口及目标可达性`);
    }
    if (res.status !== 200) {
      const hint = edge && res.status === 403
        ? '请检查远程鉴权地址是否可达及鉴权请求是否被正确转发'
        : edge && [502, 504].includes(res.status)
          ? '请检查 HTTPS 回源地址、Host/SNI 与源站证书'
          : '请检查 Dokploy 泛域名路由及代理是否转发到当前 EAT';
      throw new SiteSetupError(`${stage}失败：HTTP ${res.status}，${hint}`);
    }
    if (res.body !== cdnMarker(row, path))
      throw new SiteSetupError(`${stage}失败：HTTP 200，但 EAT 实例标记不匹配，请检查路由、实例与回源密钥转发`);
    if (!String(res.headers['cache-control']).includes('no-store'))
      throw new SiteSetupError(`${stage}失败：HTTP 200，但客户端响应缺少 Cache-Control: no-store`);
    if (edge) {
      if (res.fingerprint !== row.resources.certificateFingerprint)
        throw new SiteSetupError('CDN 边缘证书尚未与源站同步，禁止切换 DNS');
      const denied = await this.probe(
        cdnProbeHost(base),
        targetAddress,
        `/__eat/cdn-deny/${base.resourceKey}`,
      );
      if (denied.status !== 403) throw new SiteSetupError('CDN 远程鉴权尚未拒绝测试请求，禁止切换 DNS');
      const asset = `/__eat/cdn/health/${base.resourceKey}/probe.css`;
      const first = await this.probe(cdnProbeHost(base), targetAddress, asset);
      const second = await this.probe(cdnProbeHost(base), targetAddress, asset);
      if (
        first.status !== 200 ||
        second.status !== 200 ||
        second.body !== cdnMarker(row, asset) ||
        !String(second.headers['x-cache']).includes('HIT') ||
        !String(second.headers['cache-control']).includes('no-store')
      )
        throw new SiteSetupError('CDN 尚未验证静态资源缓存命中及浏览器 no-store，禁止切换 DNS');
      const revoked = await this.probe(cdnProbeHost(base), targetAddress, asset, {
        cookie: 'eat_site=cdn-probe-denied',
      });
      if (revoked.status !== 403) throw new SiteSetupError('CDN 旧缓存未执行命中前鉴权，禁止切换 DNS');
    }
  }
}
