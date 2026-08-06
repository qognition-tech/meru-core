import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  Tenant,
  TenantStatus,
  TenantPlan,
  VerticalType,
} from './entities/tenant.entity';
import { User } from './entities/user.entity';
import { TenantSetting } from '../tenant/entities/tenant-setting.entity';
import { randomUUID } from 'node:crypto';
import { TenantContext } from '../core/tenancy/tenant-context';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { PlatformRole } from './enums/platform-role.enum';
import { MailService } from '../core/mail/mail.service';

// Re-exported so existing importers keep working. The definition now lives in
// ./dto/create-tenant.dto.ts as a decorated *class* — see the note there on why
// an interface here meant signup ran with no validation at all.
export { CreateTenantDto };

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
    private configService: ConfigService,
    private mailService: MailService,
  ) {}

  async createTenant(dto: CreateTenantDto): Promise<TenantWorkspaceResponse> {
    // Signup is the one operation that *creates* the tenant it would otherwise
    // need to be scoped to. With no tenant bound, the WITH CHECK on `tenants`
    // (and on users/roles/tenant_settings) correctly rejects every insert:
    //   "new row violates row-level security policy for table tenants"
    // So the whole transaction runs in a system context, exactly like the other
    // identity-establishing paths in IamService. The bypass ends when this
    // callback returns — it does not leak to the rest of the request.
    return TenantContext.runAsSystem(
      `provision tenant workspace ${dto.slug}`,
      () => this.createTenantInternal(dto),
    );
  }

  private async createTenantInternal(
    dto: CreateTenantDto,
  ): Promise<TenantWorkspaceResponse> {
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
        id: randomUUID(),
        name: dto.name,
        slug: dto.slug,
        vertical: dto.vertical,
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

      // `firm_admin`, not `['admin','user']`. Neither of those is a real role:
      // PolicyGuard matches role strings literally and the portals switch on
      // the `role` JWT claim, whose only recognised values are the four in
      // PlatformRole. A workspace owner created with 'admin' resolved to a role
      // no portal could route on and satisfied no @Roles guard — they were
      // locked out of their own workspace's admin surfaces.
      //
      // firstName/lastName go in their real columns too. They were written only
      // into `attributes`, so the owner showed up nameless in their own user
      // directory (see IamService.toDirectoryUser, which reads the columns).
      const user = queryRunner.manager.create(User, {
        id: randomUUID(),
        email: dto.email,
        password: hashedPassword,
        tenantId: tenant.id,
        tenant,
        firstName: dto.firstName,
        lastName: dto.lastName,
        roles: [PlatformRole.FIRM_ADMIN],
        attributes: {
          isWorkspaceOwner: true,
        },
        createdAt: new Date(),
      });

      await queryRunner.manager.save(user);

      // 4. Create default tenant settings
      const defaultSettings = queryRunner.manager.create(TenantSetting, {
        id: randomUUID(),
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

      // (Removed: `SELECT app.set_tenant_context($1)` — that function was never
      // created by any migration, so this call threw and rolled the signup
      // transaction back. Tenant binding is handled by applyRlsToDataSource.)

      await queryRunner.commitTransaction();

      this.logger.log(`Tenant workspace created successfully: ${tenant.slug}`);

      // 6. Send welcome email (async, outside transaction)
      // Reported, not assumed. This was hardcoded `true`, so a workspace
      // whose welcome email never left the building still told the caller it
      // had — the same claim-success-without-checking pattern that made mail
      // failures invisible everywhere else.
      const { delivered } = await this.mailService.sendWelcome({
        to: user.email,
        firstName: user.firstName,
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        plan: tenant.plan,
        trialEndsAt: tenant.trialEndsAt,
      });

      return {
        tenant,
        user: this.sanitizeUser(user),
        workspaceUrl: `${tenant.slug}.meru.com`,
        welcomeEmailSent: delivered,
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

  /**
   * Every tenant on the platform — the God View list (CLAUDE.md §5).
   *
   * Inherently cross-tenant, so the caller must already be inside a `runAsGod`
   * context; the RLS policy on `tenants` restricts a bound connection to the
   * single row matching `app.current_tenant_id`, and this would otherwise
   * return exactly one tenant (or none) rather than failing loudly.
   */
  /**
   * Cross-tenant aggregates for the God UI (`GET /platform/stats`). Caller
   * must wrap in runAsGod — this reads every tenant row.
   */
  async getPlatformStats(): Promise<{
    totalTenants: number;
    newTenants30d: number;
    totalUsers: number;
    byVertical: Record<string, number>;
    byStatus: Record<string, number>;
    byPlan: Record<string, number>;
  }> {
    const [tenants, totalUsers] = await Promise.all([
      this.tenantRepo.find(),
      this.userRepo.count(),
    ]);

    const bucket = (key: (t: (typeof tenants)[number]) => string) =>
      tenants.reduce<Record<string, number>>((acc, t) => {
        const k = key(t) ?? 'unknown';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});

    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    return {
      totalTenants: tenants.length,
      newTenants30d: tenants.filter((t) => t.createdAt > cutoff30d).length,
      totalUsers,
      byVertical: bucket((t) => t.vertical),
      byStatus: bucket((t) => t.status),
      byPlan: bucket((t) => t.plan),
    };
  }

  async listAllTenants(): Promise<
    Array<{
      id: string;
      slug: string;
      name: string;
      vertical: VerticalType;
      status: TenantStatus;
      plan: TenantPlan;
      userCount: number;
      createdAt: Date;
      trialEndsAt: Date | null;
    }>
  > {
    const tenants = await this.tenantRepo.find({
      order: { createdAt: 'DESC' },
    });

    if (tenants.length === 0) return [];

    // One grouped count rather than a query per tenant.
    const counts = await this.userRepo
      .createQueryBuilder('u')
      .select('u."tenantId"', 'tenantId')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('u."tenantId"')
      .getRawMany<{ tenantId: string; count: number }>();

    const countByTenant = new Map(counts.map((c) => [c.tenantId, c.count]));

    return tenants.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      vertical: t.vertical,
      status: t.status,
      plan: t.plan,
      userCount: countByTenant.get(t.id) ?? 0,
      createdAt: t.createdAt,
      trialEndsAt: t.trialEndsAt ?? null,
    }));
  }

  async getTenantStats(tenantId: string): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      // No manual tenant-context call here. This used to be
      // `SELECT app.set_tenant_context($1)` — a function no migration ever
      // created, so every request to this endpoint died with a 500. The
      // connection is now bound to the caller's tenant automatically by
      // applyRlsToDataSource (core/tenancy), which covers query runners too.

      // Columns are camelCase ("tenantId"); the previous snake_case `tenant_id`
      // predicates would have thrown even once the function call was fixed.
      const [userCount, entityCount, documentCount] = await Promise.all([
        queryRunner.manager.count(User, { where: { tenantId } }),
        queryRunner.manager.query(
          `SELECT COUNT(*) FROM universal_entities WHERE "tenantId" = $1`,
          [tenantId],
        ),
        queryRunner.manager.query(
          `SELECT COUNT(*) FROM documents WHERE "tenantId" = $1`,
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
    // Runs unauthenticated, so no tenant is bound and RLS would hide every row
    // in `tenants` — making this report "available" for slugs that are already
    // taken, then failing at signup. It fails silently rather than loudly,
    // which is why it needs the system context even though it only reads.
    const existing = await TenantContext.runAsSystem(
      'check tenant slug availability',
      () => this.tenantRepo.findOne({ where: { slug } }),
    );
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
      `SELECT COALESCE(SUM("fileSize"), 0) as total FROM documents WHERE "tenantId" = $1`,
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
}
