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
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  SITE_MAX_BYTES,
  prepareSiteUploadSchema, siteContentType,
  type PrepareSiteUpload, type SiteManifestFile, type SiteUploadStatus,
  type CreateSite,
  type PublishSite,
  type SiteInfo,
  type SiteVersion,
  type UpdateSite,
} from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { apiTokens, auditLogs, sites, siteVersions, siteSessions, siteThreads, users, siteSettings, siteUploads, siteBlobs, siteCleanups } from '../db/schema';
import { sha256Hex } from '../common/crypto';
import { loadConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { parseSiteHost, SiteRuntime } from './site-config';
import { SiteStorage } from './site-storage.service';

export type SiteRow = typeof sites.$inferSelect;
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
  async remove(user: AuthUser, slug: string) {
    const site = await this.get(slug);
    this.manage(site, user);
    const pending = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(sites).where(eq(sites.id, site.id)).for('update');
      if (!locked) throw new NotFoundException('Folio 不存在');
      this.manage(locked, user);
      const uploads = await tx.select().from(siteUploads).where(eq(siteUploads.siteId, site.id)).for('update');
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(siteVersions).where(eq(siteVersions.siteId, site.id));
      const until = Math.max(Date.now(), ...uploads.flatMap((u) => [u.signedUntil?.getTime() ?? 0, u.leaseUntil?.getTime() ?? 0]));
      await tx.insert(siteCleanups).values({ siteId: site.id, notBefore: new Date(until + 60_000) });
      await tx.delete(siteThreads).where(eq(siteThreads.siteId, site.id));
      await tx.delete(sites).where(eq(sites.id, site.id));
      await tx.insert(auditLogs).values({ actorId: user.id, action: 'site.deleted', targetType: 'site', targetId: site.id,
        meta: { slug, versionCount: count } });
      return until > Date.now();
    });
    let cleanupFailed = false;
    try { await this.storage.discardSite(site.id); }
    catch {
      cleanupFailed = true;
      await this.audit.record({ actorId: user.id, action: 'site.storage_cleanup_failed', targetType: 'site', targetId: site.id,
        meta: { slug } }).catch(() => undefined);
      this.logger.warn(`Folio 文件清理失败：site=${site.id}`);
    }
    return { ok: true, cleanupFailed, ...(pending ? { cleanupPending: true } : {}) };
  }
  private cleanupTimer?: ReturnType<typeof setInterval>;
  onModuleInit() {
    this.cleanupTimer = setInterval(() => void this.cleanupDeletedSites().catch(() => undefined), 60_000);
    this.cleanupTimer.unref();
    void this.cleanupDeletedSites().catch(() => undefined);
  }
  onModuleDestroy() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }
  async cleanupDeletedSites() {
    const rows = await this.db.select().from(siteCleanups).where(sql`${siteCleanups.notBefore} <= now()`).limit(50);
    for (const row of rows) {
      let delay = 3600_000;
      try { await this.storage.discardSite(row.siteId); }
      catch { delay = 300_000; this.logger.warn(`Folio 残留文件清理失败：site=${row.siteId}`); }
      // Retain tombstones: even an arbitrarily delayed old process's late writes get another sweep.
      await this.db.update(siteCleanups).set({ notBefore: new Date(Date.now() + delay) })
        .where(eq(siteCleanups.siteId, row.siteId));
    }
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
  private async uploadActor(user: AuthUser, slug: string) {
    const site = await this.get(slug);
    this.manage(site, user);
    return site;
  }
  private async uploadRow(user: AuthUser, site: SiteRow, id: string) {
    const [row] = await this.db.select().from(siteUploads)
      .where(and(eq(siteUploads.id, id), eq(siteUploads.siteId, site.id))).limit(1);
    if (!row || row.publisherId !== user.id) throw new NotFoundException('上传会话不存在');
    return row;
  }
  private async missingBlobs(siteId: string, files: SiteManifestFile[]) {
    const unique = [...new Map(files.map((f) => [f.hash, { hash: f.hash, size: f.size }])).values()];
    const known = new Map((await this.db.select().from(siteBlobs)
      .where(and(eq(siteBlobs.siteId, siteId), inArray(siteBlobs.hash, unique.map((f) => f.hash)))))
      .map((b) => [b.hash, b.size]));
    const missing: typeof unique = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, unique.length) }, async () => {
      while (cursor < unique.length) {
        const file = unique[cursor++];
        if (known.get(file.hash) !== file.size || !(await this.storage.hasBlob(siteId, file.hash, file.size)))
          missing.push(file);
      }
    }));
    return missing.sort((a, b) => a.hash.localeCompare(b.hash));
  }
  private async uploadStatus(site: SiteRow, row: typeof siteUploads.$inferSelect, sign: boolean): Promise<SiteUploadStatus> {
    const expired = row.expiresAt.getTime() <= Date.now();
    const missing = row.state === 'completed' ? [] : await this.missingBlobs(site.id, row.files);
    const uploads: SiteUploadStatus['uploads'] = [];
    if (sign && missing.length > 0 && !expired && row.state !== 'completed') {
      const seconds = Math.min(600, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000));
      if (seconds < 1) throw new BadRequestException('上传会话已过期，请重新准备发布');
      // Persist BEFORE issuing any URL. Deletion must account for every possibly outstanding signature.
      const expiresAt = new Date(Date.now() + seconds * 1000);
      const [live] = await this.db.update(siteUploads).set({ signedUntil: expiresAt })
        .where(eq(siteUploads.id, row.id)).returning({ id: siteUploads.id });
      if (!live) throw new NotFoundException('Folio 已删除');
      for (const file of missing) uploads.push({ ...file, ...(await this.storage.signUpload(site.id, row.id, file.hash, seconds)),
        expiresAt: expiresAt.toISOString() });
    }
    return { id: row.id, state: row.state === 'completed' ? 'completed' : expired ? 'expired' : row.state,
      expiresAt: row.expiresAt.toISOString(), files: row.files, missing, uploads, result: row.result };
  }
  async prepareUpload(user: AuthUser, slug: string, input: PrepareSiteUpload, sign = true) {
    const parsed = prepareSiteUploadSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '发布清单不合法', details: parsed.error.issues });
    const dto = parsed.data;
    dto.files.sort((a, b) => a.path.localeCompare(b.path));
    const site = await this.uploadActor(user, slug);
    await this.db.insert(siteUploads).values({ id: randomUUID(), siteId: site.id, publisherId: user.id,
      requestId: dto.requestId, files: dto.files, message: dto.message, expiresAt: new Date(Date.now() + 24 * 3600_000) })
      .onConflictDoNothing({ target: [siteUploads.siteId, siteUploads.requestId] });
    const [row] = await this.db.select().from(siteUploads)
      .where(and(eq(siteUploads.siteId, site.id), eq(siteUploads.requestId, dto.requestId)));
    if (!row || row.publisherId !== user.id || JSON.stringify(row.files.map((f) => [f.path, f.hash, f.size, f.type])) !== JSON.stringify(dto.files.map((f) => [f.path, f.hash, f.size, f.type])) || row.message !== dto.message)
      throw new ConflictException('requestId 已用于不同发布，请使用新的 requestId');
    return this.uploadStatus(site, row, sign);
  }
  async getUpload(user: AuthUser, slug: string, id: string, renew = false) {
    const site = await this.uploadActor(user, slug);
    const row = await this.uploadRow(user, site, id);
    return this.uploadStatus(site, row, renew);
  }
  async completeUpload(user: AuthUser, slug: string, id: string): Promise<SiteVersion> {
    const site = await this.uploadActor(user, slug);
    const existing = await this.uploadRow(user, site, id);
    if (existing.result) return existing.result;
    if (existing.expiresAt.getTime() <= Date.now()) throw new BadRequestException('上传会话已过期，请重新准备发布');
    const lease = randomUUID();
    const [claimed] = await this.db.update(siteUploads).set({ state: 'verifying', lease, leaseUntil: new Date(Date.now() + 600_000) })
      .where(and(eq(siteUploads.id, id), sql`${siteUploads.state} <> 'completed'`,
        or(isNull(siteUploads.leaseUntil), sql`${siteUploads.leaseUntil} < now()`))).returning();
    if (!claimed) {
      const row = await this.uploadRow(user, site, id);
      if (row.result) return row.result;
      throw new ConflictException({ error: 'UPLOAD_BUSY', message: '上传会话正在验证，请查询状态后重试完成' });
    }
    try {
      for (const file of await this.missingBlobs(site.id, claimed.files)) {
        await this.storage.verifyAndSeal(site.id, id, file);
        // Outside the publication transaction. Orphaned sealed blobs are deliberately retained.
        await this.db.insert(siteBlobs).values({ siteId: site.id, hash: file.hash, size: file.size })
          .onConflictDoNothing({ target: [siteBlobs.siteId, siteBlobs.hash] }).catch(async (e) => {
            const [live] = await this.db.select({ id: sites.id }).from(sites).where(eq(sites.id, site.id));
            if (!live) throw new NotFoundException('Folio 已删除，本次发布未生效');
            throw e;
          });
        const [alive] = await this.db.update(siteUploads).set({ leaseUntil: new Date(Date.now() + 600_000) })
          .where(and(eq(siteUploads.id, id), eq(siteUploads.lease, lease))).returning({ id: siteUploads.id });
        if (!alive) throw new NotFoundException('上传会话已失效');
      }
      // All external I/O is finished. Only short DB locks below.
      return await this.db.transaction(async (tx) => {
        const [capability] = await tx.select().from(siteSettings).where(eq(siteSettings.id, 1)).for('share');
        if (capability?.status !== 'enabled') throw new ServiceUnavailableException('Folio 已停用，本次发布未生效');
        const [locked] = await tx.select().from(sites).where(eq(sites.id, site.id)).for('update');
        if (!locked) throw new NotFoundException('Folio 已删除，本次发布未生效');
        // Refresh long-running request identity and token; role/ownership can change during OSS I/O.
        const [actor] = await tx.select({ id: users.id, role: users.role }).from(users)
          .innerJoin(apiTokens, eq(apiTokens.userId, users.id))
          .where(and(eq(users.id, user.id), eq(users.status, 'active'), eq(apiTokens.id, user.tokenId),
            isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())))).for('share');
        if (!actor || (locked.ownerId !== actor.id && actor.role !== 'admin')) throw new ForbiddenException('发布权限已失效');
        const [session] = await tx.select().from(siteUploads).where(eq(siteUploads.id, id)).for('update');
        if (session?.result) return session.result;
        if (!session || session.lease !== lease || session.expiresAt.getTime() <= Date.now())
          throw new ConflictException('上传会话已失效，请重新查询');
        const versionId = randomUUID();
        const [version] = await tx.insert(siteVersions).values({ id: versionId, siteId: site.id,
          number: locked.nextVersion, publisherId: user.id, message: session.message, storage: 'oss', layout: 'blobs-v1',
          fileCount: session.files.length, totalBytes: session.files.reduce((sum, f) => sum + f.size, 0),
          manifest: Object.fromEntries(session.files.map(({ path, ...file }) => [path, file])) }).returning();
        const result = await this.versionInfo(locked, version);
        await tx.update(sites).set({ currentVersionId: versionId, nextVersion: locked.nextVersion + 1, updatedAt: new Date() })
          .where(eq(sites.id, site.id));
        await tx.update(siteUploads).set({ state: 'completed', result, lease: null, leaseUntil: null }).where(eq(siteUploads.id, id));
        await tx.insert(auditLogs).values({ actorId: user.id, action: 'site.published', targetType: 'site', targetId: site.id,
          meta: { versionId, number: version.number, totalBytes: version.totalBytes, uploadId: id } });
        return result;
      });
    } catch (e) {
      // Fencing prevents an old worker from releasing a newer worker's lease or changing its result.
      await this.db.update(siteUploads).set({ state: 'uploading', lease: null, leaseUntil: null })
        .where(and(eq(siteUploads.id, id), eq(siteUploads.lease, lease))).catch(() => undefined);
      throw e;
    }
  }
  /** Small MCP inline input adapter. CLI/Web always use binary direct upload. */
  async publish(user: AuthUser, slug: string, dto: PublishSite) {
    await this.uploadActor(user, slug);
    let total = 0;
    const bytes = dto.files.map((file) => {
      if (file.encoding === 'base64' && (file.content.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/.test(file.content))) throw new BadRequestException(`Base64 内容无效：${file.path}`);
      const content = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
      // Linear scan + canonical round-trip: no repeated-group regex and no permissive Buffer decoding.
      if (file.encoding === 'base64' && content.toString('base64') !== file.content)
        throw new BadRequestException(`Base64 内容无效：${file.path}`);
      total += content.length;
      if (total > SITE_MAX_BYTES) throw new BadRequestException('整版内容不得超过 50 MiB');
      return { path: file.path, content, hash: createHash('sha256').update(content).digest('hex'), size: content.length,
        type: siteContentType(file.path) };
    });
    const session = await this.prepareUpload(user, slug, { requestId: randomUUID(), message: dto.message,
      files: bytes.map(({ content: _, ...f }) => f) }, false);
    const site = await this.get(slug);
    for (const file of session.missing) await this.storage.putStaging(site.id, session.id, file.hash,
      bytes.find((f) => f.hash === file.hash)!.content);
    return this.completeUpload(user, slug, session.id);
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
