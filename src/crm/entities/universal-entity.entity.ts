import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

// CRM polymorphism per CLAUDE.md §2 row 3.
// One table, many types. Type-specific fields go in verticalAttributes (jsonb).
// Examples:
//   type=NOTE     → verticalAttributes: { content, parentEntityType, parentEntityId, ... }
//   type=TAG      → verticalAttributes: { name, color, ... }
//   type=ASSET    → verticalAttributes: { kind, identifier, ... }
//
// Cross-type queries are jsonb queries. If a field needs an index for perf,
// lift it to a top-level column with a partial index — which is what the
// status/dueDate/assignedTo trio below now is.
export enum EntityType {
  PERSON = 'person',
  ORGANIZATION = 'organization',
  CASE = 'case',
  NOTE = 'note',
  TAG = 'tag',
  ASSET = 'asset',
  /**
   * A regulatory commitment the tenant has to meet by a date. GovernanceX
   * renders these as "Obligations"; the label, the status vocabulary and the
   * fields shown all come from the vertical's config pack, not from here.
   */
  OBLIGATION = 'obligation',
  /**
   * A recorded failure to meet an obligation or control. GovernanceX renders
   * these as "Breaches". Same rule: naming and workflow live in the pack.
   */
  BREACH = 'breach',
}

/**
 * Generic lifecycle states shared by every workable entity type.
 *
 * Deliberately vertical-neutral: a vertical maps its own vocabulary onto these
 * in its config pack (GovernanceX's OPEN/REMEDIATION/CLOSED, ImmiStack's kanban
 * columns) rather than core learning either. Anything finer-grained than this
 * belongs in `verticalAttributes`.
 */
export enum EntityStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  BLOCKED = 'blocked',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
  CANCELLED = 'cancelled',
}

@Entity('universal_entities')
@Index(['tenantId'])
@Index(['tenantId', 'email'])
@Index(['tenantId', 'type'])
// Workboard reads: "my open obligations by due date", "this tenant's breaches
// by status". Both filter on type + one of these, so they get real indexes.
@Index(['tenantId', 'type', 'status'])
@Index(['tenantId', 'assignedTo'])
@Index(['tenantId', 'dueDate'])
export class UniversalEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ type: 'enum', enum: EntityType })
  type: EntityType;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  phoneNumber: string;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  //
  // Promoted out of `verticalAttributes` to real columns. Every workable entity
  // type — case, obligation, breach — needs to be filtered and sorted by these,
  // and a jsonb predicate cannot use an index the way a column can. They stay
  // generic on purpose: no GRC or immigration vocabulary reaches core, only the
  // shape those verticals map onto (CLAUDE.md §11.3).
  //
  // Null for types that are not workable (tag, note, plain person).

  @Column({ type: 'enum', enum: EntityStatus, nullable: true })
  status: EntityStatus | null;

  @Column({ type: 'timestamptz', nullable: true })
  dueDate: Date | null;

  /** `users.id` of the current owner. Not an FK — a user can be deprovisioned
   *  without orphaning the record's history. */
  @Column({ type: 'uuid', nullable: true })
  assignedTo: string | null;

  @Column({ type: 'jsonb', default: {} })
  verticalAttributes: Record<string, any>;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'jsonb', default: [] })
  relationships: Array<{ id: string; type: string }>;

  @Column({ default: 'immigration' })
  vertical: string;

  @Column({ default: 'production' })
  environment: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}
