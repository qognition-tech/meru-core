import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One firm's own price for one `fees[].key` the pack declares `kind: 'firm'`.
 *
 * ADR 0009 §2.4: a government charge and a third-party disbursement are the
 * same number for every tenant of a vertical, by law or by the third party's
 * own price — they stay pack-owned. A firm's **professional** fee is not
 * vertical vocabulary; it is that firm's own commercial price, and declaring
 * it once in the shared pack (`firm_professional_482` at a flat AU$3,500 in
 * `verticals/immigration.json`) quoted every tenant on the base pack the same
 * rate regardless of what they actually charge. This table is the override:
 * present and `active`, it replaces the pack's `amountMinor`/`currency` for
 * that one tenant; absent, the pack default still applies.
 *
 * Deliberately narrow. It cannot name a `government` or `disbursement` fee —
 * `FeeScheduleService` enforces that at write time by consulting the resolved
 * pack, not here — and it cannot touch `paymentPlans[]` structure at all:
 * `stages[].atStep` is workflow vocabulary the loader validates against real
 * step names at load time, and a firm editing it at runtime with no matching
 * step would silently stop a payment gate from ever firing.
 *
 * `updatedBy` stores a `users.id` value, not a `users` foreign key — same
 * reasoning as `Payment.clientId`: a deprovisioned user must not orphan a
 * commercial record that outlives them.
 */
@Entity('tenant_fee_overrides')
@Index(['tenantId'])
@Index(['tenantId', 'feeKey'], { unique: true })
export class TenantFeeOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** Matches a `fees[].key` in the tenant's resolved pack. */
  @Column({ length: 100 })
  feeKey: string;

  /**
   * Minor units. `bigint` mapped through TypeORM as a string, same as
   * `Payment.amountMinor` — never a float through JS arithmetic.
   */
  @Column({ type: 'bigint' })
  amountMinor: string;

  /** ISO-4217, uppercase. */
  @Column({ type: 'varchar', length: 3 })
  currency: string;

  /**
   * Soft toggle kept alongside the row rather than a delete, so "what was
   * this firm charging before" survives a caller reverting to the pack
   * default. `FeeScheduleService` only ever merges an `active: true` row.
   */
  @Column({ default: true })
  active: boolean;

  @Column({ type: 'uuid' })
  updatedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
