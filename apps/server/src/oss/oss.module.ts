import { OssToolsService } from './oss-tools.service';
import { Module } from '@nestjs/common';
import { OssCloud } from './oss-cloud';
import { OssStore } from './oss-store';
import { OssProvisioner } from './oss-provisioner';
import { OssService } from './oss.service';
import { OssController, OssSettingsController } from './oss.controller';

@Module({
  controllers: [OssController, OssSettingsController],
  providers: [OssCloud, OssStore, OssProvisioner, OssService, OssToolsService],
  exports: [OssService, OssToolsService],
})
export class OssModule {}
