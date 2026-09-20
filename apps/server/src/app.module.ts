import { Module, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ClientVersionInterceptor } from './common/client-version.interceptor';
import { AppExceptionFilter } from './common/http-exception.filter';
import { registerTolerantJsonParser } from './common/json-body';
import { DbModule } from './db/db.module';
import { DbsModule } from './dbs/dbs.module';
import { DeployModule } from './deploy/deploy.module';
import { EnvsModule } from './envs/envs.module';
import { HealthController } from './health.controller';
import { HelpModule } from './help/help.module';
import { InstallModule } from './install/install.module';
import { McpConfigsModule } from './mcp-configs/mcp-configs.module';
import { McpGatewayModule } from './mcp-gateway/mcp-gateway.module';
import { McpServerModule } from './mcp-server/mcp-server.module';
import { NotifyModule } from './notify/notify.module';
import { SkillsModule } from './skills/skills.module';
import { TemplatesModule } from './templates/templates.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    DbModule,
    AuditModule,
    NotifyModule,
    AiModule,
    AuthModule,
    UsersModule,
    EnvsModule,
    SkillsModule,
    HelpModule,
    InstallModule,
    TemplatesModule,
    McpConfigsModule,
    McpGatewayModule,
    McpServerModule,
    DbsModule,
    DeployModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    // CLI 更新检测：给自报身份的 CLI 请求附带版本头（决策 26）
    { provide: APP_INTERCEPTOR, useClass: ClientVersionInterceptor },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit() {
    // 放在这里而不是 main.ts：e2e 自己造 app，不走 bootstrap，
    // 挂在模块初始化上才能保证两条路径行为一致
    const instance = this.adapterHost.httpAdapter?.getInstance();
    if (instance?.addContentTypeParser) registerTolerantJsonParser(instance);
  }
}
