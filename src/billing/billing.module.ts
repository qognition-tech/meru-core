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
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { FeeScheduleService } from './fee-schedule.service';
import { VerticalPackModule } from '../tenant/vertical-pack.module';

@Module({
  imports: [
    // Layer 4: the vertical's fee schedule and payment plans.
    VerticalPackModule,
    TypeOrmModule.forFeature([
      BillingPlan,
      Subscription,
      UsageRecord,
      CreditLedger,
      Invoice,
      InvoiceItem,
      Tenant,
      Payment,
    ]),
    SearchModule,
  ],
  controllers: [BillingController, StripeWebhookController, PaymentsController],
  providers: [
    BillingService,
    StripeService,
    PaymentsService,
    FeeScheduleService,
  ],
  exports: [BillingService, StripeService, PaymentsService, FeeScheduleService],
})
export class BillingModule {}
