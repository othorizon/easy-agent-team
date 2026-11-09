import { Module } from '@nestjs/common';
import { RamModule } from '../ram/ram.module';
import { AliyunController } from './aliyun.controller';
import { AliyunService } from './aliyun.service';
import { CloudIdentitiesModule } from '../cloud-identities/cloud-identities.module';
import { AliyunGrantsController } from './aliyun-grants.controller';
import { AliyunGrantsService } from './aliyun-grants.service';

@Module({
  imports: [RamModule, CloudIdentitiesModule],
  controllers: [AliyunController, AliyunGrantsController],
  providers: [AliyunService, AliyunGrantsService],
  exports: [AliyunService, AliyunGrantsService],
})
export class AliyunModule {}
