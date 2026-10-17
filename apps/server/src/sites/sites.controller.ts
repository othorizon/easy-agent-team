import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import {
  createSiteSchema,
  createSiteThreadSchema,
  publishSiteSchema,
  siteCommentBodySchema,
  siteThreadQuerySchema,
  updateSiteSchema,
  type CreateSite,
  type CreateSiteThread,
  type PublishSite,
  type SiteCommentBody,
  type UpdateSite,
} from '@eat/shared';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { RouteConfig } from '@nestjs/platform-fastify';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, Public, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { SiteCommentsService } from './site-comments.service';
import { SitesService } from './sites.service';
import { SiteRuntime } from './site-config';

import { siteProbeMarker } from './site-setup.service';

const accessBody = z.object({
  password: z.string().max(128).optional(),
  accessToken: z.string().max(4096).optional(),
});
const proofOf = (req: FastifyRequest) =>
  typeof req.headers['x-eat-site-access'] === 'string' ? req.headers['x-eat-site-access'] : undefined;

@Controller('api/sites')
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly comments: SiteCommentsService,
    private readonly auth: AuthService,
    private readonly runtime: SiteRuntime,
  ) {}

  @Public()
  @Get('verification/:operationId')
  async verification(@Param('operationId') operationId: string) {
    const row = await this.runtime.settings.row();
    if (!row || row.status !== 'verifying' || row.operationId !== operationId) throw new NotFoundException();
    return siteProbeMarker(row);
  }
  @Get('capability') capability() {
    return this.runtime.settings.capability();
  }
  @Get() list(@CurrentUser() user: AuthUser) {
    return this.sites.list(user);
  }
  @Post() create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createSiteSchema)) body: CreateSite,
  ) {
    return this.sites.create(user, body);
  }
  @Get(':slug') async detail(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.sites.info(await this.sites.get(slug), user);
  }
  @Patch(':slug') update(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateSiteSchema)) body: UpdateSite,
  ) {
    return this.sites.update(user, slug, body);
  }
  @Delete(':slug') remove(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.sites.remove(user, slug);
  }
  @Get(':slug/versions') versions(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Req() req: FastifyRequest,
  ) {
    return this.sites.versions(user, slug, proofOf(req));
  }
  @Public()
  @Get(':slug/embed-origin')
  async embedOrigin(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(z.object({ versionId: z.string().uuid(), origin: z.string().url().optional() })))
    query: { versionId: string; origin?: string },
  ) {
    const site = await this.sites.get(slug);
    const version = await this.sites.version(site, query.versionId);
    const versionOrigin = new URL(await this.runtime.url(site.slug, version.number)).origin;
    const siteOrigin = new URL(await this.runtime.url(site.slug)).origin;
    if (query.origin && query.origin !== siteOrigin && query.origin !== versionOrigin)
      throw new BadRequestException('页面来源不合法');
    return { origin: query.origin ?? versionOrigin };
  }
  @Post(':slug/releases')
  @RouteConfig({ eatSiteUpload: true })
  publish(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(publishSiteSchema)) body: PublishSite,
  ) {
    return this.sites.publish(user, slug, body);
  }
  @Post(':slug/activate') activate(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(z.object({ versionId: z.string().uuid() }))) body: { versionId: string },
  ) {
    return this.sites.activate(user, slug, body.versionId);
  }
  @Post(':slug/share') share(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.sites.share(user, slug);
  }
  @Post(':slug/authorize') authorize(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(z.object({ returnUrl: z.string().url().max(4096) })))
    body: { returnUrl: string },
  ) {
    return this.sites.ticket(user, slug, body.returnUrl);
  }

  @Public()
  @Post(':slug/access')
  async unlock(
    @Param('slug') slug: string,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(accessBody)) body: z.infer<typeof accessBody>,
  ) {
    return this.sites.unlock(await this.sites.get(slug), body.password, body.accessToken, req.ip);
  }
  @Post(':slug/comment-ticket')
  async commentTicket(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Req() req: FastifyRequest,
  ) {
    const site = await this.sites.get(slug);
    this.sites.assertView(site, user, proofOf(req));
    return { code: await this.sites.newSession(site, 'comment_ticket', user.tokenId, '', '/', 60_000) };
  }
  @Public()
  @Post(':slug/comment-session')
  async commentSession(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(z.object({ code: z.string().max(200) }))) body: { code: string },
  ) {
    const site = await this.sites.get(slug);
    const ticket = await this.sites.session(site, body.code, 'comment_ticket', undefined, true);
    if (!ticket?.user) throw new UnauthorizedException('评论登录链接已失效');
    return {
      token: await this.sites.newSession(site, 'comment', ticket.user.tokenId),
      user: { id: ticket.user.id, name: ticket.user.name, email: ticket.user.email, role: ticket.user.role },
    };
  }
  private async viewer(slug: string, req: FastifyRequest, required = false) {
    const scoped = req.headers['x-eat-comment-session'];
    if (typeof scoped === 'string') {
      const site = await this.sites.get(slug);
      const session = await this.sites.session(site, scoped, 'comment');
      if (!session?.user) throw new UnauthorizedException('评论登录已失效，请重新登录');
      return { user: session.user, proof: this.sites.proof(site) };
    }
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const user = token ? await this.auth.authenticate(token) : null;
    if ((required || token) && !user) throw new UnauthorizedException('请先登录后发表评论');
    return { user, proof: proofOf(req) };
  }
  @Public()
  @Get(':slug/threads')
  async threads(
    @Param('slug') slug: string,
    @Req() req: FastifyRequest,
    @Query(new ZodValidationPipe(siteThreadQuerySchema)) query: z.infer<typeof siteThreadQuerySchema>,
  ) {
    const viewer = await this.viewer(slug, req);
    return this.comments.list(viewer.user, slug, query, viewer.proof);
  }
  @Public()
  @Get(':slug/mention-users')
  async mentionUsers(@Param('slug') slug: string, @Req() req: FastifyRequest) {
    const viewer = await this.viewer(slug, req, true);
    return this.comments.mentionUsers(viewer.user!, slug, viewer.proof);
  }
  @Public()
  @Post(':slug/threads')
  async createThread(
    @Param('slug') slug: string,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(createSiteThreadSchema)) body: CreateSiteThread,
  ) {
    const viewer = await this.viewer(slug, req, true);
    return this.comments.create(viewer.user!, slug, body, viewer.proof);
  }
  @Public()
  @Post(':slug/threads/:id/replies')
  async reply(
    @Param('slug') slug: string,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(siteCommentBodySchema)) body: SiteCommentBody,
  ) {
    const viewer = await this.viewer(slug, req, true);
    return this.comments.reply(viewer.user!, slug, id, body, viewer.proof);
  }
  @Public()
  @Delete(':slug/comments/:id')
  async deleteComment(
    @Param('slug') slug: string,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Req() req: FastifyRequest,
  ) {
    const viewer = await this.viewer(slug, req, true);
    return this.comments.remove(viewer.user!, slug, id, viewer.proof);
  }
  @Public()
  @Patch(':slug/threads/:id')
  async status(
    @Param('slug') slug: string,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(z.object({ status: z.enum(['open', 'resolved']) })))
    body: { status: 'open' | 'resolved' },
  ) {
    const viewer = await this.viewer(slug, req, true);
    return this.comments.status(viewer.user!, slug, id, body.status, viewer.proof);
  }
}
