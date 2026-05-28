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
import { ConfigPack } from '../../tenant/entities/config-pack.entity';
import { User } from './user.entity';

@Entity('tenant_config_pins')
@Index(['tenantId'])
export class TenantConfigPin {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenantId!: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant!: Tenant;

  @Column()
  configPackId!: string;

  @ManyToOne(() => ConfigPack, { eager: false })
  @JoinColumn({ name: 'configPackId' })
  configPack!: ConfigPack;

  @Column()
  pinnedVersion!: string;

  @Column({ type: 'jsonb', default: {} })
  overrides!: Record<string, any>;

  @CreateDateColumn()
  pinnedAt!: Date;

  @Column({ nullable: true })
  pinnedBy!: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'pinnedBy' })
  pinner!: User;
}