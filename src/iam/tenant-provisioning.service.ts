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
import { ModuleCode } from './entitlements/module-code';
import { PlatformRole } from './enums/platform-role.enum';
import { MailService } from '../core/mail/mail.service';
import {
  ConnectorMode,
  TenantConnector,
} from '../integrations/entities/tenant-connector.entity';

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

/**
 * Plan → module entitlements. The five core modules are never gated (Immigrow
 * BRD: "always enabled"); paid tiers add capability modules. Country modules
 * arrive as `country:AU`-style entries chosen at provisioning, not from the
 * plan. Stored on tenant.settings.modules so a tenant's grant survives plan
 * math changes; the plan list is the DEFAULT at provisioning time, not a
 * live computation.
 */
/** Subdomains that can never be a tenant. */
const RESERVED_SUBDOMAINS = new Set([
  'www',
  'app',
  'api',
  'admin',
  'mail',
  'static',
  'cdn',
  'docs',
  'help',
]);

const CORE_MODULES = [
  'crm',
  'cases',
  'tasks',
  'documents',
  'payments',
  'communications',
];
/**
 * Vertical-specific additions, applied at provisioning only. Existing grants
 * are never rewritten (§7.2). A GRC tenant provisioned from here on carries
 * the GRC codes, which is what makes `ModuleEntitlementGuard` enforce for it.
 */
const GRC_PLAN_MODULES: Partial<
  Record<VerticalType, Partial<Record<TenantPlan, string[]>>>
> = {
  [VerticalType.GRC]: {
    [TenantPlan.FREE]: [ModuleCode.SCREENING],
    [TenantPlan.STARTER]: [ModuleCode.SCREENING],
    [TenantPlan.PROFESSIONAL]: [
      ModuleCode.SCREENING,
      ModuleCode.TRADE_FINANCE,
      ModuleCode.VESSEL_TRACKING,
    ],
    [TenantPlan.ENTERPRISE]: [
      ModuleCode.SCREENING,
      ModuleCode.TRADE_FINANCE,
      ModuleCode.VESSEL_TRACKING,
    ],
  },
};
const PLAN_MODULES: Record<TenantPlan, string[]> = {
  [TenantPlan.FREE]: [...CORE_MODULES],
  [TenantPlan.STARTER]: [...CORE_MODULES, 'forms'],
  [TenantPlan.PROFESSIONAL]: [
    ...CORE_MODULES,
    'forms',
    'ai_automation',
    'advanced_analytics',
    'marketing',
  ],
  [TenantPlan.ENTERPRISE]: [
    ...CORE_MODULES,
    'forms',
    'ai_automation',
    'advanced_analytics',
    'marketing',
    'branding',
    'api_access',
    'sso',
  ],
};

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
   * Admin-provisioned tenant creation (the Meru-dashboard "create GovX /
   * ImmiStack account" flow). Unlike signup, no password is taken: the
   * workspace admin gets an invite (single-use link, 7-day expiry, via the
   * existing inviteUser flow) and sets their own credentials. Requested
   * connectors are pre-enabled in sandbox. Caller must be platform_admin —
   * the controller wraps this in runAsGod.
   */
  async provisionTenant(
    dto: {
      name: string;
      slug: string;
      vertical: VerticalType;
      plan?: TenantPlan;
      adminEmail: string;
      adminFirstName?: string;
      adminLastName?: string;
      modules?: string[];
      connectors?: string[];
    },
    inviteUser: (
      tenantId: string,
      invite: { email: string; role: string; firstName?: string; lastName?: string },
    ) => Promise<{ inviteSent: boolean }>,
  ): Promise<{
    tenant: Pick<Tenant, 'id' | 'slug' | 'name' | 'vertical' | 'plan' | 'status'>;
    inviteSent: boolean;
    connectorsEnabled: string[];
  }> {
    const plan = dto.plan ?? TenantPlan.FREE;
    const modules = Array.from(
      new Set([
        ...(PLAN_MODULES[plan] ?? CORE_MODULES),
        ...(GRC_PLAN_MODULES[dto.vertical]?.[plan] ?? []),
        ...(dto.modules ?? []),
      ]),
    );

    const tenant = await TenantContext.runAsSystem(
      `admin-provision tenant ${dto.slug}`,
      async () => {
        const existing = await this.tenantRepo.findOne({
          where: { slug: dto.slug },
        });
        if (existing) {
          throw new BadRequestException(`Slug ${dto.slug} is already taken`);
        }

        const created = this.tenantRepo.create({
          id: randomUUID(),
          name: dto.name,
          slug: dto.slug,
          vertical: dto.vertical,
          status: TenantStatus.TRIAL,
          plan,
          settings: { ...this.getDefaultSettings(plan), modules },
          metadata: { source: 'admin-provisioned' },
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          createdAt: new Date(),
        });
        await this.tenantRepo.save(created);

        if (dto.connectors?.length) {
          const connectorRepo = this.dataSource.getRepository(TenantConnector);
          await connectorRepo.save(
            dto.connectors.map((adapterCode) =>
              connectorRepo.create({
                tenantId: created.id,
                adapterCode,
                enabled: true,
                mode: ConnectorMode.SANDBOX,
              }),
            ),
          );
        }
        return created;
      },
    );

    // Outside the system block on purpose: inviteUser manages its own scoped
    // bypasses and sends the Resend mail.
    const invite = await inviteUser(tenant.id, {
      email: dto.adminEmail,
      role: PlatformRole.FIRM_ADMIN,
      firstName: dto.adminFirstName,
      lastName: dto.adminLastName,
    });

    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        vertical: tenant.vertical,
        plan: tenant.plan,
        status: tenant.status,
      },
      inviteSent: invite.inviteSent,
      connectorsEnabled: dto.connectors ?? [],
    };
  }

  /** Suspend or reactivate a tenant. Caller wraps in runAsGod. */
  async setTenantStatus(
    tenantId: string,
    status: TenantStatus.ACTIVE | TenantStatus.SUSPENDED,
  ): Promise<Pick<Tenant, 'id' | 'slug' | 'status'>> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant not found');
    tenant.status = status;
    await this.tenantRepo.save(tenant);
    return { id: tenant.id, slug: tenant.slug, status: tenant.status };
  }

  /**
   * The caller tenant's own entitlements — what the three portals gate their
   * nav and module screens on. Modules were frozen onto settings.modules at
   * provisioning; tenants created before that carry no list and fall back to
   * their plan's defaults.
   */
  async getEntitlements(tenantId: string): Promise<{
    vertical: VerticalType;
    plan: TenantPlan;
    status: TenantStatus;
    trialEndsAt: Date | null;
    modules: string[];
    connectors: { adapterCode: string; mode: string }[];
  }> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant not found');

    const stored = (tenant.settings as { modules?: string[] } | null)?.modules;
    const connectors = await this.dataSource
      .getRepository(TenantConnector)
      .find({ where: { tenantId, enabled: true } });

    return {
      vertical: tenant.vertical,
      plan: tenant.plan,
      status: tenant.status,
      trialEndsAt: tenant.trialEndsAt ?? null,
      modules: stored ?? PLAN_MODULES[tenant.plan] ?? CORE_MODULES,
      connectors: connectors.map((c) => ({
        adapterCode: c.adapterCode,
        mode: c.mode,
      })),
    };
  }

  /**
   * Let a tenant admin choose which of their *entitled* modules are switched
   * on, and which countries they operate in.
   *
   * The onboarding wizard needs somewhere to persist steps 2 and 7; without
   * this the pickers recorded a preference nothing ever read. But "write your
   * own entitlements" cannot mean what it says: entitlements are the billing
   * grant, so an unchecked PUT here is a free self-service upgrade — a FREE
   * tenant could award itself `sso` and `api_access` by editing a request
   * body.
   *
   * So the plan allowance is the ceiling. A caller may deselect anything and
   * may select anything their plan already includes; asking for a module the
   * plan does not carry is a 400 that names the module, not a silent drop
   * (which would leave the UI showing a feature the backend never granted).
   *
   * Country entries (`country:AU`) are exempt from the ceiling by design —
   * they are a deployment choice made at provisioning, not a priced
   * capability. Core modules are re-added unconditionally because they are
   * never gated, so unchecking one in the UI must not be able to strand a
   * tenant without `crm` or `documents`.
   *
   * Plan changes still go through /tenants/:id/upgrade. This route cannot
   * change a plan, only what is enabled inside one.
   */
  async updateOwnEntitlements(
    tenantId: string,
    modules: string[],
  ): Promise<Awaited<ReturnType<TenantProvisioningService['getEntitlements']>>> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Tenant not found');

    const allowance = PLAN_MODULES[tenant.plan] ?? CORE_MODULES;
    const isCountry = (m: string) => m.startsWith('country:');

    const refused = modules.filter(
      (m) => !isCountry(m) && !allowance.includes(m),
    );
    if (refused.length) {
      throw new BadRequestException(
        `Plan '${tenant.plan}' does not include: ${refused.join(', ')}. ` +
          `Upgrade the plan to enable them.`,
      );
    }

    // Set, so a caller repeating a module cannot inflate the stored list.
    const next = Array.from(new Set([...CORE_MODULES, ...modules]));

    tenant.settings = { ...(tenant.settings ?? {}), modules: next } as never;
    await this.tenantRepo.save(tenant);

    return this.getEntitlements(tenantId);
  }

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

  /**
   * Which tenant does a hostname belong to? Unauthenticated by necessity — the
   * caller is a login page that has not signed anyone in yet and wants to show
   * the right logo and colours. Returns only what a public login page may
   * show: no settings, no plan, no limits, no status.
   *
   * Two shapes resolve:
   *   - `<slug>.<BASE_DOMAIN>` (BASE_DOMAIN from the environment, e.g.
   *     `govx.com`), by slug;
   *   - anything else, by exact match on `settings.branding.customDomain`.
   *
   * Before this there was no tenant-domain resolution at all — `domain`
   * appeared zero times in the spec — so every portal showed the platform's
   * branding until after login.
   */
  async resolveByHost(host: string): Promise<{
    slug: string;
    name: string;
    vertical: VerticalType;
    logoUrl: string | null;
    branding: { colors?: { primary?: string; secondary?: string } } | null;
    matchedBy: 'subdomain' | 'custom_domain';
  } | null> {
    const hostname = host.trim().toLowerCase().split(':')[0];
    if (!hostname || hostname.length > 253) return null;

    const baseDomain = (this.configService.get<string>('BASE_DOMAIN') ?? '')
      .trim()
      .toLowerCase();

    let tenant: Tenant | null = null;
    let matchedBy: 'subdomain' | 'custom_domain' = 'custom_domain';

    if (baseDomain && hostname.endsWith('.' + baseDomain)) {
      const slug = hostname.slice(0, -(baseDomain.length + 1));
      // Only one label: `a.b.govx.com` is not a tenant.
      if (slug && !slug.includes('.') && !RESERVED_SUBDOMAINS.has(slug)) {
        tenant = await TenantContext.runAsSystem(
          'resolve tenant by subdomain',
          () => this.tenantRepo.findOne({ where: { slug } }),
        );
        matchedBy = 'subdomain';
      }
    }

    if (!tenant) {
      tenant = await TenantContext.runAsSystem(
        'resolve tenant by custom domain',
        () =>
          this.tenantRepo
            .createQueryBuilder('t')
            .where(
              `lower(t.settings->'branding'->>'customDomain') = :hostname`,
              { hostname },
            )
            .getOne(),
      );
      matchedBy = 'custom_domain';
    }

    if (!tenant) return null;
    const branding = tenant.settings?.branding ?? null;
    return {
      slug: tenant.slug,
      name: tenant.name,
      vertical: tenant.vertical,
      logoUrl: tenant.logoUrl ?? branding?.logo ?? null,
      branding: branding?.colors ? { colors: branding.colors } : null,
      matchedBy,
    };
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
