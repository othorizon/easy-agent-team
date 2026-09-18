import { Module } from '@nestjs/common';
import { McpSubscriptionsService } from './mcp-subscriptions.service';

/** 订阅判定单独成模块：McpConfigsModule 与 McpGatewayModule 都要用，放哪边都会绕成环 */
@Module({
  providers: [McpSubscriptionsService],
  exports: [McpSubscriptionsService],
})
export class McpSubscriptionsModule {}
