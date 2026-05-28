import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Subscription } from './subscription.entity';

export enum UsageType {
  API_CALL = 'api_call',
  STORAGE = 'storage',
  COMPUTE = 'compute',
  AI_QUERY = 'ai_query',
  DOCUMENT = 'document',
  WORKFLOW = 'workflow',
  SMS = 'sms',
  EMAIL = 'email',
}

@Entity('usage_records')
@Index(['tenantId', 'subscriptionId'])
@Index(['tenantId', 'usageType'])
@Index(['tenantId', 'timestamp'])
export class UsageRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  subscriptionId: string;

  @ManyToOne(() => Subscription, (subscription) => subscription.usageRecords)
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription;

  @Column({ type: 'enum', enum: UsageType })
  usageType: UsageType;

  @Column()
  quantity: number;

  @Column({ type: 'decimal', precision: 10, scale: 4 })
  unitPrice: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    resourceId?: string;
    resourceType?: string;
    region?: string;
    tags?: string[];
  };

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @Column({ default: false })
  invoiced: boolean;

  @Column({ type: 'uuid', nullable: true })
  invoiceId: string;

  @CreateDateColumn()
  createdAt: Date;
}
