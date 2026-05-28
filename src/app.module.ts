import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppConfigModule } from './config/config.module';
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

import { User } from './iam/entities/user.entity';
import { Tenant } from './iam/entities/tenant.entity';
import { TenantSetting } from './tenant/entities/tenant-setting.entity';
import { UniversalEntity } from './crm/entities/universal-entity.entity';
import { SearchIndex } from './search/entities/search-index.entity';
import { AiPrompt, AiEmbedding } from './ai/entities/ai-prompt.entity';

// IAM entities (new)
import { Role } from './iam/entities/role.entity';
import { Session } from './iam/entities/session.entity';
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

// Audit entities
import { AuditLog } from './audit/entities/audit-log.entity';

// Notifications entities
import { Notification, NotificationPreference, NotificationTemplate } from './notifications/entities/notification.entity';

// Storage entities
import { StorageFile, FileVersion, MultipartUpload } from './storage/entities/storage-file.entity';

// Queue entities
import { QueueJob, QueueJobLog, QueueScheduledJob, QueueWorker } from './queue/entities/job.entity';

// Elasticsearch entities (driver layer under SRCH module)
import { ElasticsearchIndex, ElasticsearchDocument, ElasticsearchSearchLog } from './search/elasticsearch/entities/search-index.entity';

@Module({
  imports: [
    // 1. Configuration & Validation
    AppConfigModule,

    // 2. Event Emitter for @OnEvent decorators
    EventEmitterModule.forRoot(),

    // 3. Database Setup (Connecting all modules)
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: ConfigService): any => {
        const isDevelopment = configService.get('NODE_ENV') === 'development';

        return {
          type: 'postgres' as const,
          host: configService.get('database.host'),
          port: configService.get('database.port'),
          username: configService.get('database.username'),
          password: configService.get('database.password'),
          database: configService.get('database.name'),

          // CRITICAL: All entities from all modules must be listed here
          // so TypeORM can manage them and create tables (if synchronize: true)
          entities: [
            // IAM
            User,
            Tenant,
            Role,
            Session,
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
  ],
})
export class AppModule {}
