import { Global, Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { UserNotificationsService } from './user-notifications.service';
import { NotifierService } from './notifier.service';
import { FeishuAppService } from './feishu/feishu-app.service';
import { FeishuCallbackService } from './feishu/feishu-callback.service';
import { FeishuController } from './feishu/feishu.controller';

@Global()
@Module({
  controllers: [FeishuController],
  providers: [WebhookService, UserNotificationsService, NotifierService, FeishuAppService, FeishuCallbackService],
  exports: [WebhookService, UserNotificationsService, NotifierService, FeishuAppService, FeishuCallbackService],
})
export class NotifyModule {}
