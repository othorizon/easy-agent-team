import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Header,
} from '@nestjs/common';
import {
  requestOssSpaceSchema,
  updateOssSpaceSchema,
  updateOssSettingsSchema,
  ossPublicReadSchema,
  ossRejectSchema,
  type RequestOssSpace,
  type UpdateOssSpace,
  type UpdateOssSettings,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import { OssService } from './oss.service';

@Controller('api/oss')
export class OssController {
  constructor(private readonly oss: OssService) {}
  @Get('capability') capability() {
    return this.oss.capability();
  }
  @Get('spaces') list(@CurrentUser() u: AuthUser, @Query('all') all?: string) {
    return this.oss.list(u, all === 'true');
  }
  @Post('spaces') request(
    @CurrentUser() u: AuthUser,
    @Body(new ZodValidationPipe(requestOssSpaceSchema)) body: RequestOssSpace,
  ) {
    return this.oss.request(u, body);
  }
  @Get('spaces/:id') get(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.oss.get(u, id);
  }
  @Patch('spaces/:id') update(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateOssSpaceSchema)) body: UpdateOssSpace,
  ) {
    return this.oss.update(u, id, body);
  }
  @Put('spaces/:id/public-read') publicRead(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ossPublicReadSchema))
    body: { enabled: boolean },
  ) {
    return this.oss.publicRead(u, id, body.enabled);
  }
  @Post('spaces/:id/approve') @Roles('admin') approve(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.oss.decide(u, id, 'approve');
  }
  @Post('spaces/:id/reject') @Roles('admin') reject(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ossRejectSchema)) body: { reason: string },
  ) {
    return this.oss.decide(u, id, 'reject', body.reason);
  }
  @Post('spaces/:id/revoke') @Roles('admin') revoke(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.oss.decide(u, id, 'revoke');
  }
  @Post('spaces/:id/retry') @Roles('admin') retry(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.oss.decide(u, id, 'retry');
  }
  @Get('me/account') account(@CurrentUser() u: AuthUser) {
    return this.oss.accountInfo(u);
  }
  @Post('me/credentials') @Header('Cache-Control', 'no-store') credentials(
    @CurrentUser() u: AuthUser,
  ) {
    return this.oss.credentials(u);
  }
  @Post('me/credentials/reset') reset(@CurrentUser() u: AuthUser) {
    return this.oss.resetCredentials(u);
  }
  @Get('operations/:id') operation(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.oss.operation(u, id);
  }
}

@Controller('api/admin/oss-settings')
@Roles('admin')
export class OssSettingsController {
  constructor(
    private readonly oss: OssService,
    private readonly audit: AuditService,
  ) {}
  @Get() get() {
    return this.oss.store.info();
  }
  @Put() async save(
    @CurrentUser() u: AuthUser,
    @Body(new ZodValidationPipe(updateOssSettingsSchema))
    body: UpdateOssSettings,
  ) {
    const result = await this.oss.store.save(body);
    await this.audit.record({
      actorId: u.id,
      action: 'oss_settings.saved',
      targetType: 'oss_setting',
      targetId: '1',
    });
    return result;
  }
  @Get('domains') domains() {
    return this.oss.store.domains();
  }
  @Post('enable') enable(@CurrentUser() u: AuthUser) {
    return this.oss.setup(u);
  }
  @Post('disable') disable(@CurrentUser() u: AuthUser) {
    return this.oss.disable(u);
  }
}
