import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  updateSiteSettingsSchema,
  updateSiteCdnSchema,
  type UpdateSiteCdn,
  type UpdateSiteSettings,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { SiteSettingsStore } from './site-settings.store';
import { SiteCdnStore } from './site-cdn.store';
import { SiteSetupService } from './site-setup.service';

@Controller('api/admin/site-settings')
@Roles('admin')
export class SiteSettingsController {
  constructor(
    private readonly store: SiteSettingsStore,
    private readonly setup: SiteSetupService,
    private readonly cdn: SiteCdnStore,
  ) {}
  @Get('cdn') getCdn() {
    return this.cdn.info();
  }
  @Put('cdn') saveCdn(
    @Body(new ZodValidationPipe(updateSiteCdnSchema)) body: UpdateSiteCdn,
    @CurrentUser() user: AuthUser,
  ) {
    return this.cdn.save(body, user.id);
  }
  @Post('cdn/retry') retryCdn(@CurrentUser() user: AuthUser) {
    return this.cdn.retry(user.id);
  }
  @Get() get() {
    return this.store.info();
  }
  @Put() save(@Body(new ZodValidationPipe(updateSiteSettingsSchema)) body: UpdateSiteSettings) {
    return this.store.save(body);
  }
  @Get('tls-options/:applicationId') tls(@Param('applicationId') applicationId: string) {
    return this.setup.tlsOptions(applicationId);
  }
  @Post('enable') enable(@CurrentUser() user: AuthUser) {
    return this.setup.start(user.id);
  }
  @Post('disable') disable(@CurrentUser() user: AuthUser) {
    return this.setup.start(user.id, true);
  }
}
