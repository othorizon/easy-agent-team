import { AliyunModule } from '../aliyun/aliyun.module';
import { Global, Module } from '@nestjs/common';
import { EnvsModule } from '../envs/envs.module';
import { McpConfigsModule } from '../mcp-configs/mcp-configs.module';
import { DbsModule } from '../dbs/dbs.module';
import { OssModule } from '../oss/oss.module';
import { DeployModule } from '../deploy/deploy.module';
import { RequestsService } from './requests.service';
import { RequestsController } from './requests.controller';
import { RequestNotifications } from './requests.notifications';
import { builtinRequestTypes } from './builtin-request-types';
import { RequestTypes } from './request-types';
import { ApprovalCards } from './approval-cards.service';
@Global()
@Module({
  imports: [AliyunModule, EnvsModule, McpConfigsModule, DbsModule, OssModule, DeployModule],
  controllers: [RequestsController],
  providers: [builtinRequestTypes, RequestsService, RequestNotifications, ApprovalCards],
  exports: [RequestsService, RequestTypes],
})
export class RequestsModule {}
