import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  createAliyunConnectionSchema,
  updateAliyunConnectionSchema,
  aliyunConnectionStatusSchema,
  type CreateAliyunConnectionRequest,
  type UpdateAliyunConnectionRequest,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AliyunService } from './aliyun.service';

@Controller('api/aliyun')
export class AliyunController {
  constructor(private readonly aliyun: AliyunService) {}
  @Get('status')
  status() {
    return this.aliyun.availability();
  }
  @Get('permissions/manage')
  @Roles('admin')
  permissions() {
    return this.aliyun.listPermissions();
  }
  @Post('connections/:id/refresh')
  @Roles('admin')
  refresh(@Param('id', ParseUUIDPipe) id: string) {
    return this.aliyun.refresh(id);
  }
  @Get('connections')
  @Roles('admin')
  @Header('Cache-Control', 'no-store')
  connections() {
    return this.aliyun.listConnections();
  }
  @Post('connections')
  @Roles('admin')
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createAliyunConnectionSchema))
    dto: CreateAliyunConnectionRequest,
  ) {
    return this.aliyun.createConnection(user, dto);
  }
  @Patch('connections/:id')
  @Roles('admin')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAliyunConnectionSchema))
    dto: UpdateAliyunConnectionRequest,
  ) {
    return this.aliyun.updateConnection(user, id, dto);
  }
  @Post('connections/:id/validate')
  @Roles('admin')
  validate(@Param('id', ParseUUIDPipe) id: string) {
    return this.aliyun.validateConnection(id);
  }
  @Post('connections/:id/status')
  @Roles('admin')
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(aliyunConnectionStatusSchema))
    dto: { status: 'enabled' | 'paused' },
  ) {
    return this.aliyun.setConnectionStatus(user, id, dto.status);
  }
  @Delete('connections/:id')
  @Roles('admin')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.aliyun.removeConnection(user, id);
  }
}
