import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled',
}

/**
 * What a firm's **client** owes the **firm** — a visa application fee, a
 * consultation, a disbursement.
 *
 * This is not BILL. BILL (`subscriptions`, `invoices`, `usage_records`) is
 * Meru charging the firm for the platform. This table is the firm charging
 * the people it acts for, and the two must never be conflated: they have
 * different payers, different payees, and different money. Reusing BILL for
 * this is what made `/billing/checkout` — which buys the *firm's* Meru tier —
 * look like it could serve a client portal.
 */
@Entity('payments')
@Index(['tenantId'])
@Index(['tenantId', 'clientId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'entityId'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /**
   * `users.id` of the client who owes this. Load-bearing for authorisation,
   * not just display: RLS separates tenants but not users within one, so this
   * is what stops one applicant reading another's ledger. Not an FK — a
   * deprovisioned user must not orphan a financial record.
   */
  @Column({ type: 'uuid' })
  clientId: string;

  /** Optional `universal_entities.id` — the case/matter this relates to. */
  @Column({ type: 'uuid', nullable: true })
  entityId: string | null;

  /**
   * Minor units (cents, fils, pence). Integer, never a float or a numeric
   * mapped through JS — 0.1 + 0.2 is not 0.3, and a rounding error in a
   * regulated ledger is a reportable incident rather than a bug.
   */
  @Column({ type: 'bigint' })
  amountMinor: string;

  /** ISO-4217, uppercase. */
  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  @Column({ type: 'varchar', length: 300 })
  description: string;

  /** Human-facing reference the firm quotes to its client. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  reference: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  dueDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  /**
   * Stripe Checkout Session id. Unique so a webhook replay — Stripe retries,
   * and at-least-once delivery is the contract — cannot mark one payment paid
   * twice or double-count revenue.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index({ unique: true, where: '"providerRef" IS NOT NULL' })
  providerRef: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
