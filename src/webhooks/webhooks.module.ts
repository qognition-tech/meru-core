import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboundWebhookEndpoint } from './entities/inbound-webhook-endpoint.entity';
import { InboundWebhookEvent } from './entities/inbound-webhook-event.entity';
import { InboundWebhookService } from './inbound-webhook.service';
import {
  InboundWebhookAdminController,
  InboundWebhookReceiverController,
} from './webhooks.controller';

/**
 * Inbound webhooks — the generic receiver. Outbound webhooks (Meru calling
 * the tenant) live in integrations; they are a different direction and a
 * different trust model.
 */
@Module({
  imports: [TypeOrmModule.forFeature([InboundWebhookEndpoint, InboundWebhookEvent])],
  providers: [InboundWebhookService],
  controllers: [InboundWebhookReceiverController, InboundWebhookAdminController],
  exports: [InboundWebhookService],
})
export class WebhooksModule {}
