import { Injectable } from '@nestjs/common';
import { X509Certificate, createPrivateKey, randomUUID } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { request as requestHttp } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import type { SiteTlsOptions } from '@eat/shared';
import { loadConfig } from '../config';
import { DokployClient } from '../deploy/dokploy.client';
import { SiteStorage } from './site-storage.service';
import { SiteSettingsStore, type SiteSettingRow } from './site-settings.store';
import { SiteSetupError } from './site-dns.service';

const ROOT = '/etc/dokploy/traefik';
const MAIN = `${ROOT}/traefik.yml`;
export const siteResource = (r: SiteSettingRow) => `eat-sites-${r.resourceKey}`;
export const siteProbeHost = (r: SiteSettingRow) => `eat-check-${r.operationId!.slice(0, 8)}.${r.domain}`;
export function certificateInfo(pem: string) {
  const c = new X509Certificate(pem);
  return { cert: c, domains: c.subjectAltName ?? c.subject, expiresAt: new Date(c.validTo).toISOString() };
}
export function siteRoutes(row: SiteSettingRow, upstream: string, resolver?: string) {
  const key = siteResource(row);
  const rule = `HostRegexp(\`^[a-z0-9-]+\\.${row.domain.replace(/\./g, '\\.')}$\`)`;
  return {
    http: {
      routers: {
        [`${key}-http`]: { rule, ruleSyntax: 'v3', entryPoints: ['web'], service: key, middlewares: [`${key}-https`] },
        [`${key}-https`]: {
          rule,
          ruleSyntax: 'v3',
          entryPoints: ['websecure'],
          service: key,
          tls: resolver ? { certResolver: resolver, domains: [{ main: `*.${row.domain}` }] } : {},
        },
      },
      services: { [key]: { loadBalancer: { servers: [{ url: upstream }], passHostHeader: true } } },
      middlewares: { [`${key}-https`]: { redirectScheme: { scheme: 'https', permanent: true } } },
    },
  };
}
@Injectable()
export class SiteInfrastructure {
  constructor(
    private readonly storage: SiteStorage,
    private readonly settings: SiteSettingsStore,
  ) {}
  private query(serverId: string | null, path?: string) {
    return { ...(serverId ? { serverId } : {}), ...(path ? { path } : {}) };
  }
  async readMain(client: DokployClient, serverId: string | null) {
    const raw = await client.siteRequest<string | null>(
      'settings.readTraefikFile',
      undefined,
      this.query(serverId, MAIN),
    );
    if (!raw) throw new SiteSetupError('无法读取 Dokploy Traefik 配置，请确认 Traefik 已安装并授予配置读取权限');
    try {
      const config = parse(raw);
      if (
        !config?.entryPoints?.web ||
        !config?.entryPoints?.websecure ||
        !config?.providers?.file ||
        config.providers.file.watch === false
      )
        throw new Error();
      if (config.providers.file.directory !== `${ROOT}/dynamic`) throw new Error();
      return { raw, config };
    } catch {
      throw new SiteSetupError('Traefik 需要 web / websecure 入口及启用监视的标准 dynamic 文件目录');
    }
  }
  async tlsOptions(client: DokployClient, serverId: string | null): Promise<SiteTlsOptions> {
    const [{ config }, certs] = await Promise.all([
      this.readMain(client, serverId),
      client.siteRequest<any[]>('certificates.all'),
    ]);
    return {
      resolvers: Object.entries(config.certificatesResolvers ?? {})
        .filter(([, v]) => (v as any)?.acme?.dnsChallenge)
        .map(([name]) => name),
      certificates: (Array.isArray(certs) ? certs : [])
        .filter((c) => (c.serverId ?? null) === serverId)
        .flatMap((c) => {
          try {
            const { domains, expiresAt } = certificateInfo(c.certificateData);
            return [{ id: String(c.certificateId), name: String(c.name), domains, expiresAt, serverId }];
          } catch {
            return [];
          }
        }),
    };
  }
  async checkCertificate(client: DokployClient, row: SiteSettingRow) {
    if (row.tlsMode === 'certificate') {
      const c = await client.siteRequest<any>('certificates.one', undefined, { certificateId: row.certificateId });
      if ((c.serverId ?? null) !== row.serverId) throw new SiteSetupError('证书不在 EAT 应用所在的 Dokploy 服务器上');
      let cert: X509Certificate;
      try {
        cert = certificateInfo(c.certificateData).cert;
      } catch {
        throw new SiteSetupError('证书格式无效');
      }
      try {
        if (!cert.checkPrivateKey(createPrivateKey(c.privateKey))) throw new Error();
      } catch {
        throw new SiteSetupError('已有证书与私钥不匹配，请先在部署后台更新');
      }
      if (!cert.checkHost(`eat-check-${randomUUID().slice(0, 8)}.${row.domain}`))
        throw new SiteSetupError(`证书未覆盖 *.${row.domain}`);
      if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) < Date.now() + 7 * 86400_000)
        throw new SiteSetupError('证书尚未生效或将在 7 天内过期，请先更新证书');
    } else if (row.tlsMode === 'resolver') {
      const { config } = await this.readMain(client, row.serverId);
      if (!config.certificatesResolvers?.[row.resolverName]?.acme?.dnsChallenge)
        throw new SiteSetupError('所选解析器不存在或未使用 DNS 验证，无法签发泛域名证书');
    }
  }
  async checkOss(row: SiteSettingRow) {
    const client = this.storage.client(row);
    const key = `sites/_checks/${randomUUID()}`;
    const content = Buffer.from(randomUUID());
    let written = false;
    try {
      const acl = await client.getBucketACL(row.ossBucket);
      if (acl.acl !== 'private') throw new SiteSetupError('OSS Bucket 必须为私有读写，防止绕过 EAT 的登录与密码控制');
      // 即使上传超时也尝试清理，服务端可能已经写入。
      written = true;
      await client.put(key, content, {
        headers: { 'x-oss-object-acl': 'private', 'Content-Type': 'application/octet-stream' },
      });
      if (!Buffer.from((await client.get(key)).content as Buffer).equals(content))
        throw new SiteSetupError('OSS 测试文件读取内容不一致');
      let res: Response;
      try {
        res = await fetch(`https://${row.ossBucket}.${row.ossRegion}.aliyuncs.com/${key}`, {
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
      } catch {
        throw new SiteSetupError('无法完成 OSS 匿名访问检查，请确认外网 Endpoint 可访问');
      }
      if (![401, 403].includes(res.status))
        throw new SiteSetupError('OSS 匿名访问未被明确拒绝，请检查 Bucket Policy 和公共访问设置');
    } catch (e) {
      if (e instanceof SiteSetupError) throw e;
      const code = String((e as { code?: string })?.code ?? 'NETWORK_ERROR')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 80);
      throw new SiteSetupError(`OSS 检查失败（${code}），需要读取 Bucket ACL、上传、读取及删除 sites/ 前缀文件的权限`);
    } finally {
      if (written) {
        try {
          await client.deleteMulti([key], { quiet: true });
          try {
            await client.get(key);
            throw new SiteSetupError('OSS 测试文件删除后仍能读取');
          } catch (e) {
            if ((e as { status?: number }).status !== 404) throw e;
          }
        } catch {
          throw new SiteSetupError(`OSS 测试文件清理失败，请检查删除权限并清理 ${key}`);
        }
      }
    }
  }
  async addresses(host: string) {
    const literal = host.replace(/^\[|\]$/g, '');
    if (isIP(literal)) return [literal];
    const results = await Promise.allSettled([resolve4(host), resolve6(host)]);
    return [...new Set(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))].sort();
  }
  async checkDns(row: SiteSettingRow) {
    const expected = await this.addresses(row.gatewayTarget);
    if (!expected.length) throw new SiteSetupError('Dokploy 入口地址无法解析');
    for (let i = 0; i < 2; i++) {
      const actual = await this.addresses(`eat-check-${randomUUID().slice(0, 8)}.${row.domain}`);
      if (!actual.length || actual.some((ip) => !expected.includes(ip)))
        throw new SiteSetupError(
          `请将 *.${row.domain} 的 A/AAAA/CNAME 指向 ${row.gatewayTarget}，等待解析生效；Cloudflare 请关闭代理`,
        );
    }
  }
  async waitDns(row: SiteSettingRow, signal: AbortSignal) {
    const deadline = Date.now() + (row.autoDns ? 120_000 : 0);
    for (;;) {
      try {
        await this.checkDns(row);
        return;
      } catch (e) {
        if (Date.now() >= deadline || signal.aborted) throw e;
        await delay(3000, undefined, { signal }).catch(() => {});
      }
    }
  }
  async ensureGateway(client: DokployClient, row: SiteSettingRow, signal: AbortSignal) {
    const containers = () =>
      client.siteRequest<{ name: string; state: string; status: string }[]>(
        'docker.getContainersByAppNameMatch',
        undefined,
        { ...this.query(row.serverId), appName: 'dokploy-traefik' },
      );
    const healthy = (rows: Awaited<ReturnType<typeof containers>>) =>
      Array.isArray(rows) &&
      rows.some(
        (c) =>
          (c.name === 'dokploy-traefik' || c.name.startsWith('dokploy-traefik.')) &&
          c.state === 'running' &&
          !/unhealthy|health: starting/i.test(c.status),
      );
    const existing = await containers();
    if (healthy(existing)) return;
    if (!existing?.some((c) => c.name === 'dokploy-traefik' || c.name.startsWith('dokploy-traefik.')))
      throw new SiteSetupError('目标服务器未安装标准 Dokploy Traefik 网关，请先在部署后台完成服务器初始化');
    await client.siteRequest('settings.reloadTraefik', this.query(row.serverId));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !signal.aborted) {
      await delay(3000, undefined, { signal }).catch(() => {});
      if (healthy(await containers())) return;
    }
    throw new SiteSetupError('共享 Traefik 网关自动启动后仍未就绪，请检查部署后台日志与端口占用');
  }
  async configure(client: DokployClient, row: SiteSettingRow, upstream: string) {
    let resolver: string | undefined;
    if (['alidns', 'cloudflare'].includes(row.tlsMode)) {
      resolver = siteResource(row);
      const { raw, config } = await this.readMain(client, row.serverId);
      const env = await client.siteRequest<string>('settings.readTraefikEnv', undefined, this.query(row.serverId));
      const credentials = this.settings.secrets(row);
      const desired: Record<string, string> =
        row.tlsMode === 'alidns'
          ? { ALICLOUD_ACCESS_KEY: credentials.dnsAccessKeyId, ALICLOUD_SECRET_KEY: credentials.dnsAccessKeySecret }
          : { CF_DNS_API_TOKEN: credentials.dnsAccessKeySecret };
      const lines = (env ?? '').split('\n').filter(Boolean);
      const existing = Object.fromEntries(
        lines.map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i), l.slice(i + 1)];
        }),
      );
      const otherResolvers = Object.entries(config.certificatesResolvers ?? {}).filter(
        ([name, value]) => name !== resolver && (value as any)?.acme?.dnsChallenge?.provider === row.tlsMode,
      );
      const changed = Object.entries(desired).filter(([key, value]) => existing[key] !== value);
      for (const [key] of changed) {
        if (
          otherResolvers.length ||
          existing[`${key}_FILE`] ||
          (existing[key] && !config.certificatesResolvers?.[resolver])
        )
          throw new SiteSetupError(`Traefik 的 ${key} 被其他证书配置使用，请复用已有 DNS 解析器，避免影响其他服务`);
      }
      const resolverConfig = {
        acme: {
          email: row.acmeEmail,
          storage: `${ROOT}/dynamic/${resolver}-acme.json`,
          dnsChallenge: { provider: row.tlsMode },
        },
      };
      const configChanged = JSON.stringify(config.certificatesResolvers?.[resolver]) !== JSON.stringify(resolverConfig);
      config.certificatesResolvers ??= {};
      config.certificatesResolvers[resolver] = resolverConfig;
      if ((await this.readMain(client, row.serverId)).raw !== raw)
        throw new SiteSetupError('Traefik 配置已被其他操作修改，请重试');
      if (configChanged) {
        const next = stringify(config);
        await client.siteRequest('settings.updateTraefikFile', {
          ...this.query(row.serverId, MAIN),
          traefikConfig: next,
        });
        if ((await this.readMain(client, row.serverId)).raw.trim() !== next.trim())
          throw new SiteSetupError('Traefik 静态配置写入后校验失败');
      }
      // 先写动态路由，再触发重载；部署后台自身也可能经由同一 Traefik 访问。
      await this.writeRoute(client, row, stringify(siteRoutes(row, upstream, resolver)));
      if (changed.length) {
        const current = await client.siteRequest<string>(
          'settings.readTraefikEnv',
          undefined,
          this.query(row.serverId),
        );
        if (current !== env) throw new SiteSetupError('Traefik 凭证配置已被其他操作修改，请重试');
        const keys = new Set(changed.map(([key]) => key));
        await client.siteRequest('settings.writeTraefikEnv', {
          ...this.query(row.serverId),
          env: [...lines.filter((line) => !keys.has(line.split('=')[0])), ...changed.map(([k, v]) => `${k}=${v}`)].join(
            '\n',
          ),
        });
      } else if (configChanged) await client.siteRequest('settings.reloadTraefik', this.query(row.serverId));
      return;
    }
    if (row.tlsMode === 'resolver') resolver = row.resolverName;
    await this.writeRoute(client, row, stringify(siteRoutes(row, upstream, resolver)));
  }
  private async writeRoute(client: DokployClient, row: SiteSettingRow, config: string) {
    const query = this.query(row.serverId, `${ROOT}/dynamic/${siteResource(row)}.yml`);
    await client.siteRequest('settings.updateTraefikFile', { ...query, traefikConfig: config });
    const actual = await client.siteRequest<string | null>('settings.readTraefikFile', undefined, query);
    if (actual?.trim() !== config.trim())
      throw new SiteSetupError('Folio 路由写入后校验失败，请检查 Traefik 配置写入权限');
  }
  async withdraw(client: DokployClient, row: SiteSettingRow) {
    await this.writeRoute(
      client,
      row,
      stringify({
        http: {
          middlewares: {
            [`${siteResource(row)}-disabled`]: { headers: { customResponseHeaders: { 'X-EAT-Sites-Disabled': '1' } } },
          },
        },
      }),
    );
  }
  async probeHttps(url: string, marker: string, signal: AbortSignal) {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        url,
        { timeout: 10_000, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
        (res) => {
          const cert = (res.socket as TLSSocket).getPeerCertificate();
          if (res.statusCode !== 200 || !cert.valid_to || Date.parse(cert.valid_to) < Date.now() + 7 * 86400_000) {
            res.resume();
            reject(new Error('证书有效期不足或 HTTPS 状态码异常'));
            return;
          }
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 4096) req.destroy(new Error('响应过大'));
          });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', reject);
      req.end();
    });
    if (body !== marker) throw new Error('HTTPS 请求未到达当前 EAT 实例，请核对转发目标与端口');
  }
  async probeHttpRedirect(url: string, signal: AbortSignal) {
    const { status, location } = await new Promise<{ status: number | undefined; location: string | undefined }>(
      (resolve, reject) => {
        const req = requestHttp(
          url,
          { timeout: 10_000, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
          (res) => {
            res.resume();
            resolve({ status: res.statusCode, location: res.headers.location });
          },
        );
        req.on('timeout', () => req.destroy(new Error('HTTP 连接超时')));
        req.on('error', reject);
        req.end();
      },
    );
    const target = new URL(url);
    target.protocol = 'https:';
    if (![301, 302, 307, 308].includes(status ?? 0) || !location || new URL(location, url).href !== target.href)
      throw new Error('HTTP 未正确跳转到 HTTPS');
  }
  async verify(
    row: SiteSettingRow,
    marker: string,
    signal: AbortSignal,
    progress?: (message: string) => Promise<void>,
  ) {
    const host = siteProbeHost(row);
    const path = `/__eat/verify/${row.operationId}`;
    const deadline = Date.now() + 5 * 60_000;
    let reason = 'HTTPS 尚未就绪';
    while (Date.now() < deadline && !signal.aborted) {
      try {
        await this.probeHttps(`https://${host}${path}`, marker, signal);
        await this.probeHttps(
          `${row.platformUrl || loadConfig().publicUrl}/api/sites/verification/${row.operationId}`,
          marker,
          signal,
        );
        await this.probeHttpRedirect(`http://${host}${path}`, signal);
        return;
      } catch (e) {
        const code = (e as { code?: string }).code;
        reason = code ? `HTTPS 验证失败（${code}）` : (e as Error).message;
        await progress?.(`等待就绪：${reason}`);
      }
      await delay(3000, undefined, { signal }).catch(() => {});
    }
    throw new SiteSetupError(`${reason}；请检查证书签发、80/443 端口、DNS 与 EAT 转发地址后重试`);
  }
}
