import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { sitePathSchema } from '@eat/shared';
import type { FastifyRequest } from 'fastify';
import { decryptSecret } from '../common/crypto';
import { parseSiteHost } from './site-config';
import { SitesService, type SiteRow } from './sites.service';
import { SiteCdnStore } from './site-cdn.store';
import { cdnMarker, cdnProbeHost } from './site-cdn.infrastructure';

export const CDN_PATH = '/__eat/cdn/';
const asset = (path: string, type: string) =>
  !path.includes('%') &&
  /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|avif)$/i.test(path) &&
  /^(text\/css|(?:text|application)\/(?:javascript|x-javascript)|image\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+)(?:;|$)/i.test(
    type,
  );
export const secretEquals = (value: unknown, secret: string) =>
  typeof value === 'string' &&
  Buffer.byteLength(value) === Buffer.byteLength(secret) &&
  timingSafeEqual(Buffer.from(value), Buffer.from(secret));
const anonymous = (headers: Record<string, unknown>) =>
  !headers.cookie && !headers.authorization && !headers['service-worker'];
@Injectable()
export class SiteCdnCache {
  constructor(
    private readonly store: SiteCdnStore,
    private readonly sites: SitesService,
  ) {}
  async cacheableOrigin(req: FastifyRequest) {
    const row = await this.store.row();
    return (
      !!row?.connected &&
      row.status === 'enabled' &&
      req.method === 'GET' &&
      !!row.resources.configured &&
      row.resources.cacheModel === 'origin-v1' &&
      !req.headers['service-worker']
    );
  }
  async redirect(
    req: FastifyRequest,
    site: SiteRow,
    version: { id: string; number: number },
    path: string,
    type: string,
  ) {
    const row = await this.store.row();
    if (
      !row?.enabled ||
      !row.connected ||
      row.status !== 'enabled' ||
      row.resources.cacheModel !== 'origin-v1' ||
      !['public', 'password'].includes(site.access) ||
      req.method !== 'GET' ||
      !!req.headers['service-worker'] ||
      (req.raw.url ?? '').includes('?') ||
      !asset(path, type)
    )
      return null;
    return `${CDN_PATH}${site.id}/${version.id}/${site.accessRevision}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  /** Compatibility callback for old edge rules while an upgrade removes them. New rules never call it. */
  async authorize(req: FastifyRequest): Promise<boolean> {
    try {
      const row = await this.store.row();
      if (
        !row?.resources.owned ||
        !secretEquals(req.headers['x-eat-cdn-auth'], decryptSecret(row.originSecretEncrypted))
      )
        return false;
      const base = await this.store.settings.enabled();
      const host = req.headers['x-eat-cdn-host'];
      const uri = req.headers['x-eat-cdn-uri'];
      if (
        typeof host !== 'string' ||
        typeof uri !== 'string' ||
        !uri.startsWith('/') ||
        uri.startsWith('//') ||
        /[\r\n]/.test(uri)
      )
        return false;
      if (uri.startsWith('/__eat/cdn-deny/')) return false;
      if (uri === `/__eat/cdn-probe/${base.resourceKey}`)
        return host === cdnProbeHost(base) && anonymous(req.headers);
      if (uri === `${CDN_PATH}health/${base.resourceKey}/probe.css`)
        return (
          host === cdnProbeHost(base) &&
          anonymous(req.headers) &&
          ['GET', 'HEAD'].includes(String(req.headers['x-eat-cdn-method']))
        );
      // The edge may normalize dot segments/encoded separators before a cache lookup.
      let normalizedPath = uri.split('?')[0];
      for (let i = 0; i < 3; i++) {
        normalizedPath = decodeURIComponent(normalizedPath).replace(/\\/g, '/');
      }
      const segments: string[] = [];
      for (const segment of normalizedPath.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') segments.pop();
        else segments.push(segment);
      }
      normalizedPath = '/' + segments.join('/');
      if (normalizedPath.startsWith(CDN_PATH) && !uri.startsWith(CDN_PATH)) return false;
      const target = parseSiteHost(host, base.domain);
      if (!target) return false;
      await this.sites.get(target.slug);
      // Non-cache paths retain all original gateway authentication, redirects and comment flows.
      // No-store is never overridden for these responses.
      if (!uri.startsWith(CDN_PATH)) return true;
      if (
        !anonymous(req.headers) ||
        !['GET', 'HEAD'].includes(String(req.headers['x-eat-cdn-method'])) ||
        uri.includes('?')
      )
        return false;
      return !!(await this.resolve(host, uri));
    } catch {
      return false;
    }
  }
  async resolve(host: string, uri: string) {
    const base = await this.store.settings.enabled();
    const target = parseSiteHost(host, base.domain);
    const match = /^\/__eat\/cdn\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([1-9]\d*)\/(.+)$/.exec(uri);
    if (!target || !match || uri.includes('?')) return null;
    let path: string;
    try {
      path = decodeURIComponent(match[4]);
    } catch {
      return null;
    }
    if (!sitePathSchema.safeParse(path).success) return null;
    if (
      uri !==
      `${CDN_PATH}${match[1]}/${match[2]}/${match[3]}/${path.split('/').map(encodeURIComponent).join('/')}`
    )
      return null;
    const site = await this.sites.get(target.slug);
    if (site.id !== match[1] || !['public', 'password'].includes(site.access) || String(site.accessRevision) !== match[3])
      return null;
    const version = await this.sites.version(site, undefined, target.version);
    const file = version.manifest[path];
    if (version.id !== match[2] || !file || !asset(path, file.type)) return null;
    return { site, version, file, path };
  }
  async probe(req: FastifyRequest, path: string) {
    const row = await this.store.row();
    const base = await this.store.settings.row();
    if (
      !row ||
      !base ||
      ![`/__eat/cdn-probe/${base.resourceKey}`, `${CDN_PATH}health/${base.resourceKey}/probe.css`].includes(
        path,
      ) ||
      !anonymous(req.headers) ||
      !row.resources.owned ||
      !['GET', 'HEAD'].includes(req.method)
    )
      return null;
    return cdnMarker(row, path);
  }
}
