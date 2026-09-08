import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { BillingPlan } from './billing-plan.entity';
import { UsageRecord } from './usage-record.entity';
import { Invoice } from './invoice.entity';
import { CreditLedger } from './credit-ledger.entity';

export enum SubscriptionStatus {
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
  TRIALING = 'trialing',
}

@Entity('subscriptions')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'entityId'])
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  entityId: string; // Can be tenant, user, or any billable entity

  @Column()
  entityType: string; // 'tenant', 'user', 'workflow', etc.

  @Column()
  planId: string;

  @ManyToOne(() => BillingPlan)
  @JoinColumn({ name: 'planId' })
  plan: BillingPlan;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    default: SubscriptionStatus.TRIALING,
  })
  status: SubscriptionStatus;

  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt: Date | null;

  @Column({ type: 'timestamp' })
  currentPeriodStart: Date;

  @Column({ type: 'timestamp' })
  currentPeriodEnd: Date;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  endedAt: Date;

  @Column({ type: 'jsonb', default: {} })
  usage: {
    [metric: string]: {
      current: number;
      limit: number;
      resetDate: Date;
    };
  };

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    paymentMethodId?: string;
    billingEmail?: string;
    billingAddress?: Record<string, any>;
    taxId?: string;
  };

  @OneToMany(() => UsageRecord, (usage) => usage.subscription)
  usageRecords: UsageRecord[];

  @OneToMany(() => Invoice, (invoice) => invoice.subscription)
  invoices: Invoice[];

  @OneToMany(() => CreditLedger, (credit) => credit.subscription)
  creditLedger: CreditLedger[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
