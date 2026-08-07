import {
  ForbiddenException,
  Controller,
  Post,
  Body,
  Get,
  Param,
  Patch,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PolicyGuard } from './guards/policy.guard';
import { TenantProvisioningService } from './tenant-provisioning.service';
// Value import, deliberately not `import type`. `emitDecoratorMetadata` records
// the parameter's runtime constructor for ValidationPipe to reflect on; a type-only
// import is erased, `design:paramtypes` degrades to `Object`, and validation is
// skipped entirely — the same silent no-op that made this an interface a bug.
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CheckSlugDto } from './dto/check-slug.dto';
import { TenantPlan, TenantStatus } from './entities/tenant.entity';
import { ProvisionTenantDto } from './dto/provision-tenant.dto';
import { IamService } from './iam.service';
import { Roles } from './decorators/roles.decorator';
import { Public } from './decorators/public.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { TenancyService } from '../core/tenancy/tenancy.service';
import type { AuthenticatedRequest } from '../common/types';

@ApiTags('tenant-provisioning')
@Controller('tenants')
export class TenantProvisioningController {
  constructor(
    private readonly tenantProvisioningService: TenantProvisioningService,
    private readonly tenancyService: TenancyService,
    private readonly iamService: IamService,
  ) {}

  // ── God View ──────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List every tenant on the platform (God View)',
    description:
      'Platform operators only. This is a deliberate cross-tenant read, so it ' +
      'runs through `TenancyService.runAsGod` and writes a CRITICAL audit ' +
      'entry before the query executes (CLAUDE.md §6.4).',
  })
  @ApiResponse({ status: 200, description: 'Tenants retrieved' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  async listTenants(@Request() req: AuthenticatedRequest) {
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      'List all platform tenants (God View)',
      () => this.tenantProvisioningService.listAllTenants(),
    );
  }

  @Get('me/entitlements')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: "The caller tenant's plan, modules and enabled connectors",
    description:
      'What the portals gate nav/module screens on. Modules were frozen at ' +
      'provisioning; pre-existing tenants fall back to their plan defaults.',
  })
  @ApiResponse({ status: 200, description: 'Entitlements retrieved' })
  async myEntitlements(@Request() req: AuthenticatedRequest) {
    return this.tenantProvisioningService.getEntitlements(req.user.tenantId);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Provision a tenant (God View) — invite flow, no password',
    description:
      'Creates the workspace, freezes plan+module entitlements, pre-enables ' +
      'requested connectors in sandbox, and emails the admin a single-use ' +
      'invite link. Cross-tenant write → runAsGod + CRITICAL audit entry.',
  })
  @ApiResponse({ status: 201, description: 'Tenant provisioned, invite sent' })
  @ApiResponse({ status: 400, description: 'Slug taken or invalid input' })
  async provision(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ProvisionTenantDto,
  ) {
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      `Provision tenant ${dto.slug} (God View)`,
      () =>
        this.tenantProvisioningService.provisionTenant(dto, (tenantId, invite) =>
          this.iamService.inviteUser(tenantId, invite, {
            id: req.user.id,
            name: 'Meru Platform',
          }),
        ),
    );
  }

  @Patch(':id/suspend')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Suspend a tenant (God View)' })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  async suspend(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      `Suspend tenant ${id} (God View)`,
      () =>
        this.tenantProvisioningService.setTenantStatus(
          id,
          TenantStatus.SUSPENDED,
        ),
    );
  }

  @Patch(':id/resume')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Reactivate a suspended tenant (God View)' })
  @ApiParam({ name: 'id', description: 'Tenant id' })
  async resume(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      `Resume tenant ${id} (God View)`,
      () =>
        this.tenantProvisioningService.setTenantStatus(id, TenantStatus.ACTIVE),
    );
  }

  @Post('signup')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new workspace (tenant)' })
  @ApiResponse({ status: 201, description: 'Workspace created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input or slug taken' })
  async signup(@Body() dto: CreateTenantDto) {
    const result = await this.tenantProvisioningService.createTenant(dto);

    return result;
  }

  @Post('check-slug')
  @Public()
  @ApiOperation({ summary: 'Check if a workspace slug is available' })
  @ApiResponse({ status: 200, description: 'Slug availability checked' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', example: 'my-workspace' },
      },
      required: ['slug'],
    },
  })
  async checkSlug(@Body() dto: CheckSlugDto) {
    const result = await this.tenantProvisioningService.checkSlugAvailability(
      dto.slug,
    );

    return result;
  }

  // Guarded explicitly. There is no global APP_GUARD in this app — every
  // controller opts in — and this one had opted out entirely, leaving a
  // billing-mutating endpoint reachable unauthenticated by anyone who could
  // guess or observe a tenant id. `signup` and `check-slug` above stay public
  // by design; everything that touches an existing tenant does not.
  @Patch(':id/upgrade')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiOperation({ summary: 'Upgrade tenant plan' })
  @ApiResponse({ status: 200, description: 'Plan upgraded successfully' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        plan: { type: 'enum', enum: Object.values(TenantPlan) },
      },
      required: ['plan'],
    },
  })
  async upgradePlan(@Param('id') id: string, @Body('plan') plan: TenantPlan) {
    const tenant = await this.tenantProvisioningService.upgradeTenantPlan(
      id,
      plan,
    );

    return tenant;
  }

  @Get(':id/stats')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiOperation({
    summary: 'Get tenant statistics',
    description:
      'Own tenant: any member. Another tenant: platform_admin only, and the ' +
      'read runs through runAsGod so it is audited like every other ' +
      'cross-tenant access.',
  })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  @ApiResponse({
    status: 403,
    description: "Requires platform_admin to read another tenant's stats",
  })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  async getStats(@Request() req: AuthenticatedRequest, @Param('id') id: string) {
    // This route accepted any id and ran on the caller's RLS-bound
    // connection, so asking for someone else's tenant returned ZEROS rather
    // than an error — silently wrong counts in the God UI, which is worse
    // than a failure because nobody investigates a number that renders.
    if (id === req.user.tenantId) {
      return this.tenantProvisioningService.getTenantStats(id);
    }

    const roles = req.user.roles ?? [];
    if (!roles.includes(PlatformRole.PLATFORM_ADMIN)) {
      throw new ForbiddenException(
        "Reading another tenant's statistics requires platform_admin",
      );
    }

    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      `Read statistics for tenant ${id} (God View)`,
      () => this.tenantProvisioningService.getTenantStats(id),
    );
  }
}
