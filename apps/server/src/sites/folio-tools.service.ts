import { BadRequestException, Injectable } from '@nestjs/common';
import {
  createSiteSchema,
  createSiteThreadSchema,
  isFolioTool,
  publishSiteSchema,
  FOLIO_TOOL_SPECS,
  siteCommentBodySchema,
  siteThreadQuerySchema,
  updateSiteSchema,
} from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { SitesService } from './sites.service';
import { SiteCommentsService } from './site-comments.service';
import { z } from 'zod';

@Injectable()
export class FolioToolsService {
  constructor(
    private readonly sites: SitesService,
    private readonly comments: SiteCommentsService,
  ) {}
  async call(user: AuthUser, name: string, input: unknown) {
    if (!isFolioTool(name)) return undefined;
    try {
      const args = FOLIO_TOOL_SPECS[name].schema.parse(input) as Record<string, unknown>;
      const { folio, accessToken, threadId, ...body } = args;
      const slug = folio as string;
      const proof = accessToken as string | undefined;
      switch (name) {
        case 'list_folios':
          return this.sites.list(user);
        case 'create_folio':
          return this.sites.create(user, createSiteSchema.parse(body));
        case 'update_folio':
          return this.sites.update(user, slug, updateSiteSchema.parse(body));
        case 'publish_folio':
          return this.sites.publish(user, slug, publishSiteSchema.parse(body));
        case 'list_folio_versions':
          return this.sites.versions(user, slug, proof);
        case 'activate_folio_version':
          return this.sites.activate(user, slug, body.versionId as string);
        case 'create_folio_share_link':
          return this.sites.share(user, slug);
        case 'unlock_folio':
          return this.sites.unlock(await this.sites.get(slug), body.password as string, undefined, user.id);
        case 'list_folio_comments':
          return this.comments.list(user, slug, siteThreadQuerySchema.parse(body), proof);
        case 'create_folio_comment':
          return this.comments.create(user, slug, createSiteThreadSchema.parse(body), proof);
        case 'reply_folio_comment':
          return this.comments.reply(user, slug, threadId as string, siteCommentBodySchema.parse(body), proof);
        case 'delete_folio_comment':
          return this.comments.remove(user, slug, body.commentId as string, proof);
        case 'set_folio_thread_status':
          return this.comments.status(user, slug, threadId as string, body.status as 'open' | 'resolved', proof);
        case 'list_folio_mention_users':
          return this.comments.mentionUsers(user, slug, proof);
      }
    } catch (e) {
      if (e instanceof z.ZodError)
        throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '工具参数不合法', details: e.issues });
      throw e;
    }
  }
}
