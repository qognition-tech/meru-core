import { MigrateService } from './migrate.service';
import { JobRun } from './entities/job-run.entity';
import { JobRunService } from './job-run.service';
import { JobStatusController } from './job-status.controller';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobsController } from './jobs.controller';
import { PlatformJobsController } from './platform-jobs.controller';
import { JobDispatchService } from './job-dispatch.service';
import { CronSecretGuard } from './cron-secret.guard';
import { WorkflowModule } from '../workflow/workflow.module';
import { RulesModule } from '../rules/rules.module';
import { BillingModule } from '../billing/billing.module';
import { QueueModule } from '../queue/queue.module';
import { TasksModule } from '../tasks/tasks.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditModule } from '../audit/audit.module';
import { AiModule } from '../ai/ai.module';
import { IamModule } from '../iam/iam.module';
import { TenantModule } from '../tenant/tenant.module';
import { TenancyModule } from '../core/tenancy/tenancy.module';

/**
 * JOBS — HTTP entrypoints for scheduled work.
 *
 * The underlying services are consumed from their owning modules (never
 * re-provided) so the jobs share the exact same singleton instances — and
 * therefore the same repositories — as the rest of the app.
 *
 * `TenancyModule` (ADR 0009 §2.3) is for `PlatformJobsController`'s
 * `runAsGod` call. Confirmed acyclic: `TenancyModule` imports only
 * `AuditModule`, already imported here. `TenancyModule` is also `@Global()`,
 * so this import is not strictly load-bearing for DI resolution — it is
 * here for the same "legible graph over relying on globality" reason every
 * other entry in this list is explicit.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([JobRun]),
    WorkflowModule,
    RulesModule,
    BillingModule,
    QueueModule,
    TasksModule,
    NotificationsModule,
    AnalyticsModule,
    AuditModule,
    AiModule,
    IamModule,
    TenantModule,
    TenancyModule,
  ],
  // JobStatusController FIRST: JobsController declares @Get(':job'), and
  // Express matches in registration order, so a later registration would
  // have "status" swallowed as a job name. PlatformJobsController is under a
  // disjoint prefix (platform/jobs) so its position relative to the other
  // two does not matter.
  controllers: [JobStatusController, JobsController, PlatformJobsController],
  providers: [
    CronSecretGuard,
    MigrateService,
    JobRunService,
    // ADR 0009 §2.3 — the one implementation of "run a named job", used by
    // both JobsController's machine routes and PlatformJobsController's
    // human route.
    JobDispatchService,
  ],
})
export class JobsModule {}
