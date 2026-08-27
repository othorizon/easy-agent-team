import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  createDbAssignmentSchema,
  createDbInstanceSchema,
  type CreateDbAssignmentRequest,
  type CreateDbInstanceRequest,
} from '@eat/shared';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DbsService } from './dbs.service';

@Controller('api/db')
export class DbsController {
  constructor(private readonly dbs: DbsService) {}

  /** 成员选实例发起申请也需要看到实例列表（不含凭证） */
  @Get('instances')
  listInstances() {
    return this.dbs.listInstances();
  }

  @Post('instances')
  @Roles('admin')
  createInstance(@Body(new ZodValidationPipe(createDbInstanceSchema)) body: CreateDbInstanceRequest, @CurrentUser() user: AuthUser) {
    return this.dbs.createInstance(user, body);
  }

  @Delete('instances/:id')
  @Roles('admin')
  removeInstance(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbs.removeInstance(user, id);
  }

  @Post('assignments')
  createAssignment(@Body(new ZodValidationPipe(createDbAssignmentSchema)) body: CreateDbAssignmentRequest, @CurrentUser() user: AuthUser) {
    return this.dbs.createAssignment(user, body);
  }

  @Get('assignments/mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.dbs.listMine(user);
  }

  @Get('assignments')
  @Roles('admin')
  all() {
    return this.dbs.listAll();
  }

  @Post('assignments/:id/approve')
  @Roles('admin')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbs.approve(user, id);
  }

  @Post('assignments/:id/reject')
  @Roles('admin')
  reject(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbs.reject(user, id);
  }

  @Post('assignments/:id/disable')
  @Roles('admin')
  disable(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbs.disable(user, id);
  }

  @Post('assignments/:id/enable')
  @Roles('admin')
  enable(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbs.enable(user, id);
  }

  @Delete('assignments/:id')
  @Roles('admin')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbs.remove(user, id);
  }
}
