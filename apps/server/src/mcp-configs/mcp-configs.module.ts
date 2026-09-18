import { Module } from '@nestjs/common';
import { EnvsModule } from '../envs/envs.module';
import { McpGatewayModule } from '../mcp-gateway/mcp-gateway.module';
import { McpConfigsController } from './mcp-configs.controller';
import { McpConfigsService } from './mcp-configs.service';
import { McpSubscriptionsModule } from './mcp-subscriptions.module';

@Module({
  imports: [EnvsModule, McpSubscriptionsModule, McpGatewayModule],
  controllers: [McpConfigsController],
  providers: [McpConfigsService],
})
export class McpConfigsModule {}
