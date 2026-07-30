import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { TenancyModule } from './core/tenancy/tenancy.module';
import { MailModule } from './core/mail/mail.module';
import { TenantAlsMiddleware } from './core/tenancy/tenant-als.middleware';
import { TenantBindingInterceptor } from './core/tenancy/tenant-binding.interceptor';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IamModule } from './iam/iam.module';
import { TenantModule } from './tenant/tenant.module';
import { CrmModule } from './crm/crm.module';
import { SearchModule } from './search/search.module';
import { AiModule } from './ai/ai.module';
import { OrchestrationModule } from './orchestration/orchestration.module';

import { DocumentsModule } from './documents/documents.module';
import { WorkflowModule } from './workflow/workflow.module';
import { FormsModule } from './forms/forms.module';
import { TasksModule } from './tasks/tasks.module';
import { BillingModule } from './billing/billing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { QueueModule } from './queue/queue.module';
import { ElasticsearchModule } from './search/elasticsearch/elasticsearch.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';

import { User } from './iam/entities/user.entity';
import { Tenant } from './iam/entities/tenant.entity';
import { TenantSetting } from './tenant/entities/tenant-setting.entity';
import { UniversalEntity } from './crm/entities/universal-entity.entity';
import { SearchIndex } from './search/entities/search-index.entity';
import { AiPrompt, AiEmbedding } from './ai/entities/ai-prompt.entity';

// IAM entities (new)
import { Role } from './iam/entities/role.entity';
import { Session } from './iam/entities/session.entity';
import { AuthToken } from './iam/entities/auth-token.entity';
import { ApiKey } from './iam/entities/api-key.entity';
import { TenantConfigPin } from './iam/entities/tenant-config-pin.entity';

// TCM entities (Tenant Config Management — lives under src/tenant per CLAUDE.md §2)
import { ConfigPack } from './tenant/entities/config-pack.entity';
import { FeatureFlag } from './tenant/entities/feature-flag.entity';

// Integration entity (new)
import { IntegrationAdapter } from './integrations/entities/integration-adapter.entity';

import { Document } from './documents/entities/document.entity';
import { DocumentVersion } from './documents/entities/document-version.entity';
import { DocumentMetadata } from './documents/entities/document-metadata.entity';

// Workflow entities
import { Workflow } from './workflow/entities/workflow.entity';
import { WorkflowState } from './workflow/entities/workflow-state.entity';
import { WorkflowTransition } from './workflow/entities/workflow-transition.entity';
import { WorkflowInstance } from './workflow/entities/workflow-instance.entity';

// Forms entities
import { FormSchema } from './forms/entities/form-schema.entity';
import { FormField } from './forms/entities/form-field.entity';
import { FormSubmission } from './forms/entities/form-submission.entity';

// Tasks entities
import { Task } from './tasks/entities/task.entity';
import { TaskComment } from './tasks/entities/task-comment.entity';
import { RecurringJob } from './tasks/entities/recurring-job.entity';

// Billing entities
import { BillingPlan } from './billing/entities/billing-plan.entity';
import { Subscription } from './billing/entities/subscription.entity';
import { UsageRecord } from './billing/entities/usage-record.entity';
import { CreditLedger } from './billing/entities/credit-ledger.entity';
import { Invoice } from './billing/entities/invoice.entity';
import { InvoiceItem } from './billing/entities/invoice-item.entity';

// Analytics entities
import { Report } from './analytics/entities/report.entity';
import { ReportExecution } from './analytics/entities/report-execution.entity';
import { DashboardWidget } from './analytics/entities/dashboard-widget.entity';

// Orchestration entities
import { AgentRun } from './orchestration/entities/agent-run.entity';
import { VesselPosition } from './integrations/entities/vessel-position.entity';

// Audit entities
import { AuditLog } from './audit/entities/audit-log.entity';

// Notifications entities
import {
  Notification,
  NotificationPreference,
  NotificationTemplate,
} from './notifications/entities/notification.entity';

// Storage entities
import {
  StorageFile,
  FileVersion,
  MultipartUpload,
} from './storage/entities/storage-file.entity';

// Queue entities
import {
  QueueJob,
  QueueJobLog,
  QueueScheduledJob,
  QueueWorker,
} from './queue/entities/job.entity';

// Elasticsearch entities (driver layer under SRCH module)
import {
  ElasticsearchIndex,
  ElasticsearchDocument,
  ElasticsearchSearchLog,
} from './search/elasticsearch/entities/search-index.entity';

@Module({
  imports: [
    // 1. Configuration & Validation
    AppConfigModule,

    // 2. Event Emitter for @OnEvent decorators
    EventEmitterModule.forRoot(),

    // 3. Scheduler for @Cron/@Interval decorators
    ScheduleModule.forRoot(),

    // 4. Database Setup (Connecting all modules)
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: ConfigService): any => {
        const isDevelopment = configService.get('NODE_ENV') === 'development';
        const isServerless = !!process.env.VERCEL;

        // Neon hands out a single connection string; prefer it when present and
        // fall back to the discrete vars for local/legacy setups.
        const databaseUrl = configService.get('database.url');
        const connection = databaseUrl
          ? { url: databaseUrl }
          : {
              host: configService.get('database.host'),
              port: configService.get('database.port'),
              username: configService.get('database.username'),
              password: configService.get('database.password'),
              database: configService.get('database.name'),
            };

        return {
          type: 'postgres' as const,
          ...connection,

          // CRITICAL: All entities from all modules must be listed here
          // so TypeORM can manage them and create tables (if synchronize: true)
          entities: [
            // IAM
            User,
            Tenant,
            Role,
            Session,
            AuthToken,
            ApiKey,
            TenantConfigPin,
            TenantSetting,
            // Config
            ConfigPack,
            FeatureFlag,
            // CRM
            UniversalEntity,
            // Integrations
            IntegrationAdapter,
            // Search & AI
            SearchIndex,
            AiPrompt,
            AiEmbedding,
            // Documents
            Document,
            DocumentVersion,
            DocumentMetadata,
            Workflow,
            WorkflowState,
            WorkflowTransition,
            WorkflowInstance,
            FormSchema,
            FormField,
            FormSubmission,
            Task,
            TaskComment,
            RecurringJob,
            BillingPlan,
            Subscription,
            UsageRecord,
            CreditLedger,
            Invoice,
            InvoiceItem,
            Report,
            ReportExecution,
            DashboardWidget,
            AuditLog,

            // Orchestration
            AgentRun,

            // Integrations
            VesselPosition,
            // Notifications entities
            Notification,
            NotificationPreference,
            NotificationTemplate,
            // Storage entities
            StorageFile,
            FileVersion,
            MultipartUpload,
            // Queue entities
            QueueJob,
            QueueJobLog,
            QueueScheduledJob,
            QueueWorker,
            // Elasticsearch entities
            ElasticsearchIndex,
            ElasticsearchDocument,
            ElasticsearchSearchLog,
          ],

          // WARNING: synchronize: true is for DEVELOPMENT ONLY.
          // It automatically creates/updates tables. Disable for Production!
          synchronize: false, // Disabled for production - use migrations

          logging: isDevelopment,
          retryAttempts: isDevelopment ? 3 : 10,
          retryDelay: 3000,
          ssl: { rejectUnauthorized: false },

          // Serverless: every lambda instance gets its own pool, so cap it at 1
          // connection. Without this each cold start opens pg's default pool of
          // 10 and exhausts Neon's connection limit under any real concurrency.
          extra: isServerless
            ? { max: 1, connectionTimeoutMillis: 10000 }
            : { max: 10 },
        };
      },
      inject: [ConfigService],
    }),

    IamModule,
    TenantModule,
    CrmModule,
    SearchModule,
    AiModule,
    OrchestrationModule,
    DocumentsModule,
    WorkflowModule,
    FormsModule,
    TasksModule,
    BillingModule,
    AnalyticsModule,
    AuditModule,
    NotificationsModule,
    StorageModule,
    QueueModule,
    ElasticsearchModule,
    IntegrationsModule,
    HealthModule,
    JobsModule,
    TenancyModule,
    MailModule,
  ],
  // AppController serves GET /api/v1/ (the root status route). It existed but
  // was never registered in any module, so the route 404'd and was missing from
  // the OpenAPI document despite carrying @ApiTags('app').
  controllers: [AppController],
  providers: [
    AppService,
    // Binds the authenticated tenant into the ALS context for every request.
    // Global (rather than per-controller) because a route that silently misses
    // this would run against an unbound connection — CLAUDE.md §6.4 admits no
    // opt-in surface for tenant isolation.
    { provide: APP_INTERCEPTOR, useClass: TenantBindingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must be the outermost middleware: it opens the AsyncLocalStorage context
    // that everything downstream — guards, interceptors, repositories — reads.
    consumer.apply(TenantAlsMiddleware).forRoutes('*');
  }
}
