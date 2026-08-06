import { User } from '../iam/entities/user.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { TenantSetting } from '../tenant/entities/tenant-setting.entity';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { SearchIndex } from '../search/entities/search-index.entity';
import { AiPrompt, AiEmbedding } from '../ai/entities/ai-prompt.entity';
import { Role } from '../iam/entities/role.entity';
import { Session } from '../iam/entities/session.entity';
import { AuthToken } from '../iam/entities/auth-token.entity';
import { ApiKey } from '../iam/entities/api-key.entity';
import { TenantConfigPin } from '../iam/entities/tenant-config-pin.entity';
import { ConfigPack } from '../tenant/entities/config-pack.entity';
import { FeatureFlag } from '../tenant/entities/feature-flag.entity';
import { IntegrationAdapter } from '../integrations/entities/integration-adapter.entity';
import { Document } from '../documents/entities/document.entity';
import { DocumentVersion } from '../documents/entities/document-version.entity';
import { DocumentMetadata } from '../documents/entities/document-metadata.entity';
import { Workflow } from '../workflow/entities/workflow.entity';
import { WorkflowState } from '../workflow/entities/workflow-state.entity';
import { WorkflowTransition } from '../workflow/entities/workflow-transition.entity';
import { WorkflowInstance } from '../workflow/entities/workflow-instance.entity';
import { FormSchema } from '../forms/entities/form-schema.entity';
import { FormField } from '../forms/entities/form-field.entity';
import { FormSubmission } from '../forms/entities/form-submission.entity';
import { Task } from '../tasks/entities/task.entity';
import { TaskComment } from '../tasks/entities/task-comment.entity';
import { RecurringJob } from '../tasks/entities/recurring-job.entity';
import { BillingPlan } from '../billing/entities/billing-plan.entity';
import { Subscription } from '../billing/entities/subscription.entity';
import { UsageRecord } from '../billing/entities/usage-record.entity';
import { CreditLedger } from '../billing/entities/credit-ledger.entity';
import { Invoice } from '../billing/entities/invoice.entity';
import { InvoiceItem } from '../billing/entities/invoice-item.entity';
import { Report } from '../analytics/entities/report.entity';
import { ReportExecution } from '../analytics/entities/report-execution.entity';
import { DashboardWidget } from '../analytics/entities/dashboard-widget.entity';
import { AgentRun } from '../orchestration/entities/agent-run.entity';
import { VesselPosition } from '../integrations/entities/vessel-position.entity';
import { TenantConnector } from '../integrations/entities/tenant-connector.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import {
  Notification,
  NotificationPreference,
  NotificationTemplate,
} from '../notifications/entities/notification.entity';
import {
  StorageFile,
  FileVersion,
  MultipartUpload,
} from '../storage/entities/storage-file.entity';
import {
  QueueJob,
  QueueJobLog,
  QueueScheduledJob,
  QueueWorker,
} from '../queue/entities/job.entity';
import {
  ElasticsearchIndex,
  ElasticsearchDocument,
  ElasticsearchSearchLog,
} from '../search/elasticsearch/entities/search-index.entity';

/**
 * The single authoritative entity catalogue. app.module's default DataSource
 * and every per-vertical DataSource (core/tenancy/vertical-datasources) load
 * exactly this list — the schemas of the meru/govx/immistack databases must
 * not drift, and two hand-maintained lists would. Explicit list rather than a
 * glob because Vercel's bundler cannot resolve runtime globs.
 */
export const ALL_ENTITIES = [
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
  VesselPosition,
  TenantConnector,
  // Search & AI
  SearchIndex,
  AiPrompt,
  AiEmbedding,
  // Documents
  Document,
  DocumentVersion,
  DocumentMetadata,
  // Workflow
  Workflow,
  WorkflowState,
  WorkflowTransition,
  WorkflowInstance,
  // Forms
  FormSchema,
  FormField,
  FormSubmission,
  // Tasks
  Task,
  TaskComment,
  RecurringJob,
  // Billing
  BillingPlan,
  Subscription,
  UsageRecord,
  CreditLedger,
  Invoice,
  InvoiceItem,
  // Analytics
  Report,
  ReportExecution,
  DashboardWidget,
  // Audit
  AuditLog,
  // Orchestration
  AgentRun,
  // Notifications
  Notification,
  NotificationPreference,
  NotificationTemplate,
  // Storage
  StorageFile,
  FileVersion,
  MultipartUpload,
  // Queue
  QueueJob,
  QueueJobLog,
  QueueScheduledJob,
  QueueWorker,
  // Elasticsearch
  ElasticsearchIndex,
  ElasticsearchDocument,
  ElasticsearchSearchLog,
];
