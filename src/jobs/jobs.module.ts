import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { CronSecretGuard } from './cron-secret.guard';
import { WorkflowModule } from '../workflow/workflow.module';
import { BillingModule } from '../billing/billing.module';

/**
 * JOBS — HTTP entrypoints for scheduled work.
 *
 * The underlying services are consumed from their owning modules (never
 * re-provided) so the jobs share the exact same singleton instances — and
 * therefore the same repositories — as the rest of the app.
 */
@Module({
  imports: [WorkflowModule, BillingModule],
  controllers: [JobsController],
  providers: [CronSecretGuard],
})
export class JobsModule {}
