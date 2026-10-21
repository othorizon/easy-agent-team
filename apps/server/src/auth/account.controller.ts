import { Body, Controller, Delete, Get, Patch, Post, Put } from '@nestjs/common';
import {
  updateAccountSchema, changePasswordSchema, sendWebhookCodeSchema, verifyWebhookSchema, notificationPreferencesSchema,
  type UpdateAccountRequest, type NotificationPreferences,
  patchNotificationPreferencesSchema, type PatchNotificationPreferencesRequest,
} from '@eat/shared';
import { AllowIncompleteProfile, CurrentUser, type AuthUser } from './auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AccountService } from './account.service';
import { UserNotificationsService } from '../notify/user-notifications.service';

@AllowIncompleteProfile()
@Controller('api/account')
export class AccountController {
  constructor(private readonly account: AccountService, private readonly notifications: UserNotificationsService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) { return this.account.get(user); }

  @Get('onboarding')
  onboarding(@CurrentUser() user: AuthUser) { return this.account.onboarding(user); }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(updateAccountSchema)) dto: UpdateAccountRequest) {
    return this.account.update(user, dto);
  }

  @Post('password')
  password(@CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: { oldPassword: string; password: string }) {
    return this.account.changePassword(user, dto.oldPassword, dto.password);
  }

  @Post('notification/code')
  sendCode(@CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(sendWebhookCodeSchema)) dto: { webhookUrl: string; webhookSecret?: string }) {
    return this.notifications.sendCode(user.id, dto);
  }

  @Post('notification/verify')
  verify(@CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(verifyWebhookSchema)) dto: { challengeId: string; code: string }) {
    return this.notifications.verify(user.id, dto.challengeId, dto.code);
  }

  @Put('notification/preferences')
  preferences(@CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(notificationPreferencesSchema)) dto: NotificationPreferences) {
    return this.notifications.preferences(user.id, dto);
  }

  @Patch('notification/preferences')
  patchPreferences(@CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(patchNotificationPreferencesSchema)) dto: PatchNotificationPreferencesRequest) {
    return this.notifications.preferences(user.id, dto);
  }

  @Delete('notification')
  remove(@CurrentUser() user: AuthUser) { return this.notifications.remove(user.id); }
}
