import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  feishuAppCredentialsSchema,
  updateNotificationChannelSchema,
  type FeishuAppCredentials,
  type UpdateNotificationChannelRequest,
} from '@eat/shared';
import { CurrentUser, Public, Roles, type AuthUser } from '../../auth/auth.decorators';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { FeishuAppService } from './feishu-app.service';
import { FeishuCallbackService } from './feishu-callback.service';

@Controller('api')
export class FeishuController {
  constructor(
    private readonly feishu: FeishuAppService,
    private readonly callback: FeishuCallbackService,
  ) {}

  /** 开发者后台「事件配置」与「回调配置」共用的请求地址 */
  @Post('feishu/callback')
  @Public()
  @HttpCode(200)
  handle(@Req() req: FastifyRequest) {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    return this.callback.handle(raw, req.headers);
  }

  @Get('settings/feishu')
  @Roles('admin')
  settings() {
    return this.feishu.info();
  }

  @Put('settings/feishu/app')
  @Roles('admin')
  save(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(feishuAppCredentialsSchema)) dto: FeishuAppCredentials) {
    return this.feishu.saveCredentials(user.id, dto);
  }

  @Post('settings/feishu/check')
  @Roles('admin')
  async check() {
    await this.feishu.check();
    return this.feishu.info();
  }

  @Post('settings/feishu/scopes/apply')
  @Roles('admin')
  apply(@CurrentUser() user: AuthUser) {
    return this.feishu.applyScopes(user.id);
  }

  @Put('settings/feishu/channel')
  @Roles('admin')
  channel(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateNotificationChannelSchema)) dto: UpdateNotificationChannelRequest,
  ) {
    return this.feishu.setChannel(user.id, dto.channel);
  }
}
