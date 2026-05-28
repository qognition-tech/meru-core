import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum EntityType {
  PERSON = 'person',
  ORGANIZATION = 'organization',
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
