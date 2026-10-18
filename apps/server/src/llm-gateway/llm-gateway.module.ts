import { Module } from '@nestjs/common';
import {
  LlmGatewayAdminController,
  LlmGatewayController,
  LlmGatewaySettingsController,
} from './llm-gateway.controller';
import { LlmGatewayService } from './llm-gateway.service';
import { LlmSettingsService } from './llm-settings.service';

@Module({
  controllers: [LlmGatewayController, LlmGatewaySettingsController, LlmGatewayAdminController],
  providers: [LlmSettingsService, LlmGatewayService],
  exports: [LlmGatewayService],
})
export class LlmGatewayModule {}
