import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * A typed edge between two `universal_entities` rows.
 *
 * Replaces the jsonb `relationships` array on the entity itself, which had
 * three problems that only a table fixes: it was one-directional (nothing
 * could ask "what blocks this?", only "what does this block"), it could not be
 * indexed or joined, and the `type` string was free text no pack ever
 * validated — so a typo produced an edge that existed but matched no
 * definition.
 *
 * The jsonb column is left in place and still written by the old
 * `addRelationship` path; this table is additive. Migrating the existing data
 * needs the pack's `relationships[]` to be authored for the edge types already
 * in use, which is Phase C work.
 *
 * Document relationships, task and milestone dependencies, and counterparty
 * links are all this one shape (docs/FEATURE_PARITY_MAP.md §5, item 7).
 */
@Entity('entity_relations')
@Index(['tenantId'])
// The two traversal directions. Both indexed, because "what does this block"
// and "what blocks this" are asked equally often and the second is the one the
// jsonb array could not answer at all.
@Index(['tenantId', 'fromId'])
@Index(['tenantId', 'toId'])
@Index(['tenantId', 'relationKey', 'fromId', 'toId'], { unique: true })
export class EntityRelation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** `relationships[].key` from the tenant's config pack. */
  @Column({ type: 'varchar', length: 100 })
  relationKey: string;

  @Column({ type: 'uuid' })
  fromId: string;

  @Column({ type: 'varchar', length: 50 })
  fromType: string;

  @Column({ type: 'uuid' })
  toId: string;

  @Column({ type: 'varchar', length: 50 })
  toType: string;

  /** `users.id` of whoever created the link. Not an FK — see Payment.clientId. */
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
