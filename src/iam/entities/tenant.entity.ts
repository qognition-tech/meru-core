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

export enum VerticalType {
  IMMIGRATION = 'immigration',
  GRC = 'grc',
  MERU = 'meru',
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
