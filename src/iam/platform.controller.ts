import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenancyService } from '../core/tenancy/tenancy.service';
import type { AuthenticatedRequest } from '../common/types';

/**
 * Platform-level (cross-tenant) reads for the God UI. Everything here is
 * platform_admin-only and runs through runAsGod, which writes a CRITICAL
 * audit entry before the query executes (CLAUDE.md §6.4).
 */
@Controller('platform')
@ApiTags('platform')
export class PlatformController {
  constructor(
    private readonly tenantProvisioningService: TenantProvisioningService,
    private readonly tenancyService: TenancyService,
  ) {}

  @Get('stats')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Platform-wide aggregates (God View)',
    description:
      'Tenant counts by vertical/status/plan, user totals, 30-day growth.',
  })
  @ApiResponse({ status: 200, description: 'Stats retrieved' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  async stats(@Request() req: AuthenticatedRequest) {
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      'Platform stats (God View)',
      () => this.tenantProvisioningService.getPlatformStats(),
    );
  }
}
