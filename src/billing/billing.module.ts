import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingPlan } from './entities/billing-plan.entity';
import { Subscription } from './entities/subscription.entity';
import { UsageRecord } from './entities/usage-record.entity';
import { CreditLedger } from './entities/credit-ledger.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { SearchModule } from '../search/search.module';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { Tenant } from '../iam/entities/tenant.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BillingPlan,
      Subscription,
      UsageRecord,
      CreditLedger,
      Invoice,
      InvoiceItem,
      Tenant,
    ]),
    SearchModule,
  ],
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService, StripeService],
  exports: [BillingService, StripeService],
})
export class BillingModule {}
