import { Module } from '@nestjs/common';
import { DeployController } from './deploy.controller';
import { DeployService } from './deploy.service';

@Module({
  controllers: [DeployController],
  providers: [DeployService],
})
export class DeployModule {}
