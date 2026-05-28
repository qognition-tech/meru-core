import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Tenant } from '../../iam/entities/tenant.entity';

@Entity('tags')
@Index(['tenantId', 'name'], { unique: true })
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 7, nullable: true })
  color: string;

  @CreateDateColumn()
  createdAt: Date;
}