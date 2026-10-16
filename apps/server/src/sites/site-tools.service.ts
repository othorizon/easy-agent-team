import { BadRequestException, Injectable } from '@nestjs/common';
import {
  createSiteSchema,
  createSiteThreadSchema,
  isSiteTool,
  publishSiteSchema,
  SITE_TOOL_SPECS,
  siteCommentBodySchema,
  siteThreadQuerySchema,
  updateSiteSchema,
} from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { SitesService } from './sites.service';
import { SiteCommentsService } from './site-comments.service';
import { z } from 'zod';

@Injectable()
export class SiteToolsService {
  constructor(
    private readonly sites: SitesService,
    private readonly comments: SiteCommentsService,
  ) {}
  async call(user: AuthUser, name: string, input: unknown) {
    if (!isSiteTool(name)) return undefined;
    try {
      const args = SITE_TOOL_SPECS[name].schema.parse(input) as Record<string, unknown>;
      const { site, accessToken, threadId, ...body } = args;
      const slug = site as string;
      const proof = accessToken as string | undefined;
      switch (name) {
        case 'list_sites':
          return this.sites.list(user);
        case 'create_site':
          return this.sites.create(user, createSiteSchema.parse(body));
        case 'update_site':
          return this.sites.update(user, slug, updateSiteSchema.parse(body));
        case 'publish_site':
          return this.sites.publish(user, slug, publishSiteSchema.parse(body));
        case 'list_site_versions':
          return this.sites.versions(user, slug, proof);
        case 'activate_site_version':
          return this.sites.activate(user, slug, body.versionId as string);
        case 'create_site_share_link':
          return this.sites.share(user, slug);
        case 'unlock_site':
          return this.sites.unlock(await this.sites.get(slug), body.password as string, undefined, user.id);
        case 'list_site_comments':
          return this.comments.list(user, slug, siteThreadQuerySchema.parse(body), proof);
        case 'create_site_comment':
          return this.comments.create(user, slug, createSiteThreadSchema.parse(body), proof);
        case 'reply_site_comment':
          return this.comments.reply(user, slug, threadId as string, siteCommentBodySchema.parse(body), proof);
        case 'set_site_thread_status':
          return this.comments.status(user, slug, threadId as string, body.status as 'open' | 'resolved', proof);
        case 'list_site_mention_users':
          return this.comments.mentionUsers(user, slug, proof);
      }
    } catch (e) {
      if (e instanceof z.ZodError)
        throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '工具参数不合法', details: e.issues });
      throw e;
    }
  }
}
