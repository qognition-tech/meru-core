import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum NotificationType {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  IN_APP = 'in_app',
  SLACK = 'slack',
  TEAMS = 'teams',
  WEBHOOK = 'webhook',
}

export enum NotificationStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
  RETRYING = 'retrying',
  CANCELLED = 'cancelled',
}

export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum NotificationCategory {
  SYSTEM = 'system',
  WORKFLOW = 'workflow',
  TASK = 'task',
  BILLING = 'billing',
  SECURITY = 'security',
  MARKETING = 'marketing',
  COLLABORATION = 'collaboration',
}

@Entity('notifications')
@Index(['tenantId', 'recipientId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'type'])
@Index(['tenantId', 'category'])
@Index(['tenantId', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ type: 'enum', enum: NotificationType })
  type: NotificationType;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
  })
  status: NotificationStatus;

  @Column({
    type: 'enum',
    enum: NotificationPriority,
    default: NotificationPriority.NORMAL,
  })
  priority: NotificationPriority;

  @Column({
    type: 'enum',
    enum: NotificationCategory,
    default: NotificationCategory.SYSTEM,
  })
  category: NotificationCategory;

  @Column()
  recipientId: string;

  @Column({ nullable: true })
  recipientEmail: string;

  @Column({ nullable: true })
  recipientPhone: string;

  @Column()
  subject: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'text', nullable: true })
  htmlContent: string;

  @Column({ type: 'jsonb', default: {} })
  templateData: {
    templateId?: string;
    variables?: Record<string, any>;
    locale?: string;
  };

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    actionUrl?: string;
    actionLabel?: string;
    icon?: string;
    imageUrl?: string;
    tags?: string[];
    customData?: Record<string, any>;
  };

  @Column({ type: 'jsonb', default: {} })
  deliveryAttempts: Array<{
    timestamp: Date;
    channel: string;
    status: string;
    error?: string;
    response?: any;
  }>;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'timestamp', nullable: true })
  scheduledAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  sentAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  readAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('notification_preferences')
@Index(['tenantId', 'userId'])
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'jsonb', default: {} })
  channels: {
    email?: { enabled: boolean; address?: string; verified?: boolean };
    sms?: { enabled: boolean; phoneNumber?: string; verified?: boolean };
    push?: { enabled: boolean; tokens?: string[] };
    inApp?: { enabled: boolean; soundEnabled?: boolean; showPreview?: boolean };
    slack?: { enabled: boolean; webhookUrl?: string };
  };

  @Column({ type: 'jsonb', default: {} })
  categoryPreferences: Record<
    string,
    {
      enabled: boolean;
      channels: NotificationType[];
    }
  >;

  @Column({ type: 'jsonb', default: {}, nullable: true })
  quietHours?: {
    enabled: boolean;
    startTime: string;
    endTime: string;
    timezone: string;
  };

  @Column({ type: 'jsonb', default: {}, nullable: true })
  digestSettings?: {
    enabled: boolean;
    frequency: 'daily' | 'weekly';
    time: string;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

export enum TemplateType {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  IN_APP = 'in_app',
}

@Entity('notification_templates')
@Index(['tenantId', 'key'])
export class NotificationTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column()
  key: string;

  @Column()
  name: string;

  @Column({ type: 'enum', enum: TemplateType })
  type: TemplateType;

  @Column()
  subject: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'text', nullable: true })
  htmlContent?: string;

  @Column({ type: 'jsonb', default: [] })
  variables: string[];

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
