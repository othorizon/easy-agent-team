import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { DemoController } from './demo.controller';
import { DemoInterceptor } from './demo.interceptor';

/** 公网演示模式：封禁清单 + 门户一键登录。`EAT_DEMO_MODE` 不为 1 时两者都是空操作 */
@Module({
  imports: [AuthModule],
  controllers: [DemoController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: DemoInterceptor }],
})
export class DemoModule {}
