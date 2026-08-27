import { Body, Controller, Get, Put } from '@nestjs/common';
import { updateAiSettingsSchema, type UpdateAiSettingsRequest } from '@eat/shared';
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
}
