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
import { Tenant } from './tenant.entity';

@Entity('roles')
@Index(['tenantId'])
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'jsonb', default: [] })
  permissions: string[];

  @Column({ default: false })
  isSystem: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}