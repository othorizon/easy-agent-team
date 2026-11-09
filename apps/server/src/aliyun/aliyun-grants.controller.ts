import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { grantAliyunPermissionSchema, revokeAliyunGrantSchema, type GrantAliyunPermissionRequest, type RevokeAliyunGrantRequest } from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AliyunGrantsService } from './aliyun-grants.service';

@Controller('api/aliyun')
export class AliyunGrantsController {
  constructor(private readonly grants: AliyunGrantsService) {}
  @Get('grants') list(@CurrentUser() user: AuthUser) { return this.grants.list(user); }
  @Get('grants/manage') manage(@CurrentUser() user: AuthUser) { return this.grants.list(user, true); }
  @Post('permissions/:id/grants') give(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(grantAliyunPermissionSchema)) dto: GrantAliyunPermissionRequest) { return this.grants.give(user, id, dto); }
  @Post('grants/:id/revoke') revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(revokeAliyunGrantSchema)) dto: RevokeAliyunGrantRequest) { return this.grants.revoke(user, id, dto.reason); }
  @Post('grants/:id/relinquish') relinquish(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.grants.revoke(user, id, '', true); }
  @Post('grants/:id/retry') retry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.grants.retry(user, id); }
}
