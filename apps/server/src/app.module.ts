import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AppExceptionFilter } from './common/http-exception.filter';
import { DbModule } from './db/db.module';
import { DbsModule } from './dbs/dbs.module';
import { DeployModule } from './deploy/deploy.module';
import { EnvsModule } from './envs/envs.module';
import { HealthController } from './health.controller';
import { HelpModule } from './help/help.module';
import { InstallModule } from './install/install.module';
import { McpConfigsModule } from './mcp-configs/mcp-configs.module';
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
    DbsModule,
    DeployModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
})
export class AppModule {}
