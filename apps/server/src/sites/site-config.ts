import { ServiceUnavailableException } from '@nestjs/common';
import { loadConfig } from '../config';

export function siteConfig() {
  const domain = (
    process.env.EAT_SITES_DOMAIN ??
    (process.env.NODE_ENV === 'production' ? '' : `sites.localhost:${process.env.PORT ?? 3000}`)
  )
    .toLowerCase()
    .trim();
  const protocol = process.env.EAT_SITES_HTTPS === '0' || /^sites\.localhost(?::|$)/.test(domain) ? 'http' : 'https';
  if (domain && (!/^[a-z0-9.-]+(?::\d+)?$/.test(domain) || domain === new URL(loadConfig().publicUrl).host)) {
    throw new Error('EAT_SITES_DOMAIN 必须是独立于平台的域名后缀，不包含协议或路径');
  }
  return {
    domain,
    protocol,
    platform: loadConfig().publicUrl.replace(/\/$/, ''),
    storage: process.env.EAT_SITES_STORAGE === 'oss' ? ('oss' as const) : ('local' as const),
  };
}

export function siteUrl(slug: string, version?: number): string {
  const { domain, protocol } = siteConfig();
  if (!domain) throw new ServiceUnavailableException('尚未配置 EAT_SITES_DOMAIN');
  return `${protocol}://${version ? `v${version}--` : ''}${slug}.${domain}`;
}

export function parseSiteHost(host: string): { slug: string; version?: number } | null {
  const { domain } = siteConfig();
  const normalized = host.toLowerCase();
  if (!domain || !normalized.endsWith(`.${domain}`)) return null;
  const label = normalized.slice(0, -(domain.length + 1));
  const match = /^(?:v([1-9]\d{0,8})--)?([a-z0-9][a-z0-9-]{0,39})$/.exec(label);
  if (!match || match[2].includes('--')) return null;
  return { slug: match[2], ...(match[1] ? { version: Number(match[1]) } : {}) };
}

export function isSiteHost(host: string): boolean {
  const { domain } = siteConfig();
  return !!domain && host.toLowerCase().endsWith(`.${domain}`);
}
