import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  deploymentsQuerySchema,
  logsQuerySchema,
  testDokploySettingsSchema,
  triggerDeploySchema,
  updateDokploySettingsSchema,
  type DeploymentsQuery,
  type LogsQuery,
  type TestDokploySettingsRequest,
  type TriggerDeployRequest,
  type UpdateDokploySettingsRequest,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DeployService } from './deploy.service';
import { DokploySettingsService } from './dokploy-settings.service';

/** Dokploy 接入配置（管理员）+ 部署触发 / 部署记录 / 日志 / 密钥指纹清单 */
@Controller('api')
export class DeployController {
  constructor(
    private readonly deploy: DeployService,
    private readonly dokploy: DokploySettingsService,
  ) {}

  // ---------- Dokploy 接入（管理员） ----------

  @Get('admin/dokploy-settings')
  @Roles('admin')
  getSettings() {
    return this.dokploy.getSettings();
  }

  @Put('admin/dokploy-settings')
  @Roles('admin')
  updateSettings(@Body(new ZodValidationPipe(updateDokploySettingsSchema)) body: UpdateDokploySettingsRequest) {
    return this.dokploy.updateSettings(body);
  }

  /** 连通性测试：不落库，失败也返回 200（结果在 ok/message） */
  @Post('admin/dokploy-settings/test')
  @Roles('admin')
  @HttpCode(200)
  testSettings(@Body(new ZodValidationPipe(testDokploySettingsSchema)) body: TestDokploySettingsRequest) {
    return this.dokploy.testSettings(body);
  }

  // ---------- 部署 ----------

  @Post('apps/:slug/deploy')
  trigger(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(triggerDeploySchema)) body: TriggerDeployRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.deploy(user, slug, body);
  }

  /**
   * 部署历史（决策 30）：默认以 Dokploy 的构建记录为准（它只留最近 10 条），
   * `?all=1` 改以平台元数据为主干列出全部历史，含 Dokploy 已清理掉的。
   */
  @Get('apps/:slug/deployments')
  listDeployments(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(deploymentsQuerySchema)) query: DeploymentsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.listDeployments(user, slug, query);
  }

  /** 应用最近一次部署：CLI 的 `eat app status <slug>` 用它，不必先记住部署 ID */
  @Get('apps/:slug/deployments/latest')
  latestDeployment(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.deploy.latestDeployment(user, slug);
  }

  /**
   * 查某一次部署。路由必须排在 `latest` 之后（Nest 按声明顺序匹配）。
   * id 可以是 Dokploy 构建记录 id，也可以是平台元数据 id——构建记录被 Dokploy 清理后
   * 只剩后者，两个 ID 空间都得认（决策 30）。
   */
  @Get('apps/:slug/deployments/:id')
  getDeployment(@Param('slug') slug: string, @Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.deploy.getDeployment(user, slug, id);
  }

  // ---------- 构建日志 / 运行日志（决策 28） ----------

  /** 日志可能含构建期注入的密钥，仅应用成员可读（见 DeployService.buildLogs） */
  @Get('apps/:slug/build-logs')
  buildLogs(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(logsQuerySchema)) query: LogsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deploy.buildLogs(user, slug, query);
  }

  @Get('apps/:slug/run-logs')
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
