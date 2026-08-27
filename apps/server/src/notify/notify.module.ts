import { Global, Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';

@Global()
@Module({
  providers: [WebhookService],
  exports: [WebhookService],
})
export class NotifyModule {}
