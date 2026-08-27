import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AppExceptionFilter } from './common/http-exception.filter';
import { DbModule } from './db/db.module';
import { EnvsModule } from './envs/envs.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [DbModule, AuditModule, AuthModule, UsersModule, EnvsModule],
  providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
})
export class AppModule {}
