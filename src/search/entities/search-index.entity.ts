import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

export enum SearchableType {
  ENTITY = 'entity',
  DOCUMENT = 'document',
  NOTE = 'note',
  EMAIL = 'email',
  // Additive (CLAUDE.md §5.5b/§7.2) — appended, not inserted, so no stored
  // row's enum ordinal shifts. Added because `indexEntityData` used to
  // hardcode `SearchableType.ENTITY` regardless of what a caller asked to
  // index; tasks, form submissions and workflow instances now index as
  // themselves. `document` already existed and covers `document-hub.service.ts`.
  TASK = 'task',
  FORM_SUBMISSION = 'form_submission',
  WORKFLOW_INSTANCE = 'workflow_instance',
}

@Entity('search_index')
@Index(['tenantId', 'searchableId', 'searchableType'])
@Index(['tenantId', 'searchableType'])
export class SearchIndex {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ type: 'enum', enum: SearchableType })
  searchableType: SearchableType;

  @Column()
  searchableId: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'tsvector', nullable: true })
  vector: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}
