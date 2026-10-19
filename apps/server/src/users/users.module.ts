import { OssModule } from '../oss/oss.module';
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { LlmGatewayModule } from '../llm-gateway/llm-gateway.module';

@Module({
  imports: [LlmGatewayModule, OssModule],
  controllers: [UsersController],
})
export class UsersModule {}
