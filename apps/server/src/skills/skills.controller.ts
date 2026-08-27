import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  pushSkillSchema,
  updateSkillSchema,
  type PushSkillRequest,
  type UpdateSkillRequest,
} from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { SkillsService } from './skills.service';

@Controller('api/skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.skills.list(user);
  }

  /** eat sync 的落地内容（注意声明顺序需在 :slug 之前） */
  @Get('sync-bundle')
  syncBundle(@CurrentUser() user: AuthUser) {
    return this.skills.syncBundle(user);
  }

  @Post('push')
  push(@Body(new ZodValidationPipe(pushSkillSchema)) body: PushSkillRequest, @CurrentUser() user: AuthUser) {
    return this.skills.push(user, body);
  }

  @Get(':slug')
  detail(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.skills.detail(user, slug);
  }

  @Get(':slug/versions')
  versions(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.skills.versions(user, slug);
  }

  @Patch(':slug')
  update(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateSkillSchema)) body: UpdateSkillRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.skills.updateMeta(user, slug, body);
  }

  @Delete(':slug')
  remove(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.skills.remove(user, slug);
  }

  @Post(':slug/subscribe')
  subscribe(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.skills.subscribe(user, slug);
  }

  @Delete(':slug/subscribe')
  unsubscribe(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.skills.unsubscribe(user, slug);
  }
}
