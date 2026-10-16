import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, exists, inArray, isNull } from 'drizzle-orm';
import type { CreateSiteThread, SiteCommentBody, SiteThread, SiteThreadQuery } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { decryptSecret } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { helperProfiles, siteComments, siteThreads, siteVersions, users } from '../db/schema';
import { WebhookService } from '../notify/webhook.service';
import { SiteRuntime } from './site-config';
import { SitesService, type SiteRow } from './sites.service';

@Injectable()
export class SiteCommentsService {
  private readonly logger = new Logger(SiteCommentsService.name);
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sites: SitesService,
    private readonly webhook: WebhookService,
    private readonly audit: AuditService,
    private readonly runtime: SiteRuntime,
  ) {}

  async mentionUsers(user: AuthUser, slug: string, proof?: string) {
    const site = await this.sites.get(slug);
    this.sites.assertView(site, user, proof);
    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.status, 'active'))
      .orderBy(asc(users.name));
  }

  async list(
    user: AuthUser | null,
    slug: string,
    query: SiteThreadQuery = {},
    proof?: string,
  ): Promise<SiteThread[]> {
    const site = await this.sites.get(slug);
    this.sites.assertView(site, user, proof);
    const threads = await this.db
      .select({ thread: siteThreads, number: siteVersions.number })
      .from(siteThreads)
      .innerJoin(siteVersions, eq(siteThreads.versionId, siteVersions.id))
      .where(
        and(
          eq(siteThreads.siteId, site.id),
          exists(
            this.db
              .select({ id: siteComments.id })
              .from(siteComments)
              .where(and(eq(siteComments.threadId, siteThreads.id), isNull(siteComments.deletedAt))),
          ),
          query.page ? eq(siteThreads.page, query.page) : undefined,
          query.versionId ? eq(siteThreads.versionId, query.versionId) : undefined,
          query.status ? eq(siteThreads.status, query.status) : undefined,
        ),
      )
      .orderBy(desc(siteThreads.createdAt));
    if (!threads.length) return [];
    const comments = await this.db
      .select({ comment: siteComments, authorName: users.name, number: siteVersions.number })
      .from(siteComments)
      .innerJoin(users, eq(siteComments.authorId, users.id))
      .innerJoin(siteVersions, eq(siteComments.versionId, siteVersions.id))
      .where(
        inArray(
          siteComments.threadId,
          threads.map((t) => t.thread.id),
        ),
      )
      .orderBy(asc(siteComments.createdAt), asc(siteComments.id));
    return Promise.all(
      threads.map(async ({ thread: t, number }) => ({
        id: t.id,
        page: t.page,
        versionId: t.versionId,
        versionNumber: number,
        anchor: t.anchor,
        status: t.status,
        authorId: t.authorId,
        canResolve: !!user && (t.authorId === user.id || this.sites.canManage(site, user)),
        createdAt: t.createdAt.toISOString(),
        url: await this.threadUrl(site, number, t.page, t.id),
        comments: comments
          .filter((c) => c.comment.threadId === t.id)
          .map(({ comment: c, authorName, number }) => ({
            id: c.id,
            authorId: c.authorId,
            authorName,
            content: c.deletedAt ? '' : c.content,
            versionId: c.versionId,
            versionNumber: number,
            mentions: c.deletedAt ? [] : c.mentions,
            canDelete: !!user && !c.deletedAt && (c.authorId === user.id || this.sites.canManage(site, user)),
            deletedAt: c.deletedAt?.toISOString() ?? null,
            createdAt: c.createdAt.toISOString(),
          })),
      })),
    );
  }
  private async threadUrl(site: SiteRow, version: number, page: string, threadId: string) {
    const url = new URL(page, await this.runtime.url(site.slug, version));
    url.searchParams.set('eat_thread', threadId);
    return url.href;
  }
  private async mentions(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return unique;
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, unique), eq(users.status, 'active')));
    if (rows.length !== unique.length) throw new BadRequestException('被 @ 的用户不存在或已停用');
    return unique;
  }
  async create(user: AuthUser, slug: string, dto: CreateSiteThread, proof?: string) {
    const site = await this.sites.get(slug);
    this.sites.assertView(site, user, proof);
    const version = await this.sites.version(site, dto.versionId);
    const mentions = await this.mentions(dto.mentions);
    const { thread, comment } = await this.db.transaction(async (tx) => {
      const [thread] = await tx
        .insert(siteThreads)
        .values({
          siteId: site.id,
          versionId: version.id,
          page: dto.page,
          anchor: dto.anchor,
          authorId: user.id,
        })
        .returning();
      const [comment] = await tx
        .insert(siteComments)
        .values({
          threadId: thread.id,
          versionId: version.id,
          authorId: user.id,
          content: dto.content,
          mentions,
        })
        .returning();
      return { thread, comment };
    });
    await this.audit.record({
      actorId: user.id,
      action: 'site.comment.created',
      targetType: 'site_thread',
      targetId: thread.id,
      meta: { siteId: site.id, versionId: version.id },
    });
    this.notify(site, user, thread.id, comment.id, version.number, mentions);
    return (await this.list(user, slug, { page: dto.page }, proof)).find((t) => t.id === thread.id)!;
  }
  async reply(user: AuthUser, slug: string, threadId: string, dto: SiteCommentBody, proof?: string) {
    const site = await this.sites.get(slug);
    this.sites.assertView(site, user, proof);
    const thread = await this.thread(site, threadId);
    const version = await this.sites.version(site, dto.versionId);
    const mentions = await this.mentions(dto.mentions);
    const [comment] = await this.db
      .insert(siteComments)
      .values({ threadId, versionId: version.id, authorId: user.id, content: dto.content, mentions })
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: 'site.comment.replied',
      targetType: 'site_thread',
      targetId: thread.id,
      meta: { versionId: version.id },
    });
    this.notify(site, user, threadId, comment.id, version.number, mentions);
    return (await this.list(user, slug, { page: thread.page }, proof)).find((t) => t.id === threadId)!;
  }
  async remove(user: AuthUser, slug: string, commentId: string, proof?: string) {
    const site = await this.sites.get(slug);
    this.sites.assertView(site, user, proof);
    const [comment] = await this.db
      .select({
        id: siteComments.id,
        threadId: siteComments.threadId,
        authorId: siteComments.authorId,
        deletedAt: siteComments.deletedAt,
      })
      .from(siteComments)
      .innerJoin(siteThreads, eq(siteComments.threadId, siteThreads.id))
      .where(and(eq(siteThreads.siteId, site.id), eq(siteComments.id, commentId)))
      .limit(1);
    if (!comment || comment.deletedAt) throw new NotFoundException('评论不存在或已删除');
    if (comment.authorId !== user.id && !this.sites.canManage(site, user))
      throw new ForbiddenException('仅评论作者、Folio 所有者或管理员可以删除评论');
    // 清除正文与提及，只保留占位和回复关系；并发删除仅有一次成功。
    const deleted = await this.db
      .update(siteComments)
      .set({ content: '', mentions: [], deletedAt: new Date() })
      .where(and(eq(siteComments.id, commentId), isNull(siteComments.deletedAt)))
      .returning({ id: siteComments.id });
    if (!deleted.length) throw new NotFoundException('评论不存在或已删除');
    await this.audit.record({
      actorId: user.id,
      action: 'site.comment.deleted',
      targetType: 'site_comment',
      targetId: commentId,
      meta: { siteId: site.id, threadId: comment.threadId },
    });
    return { ok: true };
  }
  private async thread(site: SiteRow, id: string) {
    const [thread] = await this.db
      .select()
      .from(siteThreads)
      .where(and(eq(siteThreads.id, id), eq(siteThreads.siteId, site.id)))
      .limit(1);
    if (!thread) throw new NotFoundException('讨论不存在');
    return thread;
  }
  async status(user: AuthUser, slug: string, id: string, status: 'open' | 'resolved', proof?: string) {
    const site = await this.sites.get(slug);
    this.sites.assertView(site, user, proof);
    const thread = await this.thread(site, id);
    if (!this.sites.canManage(site, user) && thread.authorId !== user.id)
      throw new ForbiddenException('仅讨论发起人、Folio 所有者或管理员可以变更状态');
    await this.db.update(siteThreads).set({ status }).where(eq(siteThreads.id, id));
    await this.audit.record({
      actorId: user.id,
      action: 'site.thread.status',
      targetType: 'site_thread',
      targetId: id,
      meta: { status },
    });
    return { ok: true };
  }
  private notify(
    site: SiteRow,
    author: AuthUser,
    threadId: string,
    commentId: string,
    version: number,
    mentions: string[],
  ) {
    // 每条不可变评论只产生一次提及事件。复用已有个人飞书配置与投递重试，不向 webhook 泄露访问凭据或正文。
    void (async () => {
      for (const userId of mentions) {
        if (userId === author.id) continue;
        const [profile] = await this.db
          .select()
          .from(helperProfiles)
          .where(eq(helperProfiles.userId, userId))
          .limit(1);
        if (!profile?.webhookUrl) continue;
        const url = `${await this.runtime.platform()}/folios/${site.slug}?thread=${threadId}`;
        const card = {
          header: {
            title: { tag: 'plain_text', content: `${author.name} 在 Folio 评论中 @ 了你` },
            template: 'blue',
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'plain_text',
                content: `${site.name} · 评论浏览版本 v${version}\n登录 EAT 并通过 Folio 访问验证后查看讨论。`,
              },
            },
            {
              tag: 'action',
              actions: [
                { tag: 'button', text: { tag: 'plain_text', content: '查看讨论' }, type: 'primary', url },
              ],
            },
          ],
        };
        this.webhook.notify(
          'site.comment.mentioned',
          profile.webhookUrl,
          profile.webhookSecretEncrypted ? decryptSecret(profile.webhookSecretEncrypted) : null,
          card,
          `comment=${commentId}; recipient=${userId}`,
        );
      }
    })().catch(() => this.logger.warn('评论提及通知创建失败'));
  }
}
