import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  testAiSettingsSchema,
  updateAiSettingsSchema,
  type TestAiSettingsRequest,
  type UpdateAiSettingsRequest,
} from '@eat/shared';
import { Roles } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AiService } from './ai.service';

@Controller('api/admin/ai-settings')
@Roles('admin')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get()
  get() {
    return this.ai.getSettings();
  }

  @Put()
  update(@Body(new ZodValidationPipe(updateAiSettingsSchema)) body: UpdateAiSettingsRequest) {
    return this.ai.updateSettings(body);
  }

  /** 连通性测试：不落库，失败也返回 200（结果在 ok/message） */
  @Post('test')
  @HttpCode(200)
  test(@Body(new ZodValidationPipe(testAiSettingsSchema)) body: TestAiSettingsRequest) {
    return this.ai.testConnection(body);
  }
}
