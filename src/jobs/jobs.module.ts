import { MigrateService } from './migrate.service';
import { JobRun } from './entities/job-run.entity';
import { JobRunService } from './job-run.service';
import { JobStatusController } from './job-status.controller';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { IamModule } from '../iam/iam.module';

/**
 * JOBS — HTTP entrypoints for scheduled work.
 *
 * The underlying services are consumed from their owning modules (never
 * re-provided) so the jobs share the exact same singleton instances — and
 * therefore the same repositories — as the rest of the app.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([JobRun]),
    WorkflowModule,
    BillingModule,
    QueueModule,
    TasksModule,
    NotificationsModule,
    AnalyticsModule,
    AuditModule,
    AiModule,
    IamModule,
  ],
  // JobStatusController FIRST: JobsController declares @Get(':job'), and
  // Express matches in registration order, so a later registration would
  // have "status" swallowed as a job name.
  controllers: [JobStatusController, JobsController],
  providers: [CronSecretGuard, MigrateService, JobRunService],
})
export class JobsModule {}
