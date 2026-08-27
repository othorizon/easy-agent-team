import { Module } from '@nestjs/common';
import { AccessRequestsService } from './access-requests.service';
import { EnvsController } from './envs.controller';
import { EnvsService } from './envs.service';

@Module({
  controllers: [EnvsController],
  providers: [EnvsService, AccessRequestsService],
})
export class EnvsModule {}
