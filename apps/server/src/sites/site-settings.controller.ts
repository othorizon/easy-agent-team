import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { updateSiteSettingsSchema, type UpdateSiteSettings } from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { SiteSettingsStore } from './site-settings.store';
import { SiteSetupService } from './site-setup.service';

@Controller('api/admin/site-settings')
@Roles('admin')
export class SiteSettingsController {
  constructor(
    private readonly store: SiteSettingsStore,
    private readonly setup: SiteSetupService,
  ) {}
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
