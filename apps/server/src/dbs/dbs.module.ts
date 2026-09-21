import { Module } from '@nestjs/common';
import { DbsController } from './dbs.controller';
import { DbsService } from './dbs.service';

@Module({
  controllers: [DbsController],
  providers: [DbsService],
  // MCP 端点的工具实现直接调这层（决策 55：不绕回自己的 REST）
  exports: [DbsService],
})
export class DbsModule {}
