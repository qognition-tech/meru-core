import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One record's progress through one `messaging.sequences[]` entry.
 *
 * A sequence without enrolment state is a mailing loop: every pass re-sends
 * step 1 to everyone who still matches the trigger. This row is what makes
 * "step 2 goes out 24 hours after enrolment" mean anything, and what makes a
 * stop condition final rather than a pause until the next sweep.
 *
 * `stepsSent` counts rather than lists, because delays are measured from
 * `enrolledAt` (see the schema note on `afterHours`): a slipped sweep must not
 * cascade the whole schedule forward, so the runner asks "which steps are due
 * by now?" rather than "what came after the last one?".
 */
@Entity('sequence_enrolments')
@Index(['tenantId'])
// The runner's hot path, and the upsert key: one enrolment per record per
// sequence, so two overlapping sweeps cannot enrol the same client twice.
@Index(['tenantId', 'sequenceKey', 'entityId'], { unique: true })
@Index(['tenantId', 'stoppedAt'])
export class SequenceEnrolment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** `messaging.sequences[].key` from the tenant's config pack. */
  @Column({ type: 'varchar', length: 100 })
  sequenceKey: string;

  @Column({ type: 'uuid' })
  entityId: string;

  @Column({ type: 'varchar', length: 50 })
  entityType: string;

  /** Every delay in the sequence is measured from here. */
  @Column({ type: 'timestamptz' })
  enrolledAt: Date;

  @Column({ type: 'int', default: 0 })
  stepsSent: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastSentAt: Date | null;

  /**
   * Set once the sequence ends. Non-null means the runner will never touch
   * this row again, which is the difference between a stop condition and a
   * pause.
   */
  @Column({ type: 'timestamptz', nullable: true })
  stoppedAt: Date | null;

  /**
   * Why it stopped — `completed`, `stop_condition`, `trigger_cleared`,
   * `max_messages`, `replied`. Kept because "why did this client stop getting
   * the reminders?" is otherwise unanswerable, and the usual reason someone
   * asks is that they should not have stopped.
   */
  @Column({ type: 'varchar', length: 40, nullable: true })
  stopReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
