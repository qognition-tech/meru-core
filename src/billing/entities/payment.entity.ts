import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Which way the money moves.
 *
 * `inbound` is what a client owes the firm — the only thing this table could
 * express originally. `outbound` is what the firm pays out on a matter, chiefly
 * the government charge it forwards to the regulator. Both live in one ledger
 * because a matter's financial history is one list, but they must never be
 * summed together: counting forwarded visa fees as income overstates revenue by
 * exactly the amount the firm never earned.
 */
export enum PaymentDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

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
   *
   * Nullable only for `outbound` rows: a firm-level expense has no client, and
   * forcing one would attribute the firm's own costs to whichever applicant
   * happened to be handy.
   */
  @Column({ type: 'uuid', nullable: true })
  clientId: string | null;

  /**
   * Which way the money moves. See PaymentDirection.
   *
   * Defaulted so existing callers keep creating receivables without knowing this
   * field exists.
   */
  @Column({
    type: 'varchar',
    length: 10,
    default: PaymentDirection.INBOUND,
  })
  direction: PaymentDirection;

  /**
   * Who was paid, for `outbound` rows — "Department of Home Affairs".
   *
   * Required for outbound by a database CHECK, not only by a DTO: this table is
   * the record of what the firm spent, and "we paid AUD 3,050.00 to (blank)" is
   * not a record of anything.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  payee: string | null;

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

  /**
   * Whose money this is. `government` is collected on the regulator's behalf
   * and is usually non-refundable and not revenue; `firm` is the firm's own
   * charge; `disbursement` is a third-party cost passed through.
   *
   * Null for a payment recorded by hand rather than expanded from a config
   * pack's `fees[]`.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  feeKind: 'government' | 'firm' | 'disbursement' | null;

  /** `fees[].key` from the pack this was expanded from. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  feeKey: string | null;

  /** `paymentPlans[].key` this instalment belongs to. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  planKey: string | null;

  /**
   * The workflow step this portion is due at. What the payment gate reads:
   * progress past this step is blocked while the portion is unsettled.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  atStep: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
