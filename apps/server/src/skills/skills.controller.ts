import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  addSkillBundleExemptionSchema,
  addSkillSubscriberSchema,
  pushSkillSchema,
  skillListQuerySchema,
  updateSkillContentSchema,
  updateSkillSchema,
  type AddSkillBundleExemptionRequest,
  type AddSkillSubscriberRequest,
  type PushSkillRequest,
  type SkillListQuery,
  type UpdateSkillContentRequest,
  type UpdateSkillRequest,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { SkillsService } from './skills.service';

@Controller('api/skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  /** 清单：分页 + 关键词 / 范围 / 类型筛选（决策 37） */
  @Get()
  list(@Query(new ZodValidationPipe(skillListQuerySchema)) query: SkillListQuery, @CurrentUser() user: AuthUser) {
    return this.skills.list(user, query);
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

  /** 控制台在线编辑 SKILL.md：保存即新版本（决策 42） */
  @Put(':slug/content')
  updateContent(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateSkillContentSchema)) body: UpdateSkillContentRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.skills.updateContent(user, slug, body);
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

  /** 订阅者明细与代订阅：低频管理操作，仅管理员（决策 37） */
  @Get(':slug/subscribers')
  @Roles('admin')
  subscribers(@Param('slug') slug: string) {
    return this.skills.subscribers(slug);
  }

  @Post(':slug/subscribers')
  @Roles('admin')
  addSubscriber(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(addSkillSubscriberSchema)) body: AddSkillSubscriberRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.skills.addSubscriber(user, slug, body.userId);
  }

  @Delete(':slug/subscribers/:userId')
  @Roles('admin')
  removeSubscriber(
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.skills.removeSubscriber(user, slug, userId);
  }

  /** 捆绑豁免（决策 45）：为个别成员解除 / 恢复捆绑，仅管理员 */
  @Get(':slug/bundle-exemptions')
  @Roles('admin')
  bundleExemptions(@Param('slug') slug: string) {
    return this.skills.bundleExemptions(slug);
  }

  @Post(':slug/bundle-exemptions')
  @Roles('admin')
  addBundleExemption(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(addSkillBundleExemptionSchema)) body: AddSkillBundleExemptionRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.skills.addBundleExemption(user, slug, body.userId);
  }

  @Delete(':slug/bundle-exemptions/:userId')
  @Roles('admin')
  removeBundleExemption(
    @Param('slug') slug: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.skills.removeBundleExemption(user, slug, userId);
  }
}
