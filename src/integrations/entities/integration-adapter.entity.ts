import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('integration_adapters')
@Index(['code'], { unique: true })
export class IntegrationAdapter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 100 })
  code: string;

  @Column()
  name: string;

  @Column({ length: 3 })
  country: string;

  @Column()
  regulator: string;

  @Column({ length: 500 })
  baseUrl: string;

  @Column({ default: 'api_key' })
  authType: string;

  @Column({ type: 'jsonb', default: {} })
  authConfig: Record<string, any>;

  @Column({ default: 60 })
  rateLimitRpm: number;

  @Column({ default: 30000 })
  timeoutMs: number;

  @Column({ type: 'jsonb', default: {} })
  retryConfig: Record<string, any>;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: 'unknown' })
  healthStatus: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastHealthCheck: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}