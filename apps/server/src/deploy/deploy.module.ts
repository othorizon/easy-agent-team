import { Module } from '@nestjs/common';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';
import { DokploySettingsService } from './dokploy-settings.service';

@Module({
  controllers: [AppsController, DeployController],
  providers: [DokploySettingsService, AppsService, DeployService],
})
export class DeployModule {}
