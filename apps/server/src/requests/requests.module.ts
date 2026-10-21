import { Global, Module } from '@nestjs/common';
import { EnvsModule } from '../envs/envs.module';
import { McpConfigsModule } from '../mcp-configs/mcp-configs.module';
import { DbsModule } from '../dbs/dbs.module';
import { OssModule } from '../oss/oss.module';
import { DeployModule } from '../deploy/deploy.module';
import { RequestsService } from './requests.service';
import { RequestsController } from './requests.controller';
import { RequestNotifications } from './requests.notifications';
@Global()
@Module({
  imports: [EnvsModule, McpConfigsModule, DbsModule, OssModule, DeployModule],
  controllers: [RequestsController],
  providers: [RequestsService, RequestNotifications],
  exports: [RequestsService],
})
export class RequestsModule {}
