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

export enum CreditTransactionType {
  PURCHASE = 'purchase',
  USAGE = 'usage',
  REFUND = 'refund',
  BONUS = 'bonus',
  EXPIRED = 'expired',
  ADJUSTMENT = 'adjustment',
}

@Entity('credit_ledger')
@Index(['tenantId', 'subscriptionId'])
@Index(['tenantId', 'transactionType'])
export class CreditLedger {
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

  @ManyToOne(() => Subscription, (subscription) => subscription.creditLedger)
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription;

  @Column({ type: 'enum', enum: CreditTransactionType })
  transactionType: CreditTransactionType;

  @Column({ type: 'decimal', precision: 15, scale: 4 })
  amount: number; // Positive for credits added, negative for usage

  @Column({ type: 'decimal', precision: 15, scale: 4 })
  balance: number; // Running balance after this transaction

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    paymentId?: string;
    invoiceId?: string;
    usageRecordId?: string;
    expiryDate?: Date;
    promotionCode?: string;
  };

  @Column({ type: 'timestamp', nullable: true })
  expiryDate: Date;

  @CreateDateColumn()
  createdAt: Date;
}
