import { Global, Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { UserNotificationsService } from './user-notifications.service';

@Global()
@Module({
  providers: [WebhookService, UserNotificationsService],
  exports: [WebhookService, UserNotificationsService],
})
export class NotifyModule {}
