import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import {
  SITE_MAX_BYTES,
  type CreateSite,
  type PublishSite,
  type SiteInfo,
  type SiteVersion,
  type UpdateSite,
} from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { apiTokens, sites, siteVersions, siteSessions, users, siteSettings } from '../db/schema';
import { sha256Hex } from '../common/crypto';
import { loadConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { parseSiteHost, SiteRuntime } from './site-config';
import { SiteStorage } from './site-storage.service';

export type SiteRow = typeof sites.$inferSelect;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

@Injectable()
export class SitesService {
  private readonly logger = new Logger(SitesService.name);
  private readonly unlockAttempts = new Map<string, { count: number; expires: number }>();
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: SiteStorage,
    private readonly audit: AuditService,
    private readonly runtime: SiteRuntime,
  ) {}

  async get(slug: string): Promise<SiteRow> {
    await this.runtime.settings.enabled();
    const [site] = await this.db.select().from(sites).where(eq(sites.slug, slug)).limit(1);
    if (!site) throw new NotFoundException('Folio 不存在');
    return site;
  }
  canManage(site: SiteRow, user?: AuthUser | null) {
    return !!user && (site.ownerId === user.id || user.role === 'admin');
  }
  manage(site: SiteRow, user: AuthUser) {
    if (!this.canManage(site, user)) throw new ForbiddenException('仅 Folio 所有者或管理员可以操作');
  }
  async info(site: SiteRow, user: AuthUser): Promise<SiteInfo> {
    return {
      id: site.id,
      slug: site.slug,
      name: site.name,
      description: site.description,
      ownerId: site.ownerId,
      access: site.access,
      spa: site.spa,
      currentVersionId: site.currentVersionId,
      url: await this.runtime.url(site.slug),
      canManage: this.canManage(site, user),
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    };
  }
  async list(user: AuthUser) {
    await this.runtime.settings.enabled();
    return Promise.all(
      (await this.db.select().from(sites).orderBy(desc(sites.updatedAt))).map((s) => this.info(s, user)),
    );
  }
  async create(user: AuthUser, dto: CreateSite) {
    await this.runtime.settings.enabled();
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 10) : null;
    try {
      const [site] = await this.db
        .insert(sites)
        .values({
          slug: dto.slug,
          name: dto.name,
          description: dto.description,
          ownerId: user.id,
          access: dto.access,
          passwordHash,
          spa: dto.spa,
        })
        .returning();
      await this.audit.record({ actorId: user.id, action: 'site.created', targetType: 'site', targetId: site.id });
      return this.info(site, user);
    } catch (e) {
      if (
        (e as { cause?: { code?: string }; code?: string }).cause?.code === '23505' ||
        (e as { code?: string }).code === '23505'
      )
        throw new ConflictException('Folio slug 已被使用');
      throw e;
    }
  }
  async update(user: AuthUser, slug: string, dto: UpdateSite) {
    const site = await this.get(slug);
    this.manage(site, user);
    if (dto.access === 'password' && !dto.password && !site.passwordHash)
      throw new BadRequestException('请设置 Folio 密码');
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, 10) : undefined;
    const [row] = await this.db
      .update(sites)
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.spa !== undefined ? { spa: dto.spa } : {}),
        ...(dto.access !== undefined ? { access: dto.access } : {}),
        ...(passwordHash ? { passwordHash } : {}),
        ...((dto.access !== undefined && dto.access !== site.access) || passwordHash
          ? { accessRevision: sql`${sites.accessRevision} + 1` }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(sites.id, site.id))
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: 'site.updated',
      targetType: 'site',
      targetId: site.id,
      meta: { access: row.access, passwordChanged: !!passwordHash },
    });
    return this.info(row, user);
  }
  async versionInfo(site: SiteRow, row: typeof siteVersions.$inferSelect): Promise<SiteVersion> {
    return {
      id: row.id,
      number: row.number,
      message: row.message,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      publisherId: row.publisherId,
      createdAt: row.createdAt.toISOString(),
      url: await this.runtime.url(site.slug, row.number),
    };
  }
  async versions(user: AuthUser, slug: string, proof?: string) {
    const site = await this.get(slug);
    this.assertView(site, user, proof);
    return Promise.all(
      (
        await this.db
          .select()
          .from(siteVersions)
          .where(eq(siteVersions.siteId, site.id))
          .orderBy(desc(siteVersions.number))
      ).map((v) => this.versionInfo(site, v)),
    );
  }
  async version(site: SiteRow, id?: string, number?: number) {
    const versionId = id ?? site.currentVersionId;
    if (number === undefined && !versionId) throw new NotFoundException('Folio 尚未发布');
    const [row] = await this.db
      .select()
      .from(siteVersions)
      .where(
        and(
          eq(siteVersions.siteId, site.id),
          number === undefined ? eq(siteVersions.id, versionId!) : eq(siteVersions.number, number),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('发布版本不存在');
    return row;
  }
  async publish(user: AuthUser, slug: string, dto: PublishSite) {
    const site = await this.get(slug);
    this.manage(site, user);
    const paths = new Set<string>();
    let totalBytes = 0;
    const files = dto.files.map((f) => {
      if (paths.has(f.path)) throw new BadRequestException(`重复文件路径：${f.path}`);
      paths.add(f.path);
      if (
        f.encoding === 'base64' &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content)
      )
        throw new BadRequestException(`Base64 内容无效：${f.path}`);
      const content = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
      totalBytes += content.length;
      if (totalBytes > SITE_MAX_BYTES) throw new BadRequestException('单次发布不得超过 50 MiB');
      return { path: f.path, content, type: MIME[extname(f.path).toLowerCase()] ?? 'application/octet-stream' };
    });
    if (!paths.has('index.html')) throw new BadRequestException('发布目录根目录必须包含 index.html');
    for (const path of paths) {
      const parts = path.split('/');
      while (parts.length > 1) {
        parts.pop();
        if (paths.has(parts.join('/'))) throw new BadRequestException('文件与目录路径冲突');
      }
    }
    const id = randomUUID();
    const storage = this.storage.kind();
    try {
      // 先完整写入不可变快照，再在事务内分配版本号并激活；失败不改变线上版本。
      for (const f of files) await this.storage.put(site.id, id, f.path, f.content, f.type);
      const row = await this.db.transaction(async (tx) => {
        const [capability] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for('share');
        if (capability?.status !== 'enabled') throw new ServiceUnavailableException('Folio 已停用，本次发布未生效');
        const [locked] = await tx.select().from(sites).where(eq(sites.id, site.id)).for('update');
        const [v] = await tx
          .insert(siteVersions)
          .values({
            id,
            siteId: site.id,
            number: locked.nextVersion,
            message: dto.message,
            publisherId: user.id,
            fileCount: files.length,
            totalBytes,
            storage,
            manifest: Object.fromEntries(files.map((f) => [f.path, { size: f.content.length, type: f.type }])),
          })
          .returning();
        await tx
          .update(sites)
          .set({ currentVersionId: id, nextVersion: locked.nextVersion + 1, updatedAt: new Date() })
          .where(eq(sites.id, site.id));
        return v;
      });
      await this.audit.record({
        actorId: user.id,
        action: 'site.published',
        targetType: 'site',
        targetId: site.id,
        meta: { versionId: id, number: row.number, totalBytes },
      });
      return this.versionInfo(site, row);
    } catch (e) {
      // DB 成功后的审计异常不能删除已经生效的产物。
      const [committed] = await this.db
        .select({ id: siteVersions.id })
        .from(siteVersions)
        .where(eq(siteVersions.id, id))
        .limit(1);
      if (!committed)
        await this.storage
          .discard(
            storage,
            site.id,
            id,
            files.map((f) => f.path),
          )
          .catch(() => this.logger.warn('未完成版本清理失败'));
      throw e;
    }
  }
  async activate(user: AuthUser, slug: string, id: string) {
    const site = await this.get(slug);
    this.manage(site, user);
    await this.version(site, id);
    await this.db.update(sites).set({ currentVersionId: id, updatedAt: new Date() }).where(eq(sites.id, site.id));
    await this.audit.record({
      actorId: user.id,
      action: 'site.activated',
      targetType: 'site',
      targetId: site.id,
      meta: { versionId: id },
    });
    return this.info(await this.get(slug), user);
  }

  private sign(data: object) {
    const body = Buffer.from(JSON.stringify(data)).toString('base64url');
    return `${body}.${createHmac('sha256', loadConfig().kek).update(`eat-sites:${body}`).digest('base64url')}`;
  }
  private verify(value: string): Record<string, unknown> | null {
    if (value.length > 4096) return null;
    const [body, signature, extra] = value.split('.');
    if (!body || !signature || extra) return null;
    const actual = Buffer.from(signature);
    const expected = Buffer.from(
      createHmac('sha256', loadConfig().kek).update(`eat-sites:${body}`).digest('base64url'),
    );
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }
  proof(site: SiteRow, purpose: 'share' | 'view' = 'view') {
    return this.sign({
      siteId: site.id,
      revision: site.accessRevision,
      purpose,
      exp: Date.now() + (purpose === 'share' ? 90 : 1) * 24 * 3600_000,
      nonce: randomBytes(12).toString('hex'),
    });
  }
  validProof(site: SiteRow, value?: string) {
    const data = value ? this.verify(value) : null;
    return (
      !!data &&
      data.siteId === site.id &&
      data.revision === site.accessRevision &&
      (data.purpose === 'share' || data.purpose === 'view')
    );
  }
  assertView(site: SiteRow, user?: AuthUser | null, proof?: string) {
    if (this.canManage(site, user) || site.access === 'public') return;
    if (site.access === 'authenticated') {
      if (user) return;
      throw new UnauthorizedException('请先登录 EAT');
    }
    if (this.validProof(site, proof)) return;
    throw new ForbiddenException({ error: 'SITE_PASSWORD_REQUIRED', message: '请先验证 Folio 访问密码' });
  }
  async unlock(site: SiteRow, password?: string, accessToken?: string, actor = 'anonymous') {
    if (site.access !== 'password') throw new BadRequestException('Folio 当前不使用密码访问');
    if (this.validProof(site, accessToken)) return { accessToken: this.proof(site) };
    const key = `${site.id}:${actor}`;
    const now = Date.now();
    const attempt = this.unlockAttempts.get(key);
    if (attempt && attempt.expires > now) {
      if (++attempt.count > 15) throw new HttpException('尝试过于频繁，请稍后重试', 429);
    } else {
      if (this.unlockAttempts.size > 10000) this.unlockAttempts.clear();
      this.unlockAttempts.set(key, { count: 1, expires: now + 5 * 60_000 });
    }
    if (!(site.passwordHash && password && (await bcrypt.compare(password, site.passwordHash))))
      throw new ForbiddenException('Folio 密码或分享链接无效');
    this.unlockAttempts.delete(key);
    return { accessToken: this.proof(site) };
  }
  async share(user: AuthUser, slug: string) {
    const site = await this.get(slug);
    this.manage(site, user);
    if (site.access !== 'password') throw new BadRequestException('仅密码访问的 Folio 需要免输密码链接');
    return {
      url: `${await this.runtime.url(slug)}/?eat_access=${encodeURIComponent(this.proof(site, 'share'))}`,
      expiresInDays: 90,
    };
  }
  async ticket(user: AuthUser, slug: string, returnUrl: string) {
    const site = await this.get(slug);
    this.assertView(site, user);
    const target = new URL(returnUrl);
    const parsed = parseSiteHost(target.host, (await this.runtime.config()).domain);
    if (
      !parsed ||
      parsed.slug !== slug ||
      target.protocol !== `${(await this.runtime.config()).protocol}:` ||
      target.username ||
      target.password ||
      target.pathname.startsWith('//')
    )
      throw new BadRequestException('Folio 跳转地址不合法');
    const code = await this.newSession(
      site,
      'ticket',
      user.tokenId,
      target.host,
      target.pathname + target.search + target.hash,
      60_000,
    );
    return { url: `${target.origin}/__eat/login?code=${code}` };
  }
  async newSession(
    site: SiteRow,
    purpose: typeof siteSessions.$inferInsert.purpose,
    tokenId: string | null,
    host = '',
    returnPath = '/',
    ttl = 12 * 3600_000,
  ) {
    const token = randomBytes(32).toString('base64url');
    await this.db.insert(siteSessions).values({
      siteId: site.id,
      purpose,
      tokenHash: sha256Hex(token),
      tokenId,
      host,
      returnPath,
      revision: site.accessRevision,
      expiresAt: new Date(Date.now() + ttl),
    });
    // 顺带清理到期会话，不额外部署 worker。
    void this.db
      .delete(siteSessions)
      .where(sql`${siteSessions.expiresAt} < now()`)
      .catch(() => undefined);
    return token;
  }
  async session(
    site: SiteRow,
    token: string | undefined,
    purpose: typeof siteSessions.$inferInsert.purpose,
    host?: string,
    consume = false,
  ) {
    if (!token) return null;
    const where = and(
      eq(siteSessions.siteId, site.id),
      eq(siteSessions.tokenHash, sha256Hex(token)),
      eq(siteSessions.purpose, purpose),
      eq(siteSessions.revision, site.accessRevision),
      gt(siteSessions.expiresAt, new Date()),
      host === undefined ? undefined : eq(siteSessions.host, host),
    );
    const [row] = consume
      ? await this.db.delete(siteSessions).where(where).returning()
      : await this.db.select().from(siteSessions).where(where).limit(1);
    if (!row) return null;
    if (!row.tokenId) return { row, user: null };
    const [user] = await this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, tokenId: apiTokens.id })
      .from(apiTokens)
      .innerJoin(users, eq(apiTokens.userId, users.id))
      .where(
        and(
          eq(apiTokens.id, row.tokenId),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);
    return user ? { row, user } : null;
  }
}
