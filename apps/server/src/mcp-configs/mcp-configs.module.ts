import { Module } from '@nestjs/common';
import { EnvsModule } from '../envs/envs.module';
import { McpConfigsController } from './mcp-configs.controller';
import { McpConfigsService } from './mcp-configs.service';

@Module({
  imports: [EnvsModule],
  controllers: [McpConfigsController],
  providers: [McpConfigsService],
})
export class McpConfigsModule {}
