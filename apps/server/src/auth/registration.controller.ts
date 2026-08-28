import { Body, Controller, Get, Put } from '@nestjs/common';
import { registrationSettingsSchema, type RegistrationSettings } from '@eat/shared';
import { ZodValidationPipe } from '../common/zod.pipe';
import { CurrentUser, Roles, type AuthUser } from './auth.decorators';
import { RegistrationService } from './registration.service';

@Controller('api/admin/registration-settings')
@Roles('admin')
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Get()
  get() {
    return this.registration.getSettings();
  }

  @Put()
  update(
    @Body(new ZodValidationPipe(registrationSettingsSchema)) body: RegistrationSettings,
    @CurrentUser() user: AuthUser,
  ) {
    return this.registration.updateSettings(user, body);
  }
}
