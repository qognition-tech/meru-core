import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per (tenant, alert rule, entity) that has ever fired.
 *
 * This table is what makes the alert sweep idempotent, and without it the
 * feature is worse than absent. The sweep re-evaluates every rule against
 * every entity on every run; a rule like "visa expires within 30 days" is true
 * on all thirty of those days, so a nightly pass with no memory emails the
 * same person about the same case thirty times. People do not read the
 * thirtieth one — they filter the sender, and then they miss the alert that
 * mattered. `lastNotifiedAt` plus the rule's `cooldownHours` is the whole fix.
 *
 * It also carries escalation state: `firstMatchedAt` is when the condition
 * became true, which is what `escalateAfterHours` measures from, and
 * `escalatedAt` stops a rule escalating on every subsequent pass.
 *
 * Rows persist after the condition clears (`resolvedAt` is set instead of
 * deleting) so that a condition which goes false and true again is a new
 * incident rather than a silent continuation of the old one.
 */
@Entity('alert_firings')
@Index(['tenantId'])
// The sweep's hot path: "have I already fired this rule for this entity?"
@Index(['tenantId', 'ruleKey', 'entityId'], { unique: true })
@Index(['tenantId', 'ruleKey'])
export class AlertFiring {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** `alertRules[].key` from the tenant's config pack. */
  @Column({ type: 'varchar', length: 100 })
  ruleKey: string;

  /** The `universal_entities` row the rule matched. */
  @Column({ type: 'uuid' })
  entityId: string;

  @Column({ type: 'varchar', length: 50 })
  entityType: string;

  /** When the condition first became true — escalation counts from here. */
  @Column({ type: 'timestamptz' })
  firstMatchedAt: Date;

  /** Most recent sweep that saw the condition still true. */
  @Column({ type: 'timestamptz' })
  lastMatchedAt: Date;

  /** Most recent notification actually sent. Null means suppressed so far. */
  @Column({ type: 'timestamptz', nullable: true })
  lastNotifiedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  notifyCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  escalatedAt: Date | null;

  /**
   * When the condition stopped being true. A resolved row is kept as history
   * and re-opened if the condition returns, so "this breached, was fixed, and
   * breached again" is visible rather than looking like one long breach.
   */
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  /** The task opened for this alert, when the rule asks for one. */
  @Column({ type: 'uuid', nullable: true })
  taskId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
