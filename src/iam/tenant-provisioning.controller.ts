import {
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
import { TenantPlan } from './entities/tenant.entity';
import { Roles } from './decorators/roles.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { TenancyService } from '../core/tenancy/tenancy.service';
import type { AuthenticatedRequest } from '../common/types';

@ApiTags('tenant-provisioning')
@Controller('tenants')
export class TenantProvisioningController {
  constructor(
    private readonly tenantProvisioningService: TenantProvisioningService,
    private readonly tenancyService: TenancyService,
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

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new workspace (tenant)' })
  @ApiResponse({ status: 201, description: 'Workspace created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input or slug taken' })
  async signup(@Body() dto: CreateTenantDto) {
    const result = await this.tenantProvisioningService.createTenant(dto);

    return result;
  }

  @Post('check-slug')
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
  @ApiOperation({ summary: 'Get tenant statistics' })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  @ApiParam({ name: 'id', description: 'Tenant ID' })
  async getStats(@Param('id') id: string) {
    const stats = await this.tenantProvisioningService.getTenantStats(id);

    return stats;
  }
}
