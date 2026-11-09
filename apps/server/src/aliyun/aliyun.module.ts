import { Module } from '@nestjs/common';
import { RamModule } from '../ram/ram.module';
import { AliyunController } from './aliyun.controller';
import { AliyunService } from './aliyun.service';

@Module({
  imports: [RamModule],
  controllers: [AliyunController],
  providers: [AliyunService],
  exports: [AliyunService],
})
export class AliyunModule {}
