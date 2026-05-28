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
//   type=CASE     → verticalAttributes: { caseNumber, status, priority, assignedTo, dueDate, ... }
//   type=NOTE     → verticalAttributes: { content, parentEntityType, parentEntityId, ... }
//   type=TAG      → verticalAttributes: { name, color, ... }
//   type=ASSET    → verticalAttributes: { kind, identifier, ... }
//
// Cross-type queries are jsonb queries. If a field needs an index for perf,
// lift it to a top-level column with a partial index (WHERE type = 'case').
export enum EntityType {
  PERSON = 'person',
  ORGANIZATION = 'organization',
  CASE = 'case',
  NOTE = 'note',
  TAG = 'tag',
  ASSET = 'asset',
}

@Entity('universal_entities')
@Index(['tenantId'])
@Index(['tenantId', 'email'])
@Index(['tenantId', 'type'])
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
