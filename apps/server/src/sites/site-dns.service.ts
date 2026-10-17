import { Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { SiteSettingRow } from './site-settings.store';
import { SiteSettingsStore } from './site-settings.store';

export class SiteSetupError extends Error {}
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  line?: string;
  status?: string;
}
export interface SiteDnsClient {
  zone: string;
  records(name: string): Promise<DnsRecord[]>;
  add(name: string, type: string, content: string): Promise<string>;
  remove(id: string): Promise<void>;
  update(record: DnsRecord): Promise<void>;
}
@Injectable()
export class SiteDns {
  constructor(private readonly settings: SiteSettingsStore) {}
  async connect(row: SiteSettingRow): Promise<SiteDnsClient> {
    const credentials = this.settings.secrets(row);
    const candidates = row.domain
      .split('.')
      .map((_, i, parts) => parts.slice(i).join('.'))
      .filter((s) => s.includes('.'));
    if (row.tlsMode === 'cloudflare') {
      const call = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
        let response: Response;
        try {
          response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
            method,
            headers: {
              authorization: `Bearer ${credentials.dnsAccessKeySecret}`,
              'content-type': 'application/json',
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(20_000),
          });
        } catch {
          throw new SiteSetupError('Cloudflare API 连接失败或超时');
        }
        const json = (await response.json()) as { success?: boolean; result?: unknown };
        if (!response.ok || !json.success)
          throw new SiteSetupError(
            `Cloudflare DNS 操作失败（HTTP ${response.status}），请检查目标域名的 Zone Read / DNS Edit 权限`,
          );
        return json.result;
      };
      for (const zone of candidates) {
        const zones = await call(`/zones?name=${encodeURIComponent(zone)}&status=active`);
        if (!Array.isArray(zones) || !zones[0]?.id) continue;
        const id = zones[0].id as string;
        return {
          zone,
          records: async (name) =>
            (await call(`/zones/${id}/dns_records?name=${encodeURIComponent(name)}&per_page=100`)).map(
              (r: any) => ({
                id: r.id,
                type: r.type,
                name: r.name,
                content: r.content,
                ttl: r.ttl,
                proxied: r.proxied,
              }),
            ),
          add: async (name, type, content) =>
            (
              await call(`/zones/${id}/dns_records`, 'POST', {
                name,
                type,
                content,
                ttl: 120,
                proxied: false,
              })
            ).id,
          update: async (record) => {
            await call(`/zones/${id}/dns_records/${encodeURIComponent(record.id)}`, 'PUT', {
              name: record.name,
              type: record.type,
              content: record.content,
              ttl: record.ttl ?? 120,
              proxied: false,
            });
          },
          remove: async (recordId) => {
            await call(`/zones/${id}/dns_records/${encodeURIComponent(recordId)}`, 'DELETE');
          },
        };
      }
      throw new SiteSetupError('Cloudflare 凭证无法读取该域名所属的 DNS 区域');
    }
    if (row.tlsMode !== 'alidns') throw new SiteSetupError('当前证书方式没有 DNS API 凭证');
    const call = async (action: string, extra: Record<string, string> = {}): Promise<any> => {
      const params: Record<string, string> = {
        Format: 'JSON',
        Version: '2015-01-09',
        AccessKeyId: credentials.dnsAccessKeyId,
        SignatureMethod: 'HMAC-SHA1',
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        SignatureVersion: '1.0',
        SignatureNonce: randomUUID(),
        Action: action,
        ...extra,
      };
      const canonical = Object.keys(params)
        .sort()
        .map((k) => `${encode(k)}=${encode(params[k])}`)
        .join('&');
      params.Signature = createHmac('sha1', `${credentials.dnsAccessKeySecret}&`)
        .update(`POST&%2F&${encode(canonical)}`)
        .digest('base64');
      let response: Response;
      try {
        response = await fetch('https://alidns.aliyuncs.com/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new SiteSetupError('阿里云 DNS API 连接失败或超时');
      }
      const json = (await response.json()) as any;
      if (!response.ok || json.Code)
        throw new SiteSetupError(
          `阿里云 DNS ${action} 失败（${String(json.Code ?? response.status)
            .replace(/[^a-zA-Z0-9._-]/g, '')
            .slice(0, 100)}），请检查 DNS 权限`,
        );
      return json;
    };
    let zones: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const json = await call('DescribeDomains', { PageSize: '100', PageNumber: String(page) });
      zones.push(...(json.Domains?.Domain ?? []).map((d: any) => d.DomainName));
      if (page * 100 >= Number(json.TotalCount ?? 0)) break;
    }
    const zone = candidates.find((c) => zones.includes(c));
    if (!zone) throw new SiteSetupError('阿里云 DNS 凭证无法读取该域名所属的 DNS 区域');
    const rr = (name: string) => (name === zone ? '@' : name.slice(0, -zone.length - 1));
    return {
      zone,
      records: async (name) => {
        const json = await call('DescribeDomainRecords', {
          DomainName: zone,
          RRKeyWord: rr(name),
          PageSize: '500',
          SearchMode: 'EXACT',
        });
        return (json.DomainRecords?.Record ?? [])
          .filter((r: any) => r.RR === rr(name))
          .map((r: any) => ({
            id: r.RecordId,
            type: r.Type,
            name,
            content: r.Value,
            ttl: r.TTL,
            line: r.Line,
            status: r.Status,
          }));
      },
      add: async (name, type, content) =>
        (
          await call('AddDomainRecord', {
            DomainName: zone,
            RR: rr(name),
            Type: type,
            Value: content,
            TTL: '600',
          })
        ).RecordId,
      update: async (record) => {
        await call('UpdateDomainRecord', {
          RecordId: record.id,
          RR: rr(record.name),
          Type: record.type,
          Value: record.content,
          TTL: String(record.ttl ?? 600),
        });
      },
      remove: async (id) => {
        await call('DeleteDomainRecord', { RecordId: id });
      },
    };
  }
  async checkPermissions(client: SiteDnsClient, row: SiteSettingRow) {
    const name = `_eat-check-${randomUUID().slice(0, 8)}.${row.domain}`;
    const value = randomUUID();
    let id: string | undefined;
    try {
      id = await client.add(name, 'TXT', value);
      if (!id) throw new SiteSetupError('DNS 服务商未返回新建 TXT 记录的 ID');
      const records = await client.records(name);
      if (!records.some((r) => r.id === id && r.content === value))
        throw new SiteSetupError('DNS 测试 TXT 记录写入后无法读回');
    } finally {
      if (id) await client.remove(id);
      else {
        // 创建超时也可能已落库，按随机名称和内容只清理本次测试记录。
        for (const record of await client.records(name))
          if (record.type === 'TXT' && record.content === value) await client.remove(record.id);
      }
      if ((await client.records(name)).some((record) => record.type === 'TXT' && record.content === value))
        throw new SiteSetupError(`DNS 测试 TXT 删除后仍存在，请清理 ${name}`);
    }
  }
  async ensureWildcard(client: SiteDnsClient, row: SiteSettingRow) {
    const name = `*.${row.domain}`;
    const content = row.gatewayTarget.replace(/^\[|\]$/g, '').toLowerCase();
    const type = isIP(content) === 4 ? 'A' : isIP(content) === 6 ? 'AAAA' : 'CNAME';
    const records = await client.records(name);
    if (records.some((r) => r.type === type && r.content.toLowerCase().replace(/\.$/, '') === content))
      return null;
    if (records.length) throw new SiteSetupError('已有不同的通配 DNS 记录，EAT 不会覆盖，请先核对并手动处理');
    const id = await client.add(name, type, content);
    return { id, client };
  }
}
