import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  createProjectSchema,
  deploymentsQuerySchema,
  logsQuerySchema,
  testDokploySettingsSchema,
  triggerDeploySchema,
  updateDokploySettingsSchema,
  updateProjectSchema,
  type CreateProjectRequest,
  type DeploymentsQuery,
  type LogsQuery,
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

  /**
   * Dokploy 应用清单（决策 27）：控制台建项目/改项目时用它搜索并快速填 application id。
   * 与创建项目同权限（任何登录成员），不加 @Roles('admin')——见 DeployService.listDokployApplications 注释。
   */
  @Get('dokploy/applications')
  listDokployApplications() {
    return this.deploy.listDokployApplications();
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

  /**
   * 部署历史（决策 30）：默认以 Dokploy 的构建记录为准（它只留最近 10 条），
   * `?all=1` 改以平台元数据为主干列出全部历史，含 Dokploy 已清理掉的。
   */
  @Get('projects/:slug/deployments')
  listDeployments(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(deploymentsQuerySchema)) query: DeploymentsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.listDeployments(user, slug, query);
  }

  /** 项目最近一次部署：CLI 的 `eat project status <slug>` 用它，不必先记住部署 ID */
  @Get('projects/:slug/deployments/latest')
  latestDeployment(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.deploy.latestDeployment(user, slug);
  }

  /**
   * 查某一次部署。路由必须排在 `latest` 之后（Nest 按声明顺序匹配）。
   * id 可以是 Dokploy 构建记录 id，也可以是平台元数据 id——构建记录被 Dokploy 清理后
   * 只剩后者，两个 ID 空间都得认（决策 30）。
   */
  @Get('projects/:slug/deployments/:id')
  getDeployment(@Param('slug') slug: string, @Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.deploy.getDeployment(user, slug, id);
  }

  // ---------- 构建日志 / 运行日志（决策 28） ----------

  /** 日志可能含构建期注入的密钥，仅项目成员可读（见 DeployService.buildLogs） */
  @Get('projects/:slug/build-logs')
  buildLogs(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(logsQuerySchema)) query: LogsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.buildLogs(user, slug, query);
  }

  @Get('projects/:slug/run-logs')
  runLogs(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(logsQuerySchema)) query: LogsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.runLogs(user, slug, query);
  }

  // ---------- 密钥指纹清单（CLI 扫描用） ----------

  @Get('secret-fingerprints')
  fingerprints(@CurrentUser() user: AuthUser) {
    return this.deploy.secretFingerprints(user);
  }
}
