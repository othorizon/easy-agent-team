import { OssModule } from '../oss/oss.module';
import { DbsModule } from '../dbs/dbs.module';
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { LlmGatewayModule } from '../llm-gateway/llm-gateway.module';

@Module({
  imports: [LlmGatewayModule, OssModule, DbsModule],
  controllers: [UsersController],
})
export class UsersModule {}
