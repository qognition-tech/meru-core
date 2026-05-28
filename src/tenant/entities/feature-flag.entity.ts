import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from '../../iam/entities/tenant.entity';

@Entity('feature_flags')
@Index(['tenantId'])
export class FeatureFlag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  flagKey: string;

  @Column({ type: 'jsonb', default: true })
  flagValue: any;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ default: 100 })
  rolloutPercentage: number;

  @Column({ type: 'text', array: true, nullable: true })
  targetRoles: string[];

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
