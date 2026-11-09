import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { configureAliyunPermissionSchema, requestAliyunPermissionSchema, type ConfigureAliyunPermission, type RequestAliyunPermission } from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AliyunRequests } from './aliyun-requests';

@Controller('api/aliyun/permissions')
export class AliyunRequestsController {
  constructor(private readonly requests: AliyunRequests) {}
  @Get() list(@CurrentUser() user: AuthUser) { return this.requests.list(user); }
  @Get('manage') manage(@CurrentUser() user: AuthUser) { return this.requests.list(user, true); }
  @Patch(':id') configure(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(configureAliyunPermissionSchema)) dto: ConfigureAliyunPermission) { return this.requests.configure(user, id, dto); }
  @Get(':id/document') @Header('Cache-Control', 'no-store') document(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.requests.document(user, id); }
  @Post(':id/requests') submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(requestAliyunPermissionSchema)) dto: RequestAliyunPermission) { return this.requests.submit(user, id, dto); }
}
