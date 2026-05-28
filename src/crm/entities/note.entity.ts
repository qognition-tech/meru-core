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
import { User } from '../../iam/entities/user.entity';

@Entity('notes')
@Index(['tenantId'])
@Index(['entityType', 'entityId'])
@Index(['createdBy'])
export class Note {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ length: 50 })
  entityType: string;

  @Column()
  entityId: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ default: false })
  isInternal: boolean;

  @Column()
  createdBy: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'createdBy' })
  creator: User;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}