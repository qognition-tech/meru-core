export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRYING = 'retrying',
  CANCELLED = 'cancelled',
  SCHEDULED = 'scheduled',
}

export enum JobPriority {
  CRITICAL = 1,
  HIGH = 2,
  NORMAL = 3,
  LOW = 4,
  BACKGROUND = 5,
}

export enum JobType {
  // AI Jobs
  AI_ANALYSIS = 'ai:analysis',
  AI_EMBEDDING = 'ai:embedding',
  AI_SUMMARIZE = 'ai:summarize',
  AI_CLASSIFY = 'ai:classify',

  // Document Jobs
  DOCUMENT_PROCESS = 'document:process',
  DOCUMENT_CONVERT = 'document:convert',
  DOCUMENT_OCR = 'document:ocr',
  DOCUMENT_VIRUS_SCAN = 'document:virus_scan',

  // Notification Jobs
  EMAIL_SEND = 'email:send',
  SMS_SEND = 'sms:send',
  PUSH_SEND = 'push:send',
  WEBHOOK_CALL = 'webhook:call',

  // Data Jobs
  DATA_EXPORT = 'data:export',
  DATA_IMPORT = 'data:import',
  DATA_SYNC = 'data:sync',
  DATA_CLEANUP = 'data:cleanup',

  // Report Jobs
  REPORT_GENERATE = 'report:generate',
  REPORT_DISTRIBUTE = 'report:distribute',

  // Billing Jobs
  BILLING_INVOICE = 'billing:invoice',
  BILLING_REMINDER = 'billing:reminder',

  // Maintenance Jobs
  BACKUP_CREATE = 'backup:create',
  CACHE_CLEAR = 'cache:clear',
  INDEX_REBUILD = 'index:rebuild',
  AUDIT_ARCHIVE = 'audit:archive',
}

export interface JobData {
  tenantId?: string;
  userId?: string;
  payload: Record<string, any>;
  metadata?: {
    source?: string;
    correlationId?: string;
    tags?: string[];
  };
}

export interface JobResult {
  success: boolean;
  data?: any;
  error?: string;
  warnings?: string[];
  metrics?: {
    durationMs: number;
    attempts: number;
    memoryPeakMb?: number;
  };
}

export interface JobOptions {
  priority?: JobPriority;
  delay?: number; // Delay in milliseconds
  attempts?: number; // Max retry attempts
  backoff?: {
    type: 'fixed' | 'exponential';
    delay: number;
  };
  timeout?: number; // Job timeout in milliseconds
  removeOnComplete?: boolean | number; // Remove job after completion
  removeOnFail?: boolean | number; // Remove job after failure
  repeat?: {
    cron?: string;
    every?: number;
    limit?: number;
    endDate?: Date;
  };
}

export interface JobProgress {
  step: number;
  totalSteps: number;
  percentage: number;
  message?: string;
  metadata?: Record<string, any>;
}

export interface JobFilter {
  tenantId?: string;
  status?: JobStatus | JobStatus[];
  type?: JobType | JobType[];
  userId?: string;
  priority?: JobPriority;
  createdAfter?: Date;
  createdBefore?: Date;
  tags?: string[];
}

export interface QueueMetrics {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  byType: Record<
    string,
    {
      active: number;
      completed: number;
      failed: number;
      avgDuration: number;
    }
  >;
}

