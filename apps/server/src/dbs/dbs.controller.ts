import { z } from 'zod';
import { RequestsService } from '../requests/requests.service';
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
  constructor(private readonly dbs: DbsService,private readonly requests:RequestsService) {}

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
  all(@CurrentUser() user: AuthUser) {
    return this.dbs.listAll(user);
  }

  /** 详情（申请人或管理员）；`assignments/mine` 是静态段，路由器优先匹配它，不会被这里吃掉 */
  @Get('assignments/:id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.dbs.get(user, id);
  }

  @Post('assignments/:id/approve')
  @Roles('admin')
  async approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.requests.decideSource(user,'db',id,{decision:'approved'});
    return this.dbs.get(user,id);
  }

  @Post('assignments/:id/retry')
  @Roles('admin')
  retry(@Param('id') id:string,@CurrentUser() user:AuthUser){return this.dbs.approve(user,id,true);}

  @Post('assignments/:id/reject')
  @Roles('admin')
  async reject(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(z.object({reason:z.string().trim().min(1).max(2000)}))) body:{reason:string}) {
    await this.requests.decideSource(user,'db',id,{decision:'rejected',reason:body.reason});
    return this.dbs.get(user,id);
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
