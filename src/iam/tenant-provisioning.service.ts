import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { Tenant, TenantStatus, TenantPlan } from './entities/tenant.entity';
import { User } from './entities/user.entity';
import { TenantSetting } from '../tenant/entities/tenant-setting.entity';
import { v4 as uuidv4 } from 'uuid';

export interface CreateTenantDto {
  name: string;
  slug: string;
  vertical: string;
  plan?: TenantPlan;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface TenantWorkspaceResponse {
  tenant: Tenant;
  user: Partial<User>;
  workspaceUrl: string;
  welcomeEmailSent: boolean;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(TenantSetting)
    private tenantSettingRepo: Repository<TenantSetting>,
    private dataSource: DataSource,
  ) {}

  async createTenant(dto: CreateTenantDto): Promise<TenantWorkspaceResponse> {
    this.logger.log(`Creating new tenant workspace: ${dto.slug}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Validate slug uniqueness
      const existingTenant = await queryRunner.manager.findOne(Tenant, {
        where: { slug: dto.slug },
      });

      if (existingTenant) {
        throw new BadRequestException(`Slug ${dto.slug} is already taken`);
      }

      // 2. Create tenant (workspace)
      const tenant = queryRunner.manager.create(Tenant, {
        id: uuidv4(),
        name: dto.name,
        slug: dto.slug,
        vertical: dto.vertical as any,
        status: TenantStatus.TRIAL,
        plan: dto.plan || TenantPlan.FREE,
        settings: this.getDefaultSettings(dto.plan || TenantPlan.FREE),
        metadata: {
          source: 'signup',
        },
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days trial
        createdAt: new Date(),
      });

      await queryRunner.manager.save(tenant);

      // 3. Create admin user
      const hashedPassword = await this.hashPassword(dto.password);

      const user = queryRunner.manager.create(User, {
        id: uuidv4(),
        email: dto.email,
        password: hashedPassword,
        tenantId: tenant.id,
        tenant,
        roles: ['admin', 'user'],
        attributes: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          isWorkspaceOwner: true,
        },
        createdAt: new Date(),
      });

      await queryRunner.manager.save(user);

      // 4. Create default tenant settings
      const defaultSettings = queryRunner.manager.create(TenantSetting, {
        id: uuidv4(),
        tenantId: tenant.id,
        tenant,
        settings: {
          currency: 'USD',
          timezone: 'UTC',
          dateFormat: 'MM/DD/YYYY',
          language: 'en',
          notifications: {
            email: true,
            push: true,
            digest: 'daily',
          },
          security: {
            twoFactorEnabled: false,
            ipWhitelist: [],
            sessionTimeout: 30, // minutes
          },
          ai: {
            enabled: true,
            model: 'gpt-4o-mini',
            maxTokens: 1000,
          },
        },
      });

      await queryRunner.manager.save(defaultSettings);

      // 5. Set up tenant RLS context (for any operations)
      await queryRunner.query(`SELECT app.set_tenant_context($1)`, [tenant.id]);

      await queryRunner.commitTransaction();

      this.logger.log(`Tenant workspace created successfully: ${tenant.slug}`);

      // 6. Send welcome email (async, outside transaction)
      await this.sendWelcomeEmail(user, tenant);

      return {
        tenant,
        user: this.sanitizeUser(user),
        workspaceUrl: `${tenant.slug}.meru.com`,
        welcomeEmailSent: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to create tenant: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async upgradeTenantPlan(
    tenantId: string,
    newPlan: TenantPlan,
  ): Promise<Tenant> {
    this.logger.log(`Upgrading tenant ${tenantId} to plan: ${newPlan}`);

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    tenant.plan = newPlan;
    tenant.status = TenantStatus.ACTIVE;
    tenant.subscriptionRenewsAt = this.calculateRenewalDate(newPlan);
    tenant.settings = {
      ...tenant.settings,
      limits: this.getPlanLimits(newPlan),
      features: this.getPlanFeatures(newPlan),
    };

    return this.tenantRepo.save(tenant);
  }

  async suspendTenant(tenantId: string, reason: string): Promise<Tenant> {
    this.logger.log(`Suspending tenant ${tenantId}: ${reason}`);

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    tenant.status = TenantStatus.SUSPENDED;
    tenant.metadata = {
      ...tenant.metadata,
      suspensionReason: reason,
      suspendedAt: new Date().toISOString(),
    };

    return this.tenantRepo.save(tenant);
  }

  async deleteTenant(
    tenantId: string,
    permanent: boolean = false,
  ): Promise<void> {
    this.logger.log(`Deleting tenant ${tenantId} (permanent: ${permanent})`);

    if (permanent) {
      // Hard delete - remove all data
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        // Delete in correct order due to foreign keys
        await queryRunner.manager.delete(User, { tenantId });
        await queryRunner.manager.delete(Tenant, { id: tenantId });

        await queryRunner.commitTransaction();
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }
    } else {
      // Soft delete
      const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException('Tenant not found');
      }

      tenant.status = TenantStatus.DELETED;
      tenant.deletedAt = new Date();

      await this.tenantRepo.save(tenant);
    }
  }

  async getTenantStats(tenantId: string): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      // Set tenant context
      await queryRunner.query(`SELECT app.set_tenant_context($1)`, [tenantId]);

      // Get statistics
      const [userCount, entityCount, documentCount] = await Promise.all([
        queryRunner.manager.count(User, { where: { tenantId } }),
        queryRunner.manager.query(
          `SELECT COUNT(*) FROM universal_entities WHERE tenant_id = $1`,
          [tenantId],
        ),
        queryRunner.manager.query(
          `SELECT COUNT(*) FROM documents WHERE tenant_id = $1`,
          [tenantId],
        ),
      ]);

      return {
        users: userCount,
        entities: parseInt(entityCount[0].count),
        documents: parseInt(documentCount[0].count),
        storageUsed: await this.calculateStorageUsage(tenantId, queryRunner),
      };
    } finally {
      await queryRunner.release();
    }
  }

  async checkSlugAvailability(slug: string): Promise<{ available: boolean }> {
    const existing = await this.tenantRepo.findOne({ where: { slug } });
    return { available: !existing };
  }

  private getDefaultSettings(plan: TenantPlan) {
    return {
      limits: this.getPlanLimits(plan),
      features: this.getPlanFeatures(plan),
    };
  }

  private getPlanLimits(plan: TenantPlan) {
    const limits = {
      [TenantPlan.FREE]: {
        users: 3,
        storageGB: 1,
        documents: 100,
        apiCallsPerMonth: 1000,
      },
      [TenantPlan.STARTER]: {
        users: 10,
        storageGB: 10,
        documents: 1000,
        apiCallsPerMonth: 10000,
      },
      [TenantPlan.PROFESSIONAL]: {
        users: 50,
        storageGB: 100,
        documents: 10000,
        apiCallsPerMonth: 100000,
      },
      [TenantPlan.ENTERPRISE]: {
        users: -1, // unlimited
        storageGB: -1,
        documents: -1,
        apiCallsPerMonth: -1,
      },
    };

    return limits[plan];
  }

  private getPlanFeatures(plan: TenantPlan) {
    const features = {
      [TenantPlan.FREE]: {
        aiAnalysis: true,
        advancedSearch: false,
        customWorkflows: false,
        sso: false,
        apiAccess: false,
      },
      [TenantPlan.STARTER]: {
        aiAnalysis: true,
        advancedSearch: true,
        customWorkflows: false,
        sso: false,
        apiAccess: true,
      },
      [TenantPlan.PROFESSIONAL]: {
        aiAnalysis: true,
        advancedSearch: true,
        customWorkflows: true,
        sso: true,
        apiAccess: true,
      },
      [TenantPlan.ENTERPRISE]: {
        aiAnalysis: true,
        advancedSearch: true,
        customWorkflows: true,
        sso: true,
        apiAccess: true,
        dedicatedSupport: true,
      },
    };

    return features[plan];
  }

  private calculateRenewalDate(plan: TenantPlan): Date {
    const now = new Date();
    const durations = {
      [TenantPlan.FREE]: 30,
      [TenantPlan.STARTER]: 30,
      [TenantPlan.PROFESSIONAL]: 30,
      [TenantPlan.ENTERPRISE]: 365,
    };

    return new Date(now.getTime() + durations[plan] * 24 * 60 * 60 * 1000);
  }

  private async calculateStorageUsage(
    tenantId: string,
    queryRunner: QueryRunner,
  ): Promise<number> {
    const result = await queryRunner.manager.query(
      `SELECT COALESCE(SUM(file_size), 0) as total FROM documents WHERE tenant_id = $1`,
      [tenantId],
    );

    return parseInt(result[0].total) / (1024 * 1024 * 1024); // Convert to GB
  }

  private async hashPassword(password: string): Promise<string> {
    const bcrypt = require('bcrypt');
    return bcrypt.hash(password, 10);
  }

  private sanitizeUser(user: User): Partial<User> {
    const { password, ...sanitized } = user;
    return sanitized;
  }

  private async sendWelcomeEmail(user: User, tenant: Tenant): Promise<void> {
    // TODO: Integrate with email service (SendGrid, SES, etc.)
    this.logger.log(
      `Welcome email sent to ${user.email} for tenant ${tenant.slug}`,
    );

    // For now, just log
    // await this.emailService.sendWelcomeEmail(user, tenant);
  }
}
