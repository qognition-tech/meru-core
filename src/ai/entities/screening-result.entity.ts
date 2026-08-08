import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The record that a name was screened, and what came back.
 *
 * `/engines/screening` was a pure function: it answered and forgot. That is
 * fine for a one-off check and useless for compliance, because it makes two
 * questions unanswerable — "what did we know, and when did we know it?" (the
 * question a regulator actually asks) and "who needs re-checking now the list
 * has changed?".
 *
 * The second is the dangerous one. Sanctions lists change daily; a name that
 * screened clear last month can be designated today. Without a record of who
 * was screened, nobody can be re-screened, and the platform keeps reporting a
 * clear result that has quietly expired.
 */
@Entity('screening_results')
@Index(['tenantId'])
@Index(['tenantId', 'entityId'])
@Index(['tenantId', 'status'])
// Drives the rescreen sweep: find rows screened before the watchlist changed.
@Index(['tenantId', 'screenedAt'])
export class ScreeningResult {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** Engine-issued id (`scr_…`), kept so a UI can cite the exact screening. */
  @Column({ type: 'varchar', length: 60 })
  screeningId: string;

  /** The record screened, when the caller supplied one. */
  @Column({ type: 'uuid', nullable: true })
  entityId: string | null;

  @Column({ type: 'text' })
  entityName: string;

  @Column({ type: 'varchar', length: 30 })
  entityType: string;

  @Column({ type: 'varchar', length: 30 })
  status: string;

  @Column({ type: 'int', default: 0 })
  riskScore: number;

  @Column({ type: 'varchar', length: 20 })
  riskLevel: string;

  @Column({ type: 'int', default: 0 })
  hitCount: number;

  /** Full hit payload, so a later review sees what the engine saw. */
  @Column({ type: 'jsonb', default: [] })
  hits: unknown[];

  /**
   * The screening request, minus any custom watchlist. Replaying a screening
   * needs the same names and types it ran with; re-deriving them from the
   * entity later would silently screen something different.
   */
  @Column({ type: 'jsonb', default: {} })
  request: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  screenedAt: Date;

  /**
   * How many watchlist rows the engine held at the time.
   *
   * Stored because zero is not a clear result — it means the lists were never
   * ingested and a genuinely sanctioned name could not have matched. A UI that
   * cannot distinguish "no hits" from "nothing to hit against" will show a
   * green tick for an unscreened person.
   */
  @Column({ type: 'int', default: 0 })
  watchlistSize: number;

  /** True when produced by the rescreen sweep rather than a user action. */
  @Column({ type: 'boolean', default: false })
  isRescreen: boolean;

  /**
   * Set on a rescreen whose status differs from the previous result. This is
   * the field the whole feature exists to produce: `clear` → `hit` means
   * somebody the firm has already onboarded has since been designated.
   */
  @Column({ type: 'varchar', length: 30, nullable: true })
  previousStatus: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
