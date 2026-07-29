import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * The verticals a tenant can actually be stored as.
 *
 * These must match the Postgres `vertical_type_enum` exactly — it is
 * `('immigration','grc','labour')` as of migration `FixVerticalsAndColumns`.
 * This enum previously listed a `meru` member that the database has never
 * accepted (inserting it fails the column's enum constraint) and omitted the
 * real `labour`, so signing up a labour tenant was impossible and signing up a
 * `meru` one 500'd at the insert.
 *
 * Not to be confused with `../enums/vertical.enum.ts`, which is a *superset*
 * used for policy lookup only (it adds `fintech` and `legal`, which have
 * VerticalPolicy entries but no database representation). Anything that writes
 * `tenants.vertical` must use this enum; see `dto/create-tenant.dto.ts`.
 */
export enum VerticalType {
  IMMIGRATION = 'immigration',
  GRC = 'grc',
  LABOUR = 'labour',
}

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
  TRIAL = 'trial',
}

export enum TenantPlan {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

@Entity('tenants')
@Index(['slug'])
@Index(['status'])
@Index(['vertical'])
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  logoUrl: string;

  @Column({ type: 'enum', enum: VerticalType })
  vertical: VerticalType;

  @Column({ type: 'enum', enum: TenantStatus, default: TenantStatus.TRIAL })
  status: TenantStatus;

  @Column({ type: 'enum', enum: TenantPlan, default: TenantPlan.FREE })
  plan: TenantPlan;

  @Column({ type: 'jsonb', default: {} })
  settings: {
    branding?: {
      logo?: string;
      colors?: { primary?: string; secondary?: string };
      customDomain?: string;
    };
    limits?: {
      users?: number;
      storageGB?: number;
      documents?: number;
      apiCallsPerMonth?: number;
    };
    features?: {
      aiAnalysis?: boolean;
      advancedSearch?: boolean;
      customWorkflows?: boolean;
      sso?: boolean;
      apiAccess?: boolean;
    };
    notifications?: {
      emailFrom?: string;
      emailFromName?: string;
      slackWebhook?: string;
    };
  };

  @Column({ type: 'jsonb', default: {} })
  ssoConfig: {
    provider?: 'saml' | 'oidc' | 'local';
    entryPoint?: string;
    cert?: string;
    issuer?: string;
  };

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    industry?: string;
    companySize?: string;
    source?: string;
    referralCode?: string;
    suspensionReason?: string;
    suspendedAt?: string;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  subscriptionRenewsAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;

  @OneToMany(() => User, (user) => user.tenant)
  users: User[];
}
