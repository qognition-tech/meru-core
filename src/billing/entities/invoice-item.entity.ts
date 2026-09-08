import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Invoice } from './invoice.entity';

export enum InvoiceItemType {
  SUBSCRIPTION = 'subscription',
  METERED = 'metered',
  CREDIT = 'credit',
  TAX = 'tax',
  DISCOUNT = 'discount',
}

@Entity('invoice_items')
export class InvoiceItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  invoiceId: string;

  @ManyToOne(() => Invoice, (invoice) => invoice.items)
  @JoinColumn({ name: 'invoiceId' })
  invoice: Invoice;

  @Column({ type: 'enum', enum: InvoiceItemType })
  type: InvoiceItemType;

  @Column()
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 1 })
  quantity: number;

  @Column({ type: 'decimal', precision: 10, scale: 4 })
  unitPrice: number;

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    usageRecordId?: string;
    metricName?: string;
    periodStart?: Date;
    periodEnd?: Date;
  };

  @CreateDateColumn()
  createdAt: Date;
}
