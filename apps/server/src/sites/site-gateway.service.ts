import { BadRequestException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sitePathSchema } from '@eat/shared';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { parseSiteHost, SiteRuntime } from './site-config';
import { SITE_EMBED_SCRIPT } from './site-embed';
import { SiteStorage } from './site-storage.service';
import { SitesService } from './sites.service';

import { siteProbeHost } from './site-infrastructure.service';
import { siteProbeMarker } from './site-setup.service';

const COOKIE = 'eat_site';
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

@Injectable()
export class SiteGateway {
  constructor(
    private readonly sites: SitesService,
    private readonly storage: SiteStorage,
    private readonly auth: AuthService,
    private readonly runtime: SiteRuntime,
  ) {}

  async handle(req: FastifyRequest, reply: FastifyReply) {
    const host = (req.headers.host ?? '').toLowerCase();
    const setting = await this.runtime.settings.row();
    if (!setting || !(host === setting.domain || host.endsWith(`.${setting.domain}`))) return;
    reply
      .header('cache-control', 'private, no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff');
    try {
      if (
        setting.operationId &&
        setting.status === 'verifying' &&
        host === siteProbeHost(setting) &&
        req.method === 'GET' &&
        req.raw.url === `/__eat/verify/${setting.operationId}`
      )
        return reply.type('text/plain').send(siteProbeMarker(setting));
      if (setting.status !== 'enabled') return reply.status(503).send('静态网站尚未启用');
      const target = parseSiteHost(host, setting.domain);
      if (!target) return reply.status(404).send('网站不存在');
      const site = await this.sites.get(target.slug);
      const base = await this.runtime.url(site.slug, target.version);
      const url = new URL(req.raw.url ?? '/', base);
      if (req.method === 'GET' && url.pathname === '/__eat/embed.js')
        return reply.type('text/javascript; charset=utf-8').send(SITE_EMBED_SCRIPT);
      if (req.method === 'GET' && url.pathname === '/__eat/login') {
        const ticket = await this.sites.session(site, url.searchParams.get('code') ?? '', 'ticket', host, true);
        if (!ticket?.user) throw new UnauthorizedException('登录链接已失效，请重新登录');
        const session = await this.sites.newSession(site, 'view', ticket.user.tokenId, host);
        this.cookie(reply, session);
        return reply.redirect(ticket.row.returnPath);
      }
      const version = await this.sites.version(site, undefined, target.version);
      // 固定域名直接提供当前版本；只有显式版本域名固定到对应快照。
      if (req.method === 'POST' && url.pathname === '/__eat/access') {
        const origin = req.headers.origin;
        if (origin !== new URL(base).origin) return reply.status(403).send({ message: '请求来源不合法' });
        const data = z
          .object({ password: z.string().max(128).optional(), accessToken: z.string().max(4096).optional() })
          .parse(await this.body(req));
        await this.sites.unlock(site, data.password, data.accessToken, req.ip);
        const session = await this.sites.newSession(site, 'view', null, host);
        this.cookie(reply, session);
        return reply.send({ ok: true });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.status(405).send('仅支持静态文件访问');
      const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const user = bearer ? await this.auth.authenticate(bearer) : null;
      const cookie = req.headers.cookie
        ?.split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1);
      const session = await this.sites.session(site, cookie, 'view', host);
      const share = url.searchParams.get('eat_access');
      if (share && site.access === 'password') {
        await this.sites.unlock(site, undefined, share, req.ip);
        const token = await this.sites.newSession(site, 'view', null, host);
        this.cookie(reply, token);
        url.searchParams.delete('eat_access');
        return reply.redirect(url.pathname + url.search + url.hash);
      }
      const identity = user ?? session?.user;
      const proof = session ? this.sites.proof(site) : undefined;
      try {
        this.sites.assertView(site, identity, proof);
      } catch (e) {
        if (site.access === 'authenticated') {
          const authorize = `${await this.runtime.platform()}/sites/authorize?site=${encodeURIComponent(site.slug)}&returnUrl=${encodeURIComponent(base + url.pathname + url.search)}`;
          if (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document')
            return reply.status(401).send('网站访问会话已失效');
          return reply.redirect(authorize);
        }
        return reply.status(403).type('text/html; charset=utf-8').send(this.passwordPage(site.name));
      }
      let path: string;
      try {
        path = decodeURIComponent(url.pathname).replace(/^\//, '');
      } catch {
        throw new BadRequestException('文件路径编码无效');
      }
      if (!path || path.endsWith('/')) path += 'index.html';
      if (!sitePathSchema.safeParse(path).success) return reply.status(404).send('文件不存在');
      if (!Object.hasOwn(version.manifest, path)) {
        const directoryIndex = path + '/index.html';
        if (Object.hasOwn(version.manifest, directoryIndex)) return reply.redirect(url.pathname + '/' + url.search);
        if (site.spa && !path.split('/').pop()!.includes('.')) path = 'index.html';
        else return reply.status(404).send('文件不存在');
      }
      const file = version.manifest[path];
      const content = await this.storage.get(version.storage, site.id, version.id, path);
      reply.header('x-eat-site-version', version.id).type(file.type);
      // 禁止站点注册持久化 Service Worker，避免访问策略变化后离线缓存继续提供受保护页面。
      if (req.headers['service-worker'] === 'script') return reply.status(403).send('静态站点不支持 Service Worker');
      if (file.type.startsWith('text/html')) {
        const config = Buffer.from(
          JSON.stringify({
            platform: await this.runtime.platform(),
            slug: site.slug,
            versionId: version.id,
            versionNumber: version.number,
            proof: this.sites.proof(site),
          }),
        ).toString('base64');
        const tag = `<script defer src="/__eat/embed.js" data-eat="${config}"></script>`;
        const html = content.toString('utf8');
        return reply.send(
          req.method === 'HEAD'
            ? ''
            : /<\/body\s*>/i.test(html)
              ? html.replace(/<\/body\s*>/i, tag + '</body>')
              : html + tag,
        );
      }
      return reply.send(req.method === 'HEAD' ? '' : content);
    } catch (e) {
      const status = e instanceof HttpException ? e.getStatus() : e instanceof z.ZodError ? 400 : 500;
      return reply.status(status).send({
        error: status === 500 ? 'INTERNAL_ERROR' : 'SITE_ACCESS_ERROR',
        message: status === 500 ? '网站访问失败' : (e as Error).message,
      });
    }
  }
  private cookie(reply: FastifyReply, token: string) {
    reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure`);
  }
  private async body(req: FastifyRequest) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req.raw) {
      size += c.length;
      if (size > 8192) throw new BadRequestException('请求体过大');
      chunks.push(Buffer.from(c));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new BadRequestException('请求体必须是 JSON');
    }
  }
  private passwordPage(name: string) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>验证访问密码</title></head><body style="font:16px system-ui;max-width:360px;margin:15vh auto;padding:24px"><h1>${escapeHtml(name)}</h1><p>输入网站密码后访问，发表评论需要登录 EAT。</p><form><input name="password" type="password" required autofocus placeholder="访问密码" style="padding:10px"><button style="padding:10px">进入网站</button><p role="alert"></p></form><script>document.querySelector('form').onsubmit=async function(e){e.preventDefault();var r=await fetch('/__eat/access',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:this.password.value})});if(r.ok)location.reload();else this.querySelector('p').textContent=(await r.json()).message||'密码验证失败';};</script></body></html>`;
  }
}
