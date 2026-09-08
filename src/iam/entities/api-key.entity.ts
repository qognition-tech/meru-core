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

/**
 * DEAD — not wired to any authentication path.
 *
 * `IamService.createApiKey` / `validateApiKey` write and read this table, but
 * no controller exposes them, no passport strategy or guard reads an
 * `x-api-key` header, and the Swagger scheme that advertised one has been
 * removed (P0-4). A row here grants nothing; a key minted from it
 * authenticates nowhere.
 *
 * Kept for now rather than dropped: removing the entity needs a migration that
 * drops `api_keys`, and that is a separate, reversible commit once the
 * business has decided whether service-to-service auth is wanted at all.
 * If it is, the work is a `HeaderAPIKeyStrategy` + guard + `/iam/api-keys`
 * routes — not a doc line. Until then, nothing may advertise this.
 */
@Entity('api_keys')
@Index(['tenantId'])
@Index(['keyHash'])
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  name: string;

  @Column({ unique: true })
  keyHash: string;

  @Column()
  prefix: string;

  @Column({ type: 'text', array: true, default: [] })
  scopes: string[];

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date;

  @Column()
  createdBy: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'createdBy' })
  creator: User;

  @CreateDateColumn()
  createdAt: Date;
}
