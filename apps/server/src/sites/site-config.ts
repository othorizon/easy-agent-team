import { Injectable } from '@nestjs/common';
import { loadConfig } from '../config';
import { SiteSettingsStore } from './site-settings.store';

export function parseSiteHost(host: string, domain: string): { slug: string; version?: number } | null {
  const normalized = host.toLowerCase();
  if (!domain || !normalized.endsWith(`.${domain}`)) return null;
  const label = normalized.slice(0, -(domain.length + 1));
  const match = /^(?:v([1-9]\d{0,8})--)?([a-z0-9][a-z0-9-]{0,39})$/.exec(label);
  if (!match || match[2].includes('--')) return null;
  return { slug: match[2], ...(match[1] ? { version: Number(match[1]) } : {}) };
}
@Injectable()
export class SiteRuntime {
  constructor(readonly settings: SiteSettingsStore) {}
  async platform() {
    return (await this.settings.required()).platformUrl || loadConfig().publicUrl.replace(/\/$/, '');
  }
  async config() {
    const r = await this.settings.required();
    return {
      domain: r.domain,
      protocol: 'https' as 'http' | 'https',
      platform: r.platformUrl || loadConfig().publicUrl.replace(/\/$/, ''),
    };
  }
  async url(slug: string, version?: number) {
    const { domain, protocol } = await this.config();
    return `${protocol}://${version ? `v${version}--` : ''}${slug}.${domain}`;
  }
}
