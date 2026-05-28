import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';

@Entity('sessions')
@Index(['tenantId'])
@Index(['userId'])
@Index(['tokenHash'])
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  userId: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ unique: true })
  tokenHash: string;

  @Column({ nullable: true })
  refreshTokenHash: string;

  @Column({ nullable: true })
  ipAddress: string;

  @Column({ type: 'text', nullable: true })
  userAgent: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}