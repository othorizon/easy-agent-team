import { Module } from '@nestjs/common';
import { EnvsModule } from '../envs/envs.module';
import { McpSubscriptionsModule } from '../mcp-configs/mcp-subscriptions.module';
import { McpGatewayController } from './mcp-gateway.controller';
import { McpGatewayService } from './mcp-gateway.service';

@Module({
  imports: [EnvsModule, McpSubscriptionsModule],
  controllers: [McpGatewayController],
  providers: [McpGatewayService],
  exports: [McpGatewayService],
})
export class McpGatewayModule {}
