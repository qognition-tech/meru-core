import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { IamService } from './iam.service';
import { TenancyService } from '../core/tenancy/tenancy.service';
import { BrandingService } from '../tenant/services/branding.service';
import { ConnectorsService } from '../integrations/services/connectors.service';
import { ImpersonateDto } from './dto/impersonate.dto';
import { OperatorUpdateEntitlementsDto } from './dto/operator-update-entitlements.dto';
import type { AuthenticatedRequest } from '../common/types';

/**
 * Per-tenant operator surface for the God UI's tenant-detail page.
 *
 * These read the same data as `/tenants/me/entitlements`, `/tenant/branding`
 * and `/integrations/connectors`, but for a tenant that is *not* the caller's.
 * Those three are caller-scoped by design, which is correct for the vertical
 * apps and useless for the operator console — it could create a tenant and
 * then not inspect it.
 *
 * Every method here follows the rule established by `GET /tenants/:id/stats`:
 * reading your own tenant is ordinary, reading someone else's requires
 * `platform_admin` and goes through `runAsGod`, which writes a CRITICAL audit
 * entry before the query runs (CLAUDE.md §6.4). The alternative — running on
 * the caller's RLS-bound connection — does not error, it returns *empty*,
 * which renders as a real answer and is the worse failure.
 *
 * Lives in its own module because it needs BrandingService (TenantModule) and
 * ConnectorsService (IntegrationsModule), and IntegrationsModule already
 * imports IamModule — putting these on an IAM controller would close a cycle.
 */
@ApiTags('operator')
@Controller('tenants')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class OperatorController {
  constructor(
    private readonly tenantProvisioningService: TenantProvisioningService,
    private readonly brandingService: BrandingService,
    private readonly connectorsService: ConnectorsService,
    private readonly tenancyService: TenancyService,
    private readonly iamService: IamService,
  ) {}

  /**
   * Own tenant → run directly. Another tenant → platform_admin + runAsGod.
   *
   * Factored out rather than repeated per route: the check is the only thing
   * standing between the operator console and an unaudited cross-tenant read,
   * and four hand-copied versions of it is four chances to omit one.
   */
  private async forTenant<T>(
    req: AuthenticatedRequest,
    id: string,
    reason: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (id === req.user.tenantId) return work();

    if (!(req.user.roles ?? []).includes(PlatformRole.PLATFORM_ADMIN)) {
      throw new ForbiddenException(
        `Reading another tenant's ${reason} requires platform_admin`,
      );
    }

    // Audited under the tenant actually being read (`id`), not the
    // operator's own tenant. Filing this under the operator's tenant meant
    // the target firm's own `firm_admin` could never see, in their own audit
    // log, that an operator had read their entitlements/branding/connectors.
    return this.tenancyService.runAsGod(
      req.user.id,
      id,
      `${reason} for tenant ${id} (God View)`,
      work,
    );
  }

  @Get(':id/entitlements')
  @ApiOperation({
    summary: "Another tenant's plan, modules and connectors (God View)",
    description:
      'Own tenant: any member. Another tenant: platform_admin only, audited ' +
      'via runAsGod. Modules were frozen at provisioning — do not infer them ' +
      'from the plan name.',
  })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'Entitlements retrieved' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  @ApiResponse({ status: 400, description: 'Tenant not found' })
  entitlements(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.forTenant(req, id, 'entitlements', () =>
      this.tenantProvisioningService.getEntitlements(id),
    );
  }

  @Put(':id/entitlements')
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({
    summary: "Override another tenant's entitlements, no plan ceiling (God View)",
    description:
      "The operator twin of `PUT /tenants/me/entitlements`, and deliberately " +
      'a strictly larger reach: the self-service route enforces the plan as ' +
      'a ceiling, this one does not, because the party defining what a plan ' +
      'means is not the party that ceiling exists to constrain (ADR 0009 ' +
      '§2.2). `reason` is required and is written into the audit entry — it ' +
      "is the only record of why a customer has a module its plan does not " +
      'include. Cannot change `plan` itself — use PATCH /tenants/:id/upgrade.',
  })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'Entitlements updated' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  @ApiResponse({ status: 400, description: 'Tenant not found, or reason too short' })
  async updateEntitlements(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: OperatorUpdateEntitlementsDto,
  ) {
    // Not routed through `forTenant`: `forTenant` lets an operator act on
    // their OWN tenant without platform_admin, which is meaningless for an
    // entitlements write — the operator's own tenant is the control-plane
    // tenant and carries no customer plan. Same reasoning `impersonate`
    // above already uses to bypass `forTenant`. `@Roles` above is the only
    // gate, and it is unconditional regardless of whose tenant `id` names.

    // Computed here, before runAsGod, deliberately: TenancyService.runAsGod
    // writes its audit entry BEFORE the wrapped work runs (CLAUDE.md §6.4),
    // so `overage` — part of that entry's required context per ADR 0009
    // §2.2 — must be known ahead of the write, not read off the write's own
    // result. `getPlanAllowance` and `updateEntitlementsAsOperator` diff
    // against the identical `PLAN_MODULES` map, so this is one computation
    // done twice, not a second, driftable list.
    const allowance = await this.tenantProvisioningService.getPlanAllowance(id);
    const overage = dto.modules.filter(
      (m) => !m.startsWith('country:') && !allowance.includes(m),
    );

    return this.tenancyService.runAsGod(
      req.user.id,
      id,
      // TenancyService.runAsGod records `reason` verbatim as the audit
      // entry's context (`{ reason, actorId, mode: 'god' }`) and takes no
      // separate structured context object — widening it is out of this
      // route's file scope and would change every other runAsGod call site
      // in the app. The ADR's `context: { tenantId, modules, overage,
      // reason }` is carried here by folding every field into this string,
      // the same technique `impersonate` above already uses to get
      // `dto.reason` into the audit trail.
      `Override entitlements for tenant ${id} (God View) — ` +
        `modules=[${dto.modules.join(', ')}], overage=[${overage.join(', ')}], ` +
        `reason=${dto.reason}`,
      async () => {
        const result = await this.tenantProvisioningService.updateEntitlementsAsOperator(
          id,
          dto.modules,
        );
        return { ...result.entitlements, overage: result.overage };
      },
    );
  }

  @Get(':id/branding')
  @ApiOperation({
    summary: "Another tenant's white-label branding (God View)",
  })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'Branding retrieved' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  branding(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.forTenant(req, id, 'branding', () =>
      this.brandingService.get(id),
    );
  }

  @Get(':id/connectors')
  @ApiOperation({
    summary: "Another tenant's regulator connectors (God View)",
    description:
      "The catalogue is filtered by the TARGET tenant's vertical, not the " +
      "caller's — an operator sits in the platform tenant, so using their " +
      'own vertical would return an empty list and read as "no connectors ' +
      'configured". Credentials never come back, only `hasCredentials`.',
  })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  @ApiResponse({ status: 200, description: 'Connector catalogue + state' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  connectors(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.forTenant(req, id, 'connectors', async () => {
      const { vertical } =
        await this.tenantProvisioningService.getEntitlements(id);
      return this.connectorsService.listForTenant(id, vertical);
    });
  }

  @Post(':id/impersonate')
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Mint a 15-minute support token for another tenant (God View)',
    description:
      'Returns an access token only — no refresh token, and no session row, ' +
      'so it expires on its own and cannot be extended. The token carries an ' +
      '`imp` claim naming the operator, so actions taken with it are ' +
      'attributable. platform_admin only; audited via runAsGod.',
  })
  @ApiParam({ name: 'id', description: 'Tenant id to act inside' })
  @ApiResponse({ status: 201, description: 'Impersonation token issued' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  @ApiResponse({
    status: 400,
    description: 'Tenant has no active user to impersonate',
  })
  impersonate(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ImpersonateDto,
  ) {
    // Not routed through `forTenant`: impersonating your own tenant is not a
    // lesser case of this operation, it is a meaningless one, and the
    // @Roles guard above already refuses non-operators.
    //
    // The starkest instance of the audit-tenant bug this file used to carry:
    // `req.user.tenantId` here filed "operator impersonated one of your
    // users" under the OPERATOR's tenant, so the firm whose user was
    // impersonated could never find it in their own audit log — the one
    // record that most needs to be visible to them. `id` (the target,
    // already a parameter) is the correct tenant.
    return this.tenancyService.runAsGod(
      req.user.id,
      id,
      `Impersonate a user in tenant ${id} — ${dto.reason} (God View)`,
      () =>
        this.iamService.issueImpersonationToken(id, {
          id: req.user.id,
          tenantId: req.user.tenantId,
        }),
    );
  }
}
