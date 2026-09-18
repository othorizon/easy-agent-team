import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  addMcpSubscriberSchema,
  decideMcpSubscriptionSchema,
  mcpSubscriptionRequestQuerySchema,
  subscribeMcpConfigSchema,
  upsertMcpConfigSchema,
  type AddMcpSubscriberRequest,
  type DecideMcpSubscriptionRequest,
  type McpSubscriptionRequestQuery,
  type SubscribeMcpConfigRequest,
  type UpsertMcpConfigRequest,
} from '@eat/shared';
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

  /** 我能审批的订阅申请（配置 Owner / 管理员，决策 50） */
  @Get('subscription-requests')
  requests(
    @Query(new ZodValidationPipe(mcpSubscriptionRequestQuerySchema)) query: McpSubscriptionRequestQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.configs.requests(user, query);
  }

  @Post('subscription-requests/:id/decision')
  decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideMcpSubscriptionSchema)) body: DecideMcpSubscriptionRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.configs.decide(user, id, body);
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
  subscribe(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(subscribeMcpConfigSchema)) body: SubscribeMcpConfigRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.configs.subscribe(user, slug, body);
  }

  @Delete(':slug/subscribe')
  unsubscribe(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.configs.unsubscribe(user, slug);
  }

  /** 订阅者明细与主动分配：Owner / 管理员 */
  @Get(':slug/subscribers')
  subscribers(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.configs.subscribers(user, slug);
  }

  @Post(':slug/subscribers')
  addSubscriber(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(addMcpSubscriberSchema)) body: AddMcpSubscriberRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return this.configs.addSubscriber(user, slug, body);
  }

  @Delete(':slug/subscribers/:userId')
  removeSubscriber(@Param('slug') slug: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.configs.removeSubscriber(user, slug, userId);
  }
}
