import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { upsertMcpConfigSchema, type UpsertMcpConfigRequest } from '@eat/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { McpConfigsService } from './mcp-configs.service';

@Controller('api/mcp-configs')
export class McpConfigsController {
  constructor(private readonly configs: McpConfigsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.configs.list(user);
  }

  /** eat sync 的渲染结果（按用户权限解析环境变量引用），声明须在 :slug 之前 */
  @Get('sync-bundle')
  syncBundle(@CurrentUser() user: AuthUser) {
    return this.configs.syncBundle(user);
  }

  @Post()
  upsert(@Body(new ZodValidationPipe(upsertMcpConfigSchema)) body: UpsertMcpConfigRequest, @CurrentUser() user: AuthUser) {
    return this.configs.upsert(user, body);
  }

  @Delete(':slug')
  remove(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.configs.remove(user, slug);
  }

  @Post(':slug/subscribe')
  subscribe(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.configs.subscribe(user, slug);
  }

  @Delete(':slug/subscribe')
  unsubscribe(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.configs.unsubscribe(user, slug);
  }
}
