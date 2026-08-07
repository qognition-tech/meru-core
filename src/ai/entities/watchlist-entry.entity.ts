import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A sanctions/PEP list record, ingested from an official source.
 *
 * Platform-global, exactly like vessel positions: the OFAC SDN list is the
 * same list for every tenant, and duplicating ~17k rows per tenant would be
 * both wasteful and wrong — a tenant cannot have its own version of a
 * government designation. Tenant-specific entries belong in a custom
 * watchlist passed on the screening request instead.
 */
@Entity('watchlist_entries')
@Index(['listSource'])
@Index(['normalizedName'])
@Index(['listSource', 'externalId'], { unique: true })
export class WatchlistEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Identifier within the source list (OFAC uid, UN dataid). */
  @Column({ length: 100 })
  externalId: string;

  @Column({ length: 50 })
  listSource: string;

  @Column({ type: 'text' })
  name: string;

  /**
   * Case-folded, punctuation-stripped name. Indexed so a candidate can be
   * cheaply narrowed before the expensive fuzzy comparisons run — screening
   * ~17k OFAC rows through Jaro-Winkler on every request would not meet the
   * sub-200ms p95 target in CLAUDE.md §3.2.
   */
  @Column({ type: 'text' })
  normalizedName: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  aliases: string[];

  @Column({ length: 30, default: 'individual' })
  entityType: string;

  @Column({ length: 2, nullable: true })
  country: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  programs: string[];

  @Column({ type: 'text', nullable: true })
  remarks: string | null;

  /** When this row was last confirmed present in the source feed. */
  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
