import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeployModule } from '../deploy/deploy.module';
import { EnvsModule } from '../envs/envs.module';
import { HelpModule } from '../help/help.module';
import { McpServerController } from './mcp-server.controller';
import { McpServerService } from './mcp-server.service';
import { McpToolsService } from './mcp-tools.service';

/** 平台自身能力的 MCP 端点（决策 55）：工具实现直接复用各业务 Service */
@Module({
  imports: [AuthModule, EnvsModule, HelpModule, DeployModule],
  controllers: [McpServerController],
  providers: [McpServerService, McpToolsService],
})
export class McpServerModule {}
