import { DbAccessController } from './db-access.controller';
import { DbAccessRequests } from './db-access-requests';
import { DbAccessService } from './db-access.service';
import { Module } from '@nestjs/common';
import { DbsController } from './dbs.controller';
import { DbsService } from './dbs.service';

@Module({
  controllers: [DbsController, DbAccessController],
  providers: [DbsService, DbAccessService, DbAccessRequests],
  // MCP 端点的工具实现直接调这层（决策 55：不绕回自己的 REST）
  exports: [DbsService, DbAccessRequests, DbAccessService],
})
export class DbsModule {}
