import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('elasticsearch_indices')
@Index(['tenantId', 'name'])
@Index(['entityType'])
export class ElasticsearchIndex {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column()
  name: string;

  @Column()
  entityType: string;

  @Column({ type: 'text' })
  mapping: string; // JSON string of IndexMapping

  @Column({ type: 'jsonb', default: {} })
  settings: {
    numberOfShards: number;
    numberOfReplicas: number;
    refreshInterval: string;
  };

  @Column({ type: 'int', default: 0 })
  documentCount: number;

  @Column({ type: 'bigint', default: 0 })
  sizeInBytes: number;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastIndexedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('elasticsearch_documents')
@Index(['tenantId', 'indexId'])
@Index(['entityType', 'entityId'])
@Index(['indexedAt'])
export class ElasticsearchDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid' })
  indexId: string;

  @Column()
  entityType: string;

  @Column()
  entityId: string;

  @Column()
  documentId: string; // Elasticsearch document ID

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'simple-array', default: '' })
  tags: string[];

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'float', array: true, nullable: true })
  embedding: number[] | null;

  @Column({ type: 'int', default: 0 })
  version: number;

  @Column({ type: 'boolean', default: true })
  isIndexed: boolean;

  @CreateDateColumn()
  indexedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('elasticsearch_search_logs')
@Index(['tenantId'])
@Index(['createdAt'])
@Index(['query'])
export class ElasticsearchSearchLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'text' })
  query: string;

  @Column({ type: 'simple-array', nullable: true })
  indices: string[] | null;

  @Column({ type: 'int' })
  resultsCount: number;

  @Column({ type: 'int' })
  responseTimeMs: number;

  @Column({ type: 'jsonb', default: {} })
  filters: Record<string, any>;

  @Column({ type: 'boolean', default: false })
  hasResults: boolean;

  @Column({ type: 'jsonb', nullable: true })
  clickedResults: {
    documentId: string;
    position: number;
    timestamp: Date;
  }[] | null;

  @CreateDateColumn()
  createdAt: Date;
}
