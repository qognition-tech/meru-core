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
import { Subscription } from './subscription.entity';

export enum BillingModel {
  SUBSCRIPTION = 'subscription',
  METERED = 'metered',
  HYBRID = 'hybrid',
}

export enum PlanInterval {
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
}

export enum PlanStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ARCHIVED = 'archived',
}

@Entity('billing_plans')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'billingModel'])
export class BillingPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'enum', enum: BillingModel })
  billingModel: BillingModel;

  @Column({ type: 'enum', enum: PlanInterval, default: PlanInterval.MONTHLY })
  interval: PlanInterval;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  basePrice: number;

  @Column({ type: 'enum', enum: PlanStatus, default: PlanStatus.ACTIVE })
  status: PlanStatus;

  @Column({ type: 'jsonb', default: {} })
  features: {
    included: string[];
    limits: Record<string, number>; // e.g., { 'users': 10, 'storage_gb': 100 }
  };

  @Column({ type: 'jsonb', default: {} })
  meteredPricing: {
    enabled: boolean;
    metrics: Array<{
      name: string;
      unit: string;
      pricePerUnit: number;
      freeTier: number;
    }>;
  };

  @Column({ type: 'jsonb', default: {} })
  taxConfig: {
    taxable: boolean;
    taxCategory: string;
    vatRate?: number;
    gstRate?: number;
  };

  @OneToMany(() => Subscription, (subscription) => subscription.plan)
  subscriptions: Subscription[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
