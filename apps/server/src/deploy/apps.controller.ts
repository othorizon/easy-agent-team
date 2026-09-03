import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createAppSchema,
  mountAppSchema,
  updateAppEnvSchema,
  updateAppSchema,
  type CreateAppRequest,
  type MountAppRequest,
  type UpdateAppEnvRequest,
  type UpdateAppRequest,
} from '@eat/shared';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AppsService } from './apps.service';
import { DokploySettingsService } from './dokploy-settings.service';

const addMemberSchema = z.object({ userId: z.string() });

/** 应用（决策 31）：自助创建 / 管理员挂载 / 配置与成员 / 部署授权 / env 推拉 */
@Controller('api')
export class AppsController {
  constructor(
    private readonly apps: AppsService,
    private readonly dokploy: DokploySettingsService,
  ) {}

  // ---------- 管理员：Dokploy 侧清单（配置自助建应用的落点、挂载既有应用） ----------

  @Get('admin/dokploy/projects')
  @Roles('admin')
  listDokployProjects() {
    return this.dokploy.listProjects();
  }

  @Get('admin/dokploy/ssh-keys')
  @Roles('admin')
  listDokploySshKeys() {
    return this.dokploy.listSshKeys();
  }

  /** Dokploy 应用清单（决策 27）：管理员挂载既有应用时搜索用；普通成员走自助创建，不需要它 */
  @Get('admin/dokploy/applications')
  @Roles('admin')
  listDokployApplications() {
    return this.dokploy.listApplications();
  }

  // ---------- 应用 ----------

  @Get('apps')
  list(@CurrentUser() user: AuthUser) {
    return this.apps.listApps(user);
  }

  /** 自助创建：任何登录成员；平台在 Dokploy 上建应用并配好 Git 源 / SSH key / 构建方式 */
  @Post('apps')
  create(@Body(new ZodValidationPipe(createAppSchema)) body: CreateAppRequest, @CurrentUser() user: AuthUser) {
    return this.apps.createApp(user, body);
  }

  /** 管理员挂载 Dokploy 上既有的 application */
  @Post('apps/mount')
  @Roles('admin')
  mount(@Body(new ZodValidationPipe(mountAppSchema)) body: MountAppRequest, @CurrentUser() user: AuthUser) {
    return this.apps.mountApp(user, body);
  }

  @Patch('apps/:slug')
  update(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateAppSchema)) body: UpdateAppRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apps.updateApp(user, slug, body);
  }

  @Delete('apps/:slug')
  remove(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.apps.removeApp(user, slug);
  }

  @Post('apps/:slug/members')
  addMember(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: { userId: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.apps.addMember(user, slug, body.userId);
  }

  @Delete('apps/:slug/members/:userId')
  removeMember(@Param('slug') slug: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.apps.removeMember(user, slug, userId);
  }

  // ---------- 部署授权（管理员，决策 31） ----------

  @Post('apps/:slug/approve')
  @Roles('admin')
  @HttpCode(200)
  approve(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.apps.approveDeploy(user, slug);
  }

  @Delete('apps/:slug/approve')
  @Roles('admin')
  revoke(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.apps.revokeDeployApproval(user, slug);
  }

  // ---------- 应用 env（成员，决策 31） ----------

  @Get('apps/:slug/env')
  getEnv(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.apps.getEnv(user, slug);
  }

  @Put('apps/:slug/env')
  setEnv(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateAppEnvSchema)) body: UpdateAppEnvRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apps.setEnv(user, slug, body);
  }
}
