import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Last-run state for each scheduled job — one row per job, upserted.
 *
 * Platform-global, not tenant-scoped: these jobs sweep every tenant, so "when
 * did the sanctions list last ingest" is a property of the platform.
 *
 * This exists because the cadence map it replaces was a per-instance `Map`,
 * and every serverless invocation is a fresh process. Two consequences, both
 * bad: the God UI could not be told when anything last ran (it would have had
 * to render "never", forever), and cadence was not actually enforced — a cold
 * start believed nothing had run, so a daily job could re-run on every cold
 * boot rather than once a day.
 *
 * A status row rather than an append-only log: the question being answered is
 * "is this job healthy right now", and an unbounded history costs storage to
 * answer it. Failures keep their message so a red tile can say why.
 */
@Entity('job_runs')
export class JobRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 60 })
  @Index({ unique: true })
  jobName: string;

  @Column({ type: 'timestamptz' })
  lastRunAt: Date;

  /** 'ok' | 'failed' — kept as text so a new outcome needs no migration. */
  @Column({ type: 'varchar', length: 20 })
  lastStatus: string;

  @Column({ type: 'int', default: 0 })
  lastDurationMs: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /** When this job last completed successfully — not the same as lastRunAt. */
  @Column({ type: 'timestamptz', nullable: true })
  lastSuccessAt: Date | null;

  @Column({ type: 'int', default: 0 })
  runCount: number;

  @Column({ type: 'int', default: 0 })
  failCount: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
