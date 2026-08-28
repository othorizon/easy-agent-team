import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createProjectSchema,
  testDokploySettingsSchema,
  triggerDeploySchema,
  updateDokploySettingsSchema,
  updateProjectSchema,
  type CreateProjectRequest,
  type TestDokploySettingsRequest,
  type TriggerDeployRequest,
  type UpdateDokploySettingsRequest,
  type UpdateProjectRequest,
} from '@eat/shared';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DeployService } from './deploy.service';

const addMemberSchema = z.object({ userId: z.string() });

@Controller('api')
export class DeployController {
  constructor(private readonly deploy: DeployService) {}

  // ---------- Dokploy 接入（管理员） ----------

  @Get('admin/dokploy-settings')
  @Roles('admin')
  getSettings() {
    return this.deploy.getSettings();
  }

  @Put('admin/dokploy-settings')
  @Roles('admin')
  updateSettings(@Body(new ZodValidationPipe(updateDokploySettingsSchema)) body: UpdateDokploySettingsRequest) {
    return this.deploy.updateSettings(body);
  }

  /** 连通性测试：不落库，失败也返回 200（结果在 ok/message） */
  @Post('admin/dokploy-settings/test')
  @Roles('admin')
  @HttpCode(200)
  testSettings(@Body(new ZodValidationPipe(testDokploySettingsSchema)) body: TestDokploySettingsRequest) {
    return this.deploy.testSettings(body);
  }

  // ---------- 项目 ----------

  @Get('projects')
  listProjects(@CurrentUser() user: AuthUser) {
    return this.deploy.listProjects(user);
  }

  @Post('projects')
  createProject(@Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectRequest, @CurrentUser() user: AuthUser) {
    return this.deploy.createProject(user, body);
  }

  @Patch('projects/:slug')
  updateProject(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.updateProject(user, slug, body);
  }

  @Delete('projects/:slug')
  removeProject(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.deploy.removeProject(user, slug);
  }

  @Post('projects/:slug/members')
  addMember(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: { userId: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.addMember(user, slug, body.userId);
  }

  @Delete('projects/:slug/members/:userId')
  removeMember(@Param('slug') slug: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.deploy.removeMember(user, slug, userId);
  }

  // ---------- 部署 ----------

  @Post('projects/:slug/deploy')
  trigger(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(triggerDeploySchema)) body: TriggerDeployRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.deploy(user, slug, body.report);
  }

  @Get('projects/:slug/deployments')
  listDeployments(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.deploy.listDeployments(user, slug);
  }

  @Get('deployments/:id')
  getDeployment(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.deploy.getDeployment(user, id);
  }

  // ---------- 密钥指纹清单（CLI 扫描用） ----------

  @Get('secret-fingerprints')
  fingerprints(@CurrentUser() user: AuthUser) {
    return this.deploy.secretFingerprints(user);
  }
}
