import { AliyunCredentialsController } from './aliyun-credentials.controller';
import { AliyunCredentialsService } from './aliyun-credentials.service';
import { AliyunRequests } from './aliyun-requests';
import { AliyunRequestsController } from './aliyun-requests.controller';
import { Module } from '@nestjs/common';
import { RamModule } from '../ram/ram.module';
import { AliyunController } from './aliyun.controller';
import { AliyunService } from './aliyun.service';
import { CloudIdentitiesModule } from '../cloud-identities/cloud-identities.module';
import { AliyunGrantsController } from './aliyun-grants.controller';
import { AliyunGrantsService } from './aliyun-grants.service';

@Module({
  imports: [RamModule, CloudIdentitiesModule],
  controllers: [AliyunController, AliyunGrantsController, AliyunCredentialsController, AliyunRequestsController],
  providers: [AliyunService, AliyunGrantsService, AliyunCredentialsService, AliyunRequests],
  exports: [AliyunService, AliyunGrantsService, AliyunRequests],
})
export class AliyunModule {}
