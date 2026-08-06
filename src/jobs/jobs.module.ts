import { MigrateService } from './migrate.service';
import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { CronSecretGuard } from './cron-secret.guard';
import { WorkflowModule } from '../workflow/workflow.module';
import { BillingModule } from '../billing/billing.module';
import { QueueModule } from '../queue/queue.module';
import { TasksModule } from '../tasks/tasks.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditModule } from '../audit/audit.module';
import { AiModule } from '../ai/ai.module';

/**
 * JOBS — HTTP entrypoints for scheduled work.
 *
 * The underlying services are consumed from their owning modules (never
 * re-provided) so the jobs share the exact same singleton instances — and
 * therefore the same repositories — as the rest of the app.
 */
@Module({
  imports: [
    WorkflowModule,
    BillingModule,
    QueueModule,
    TasksModule,
    NotificationsModule,
    AnalyticsModule,
    AuditModule,
    AiModule,
  ],
  controllers: [JobsController],
  providers: [CronSecretGuard, MigrateService],
})
export class JobsModule {}
