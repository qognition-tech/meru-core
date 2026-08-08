import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
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
import { ConfigPackLoaderService } from '../tenant/services/config-pack-loader.service';

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
    private readonly configPackLoader: ConfigPackLoaderService,
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

  @Post('config-packs/reload')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Reload config packs from disk (God View)',
    description:
      'Runs the same load pass as application boot and returns a per-pack ' +
      'report: file version, the version read back from the database after ' +
      'writing, whether the two match, and the section keys actually ' +
      'persisted. The operator-facing twin of POST /jobs/packs/reload, which ' +
      'needs CRON_SECRET — a human publishing a pack should not need the ' +
      'machine credential. Idempotent: it only reads files shipped with the ' +
      'deployment and never downgrades a stored version.',
  })
  @ApiResponse({ status: 200, description: 'Load report' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  async reloadConfigPacks(@Request() req: AuthenticatedRequest) {
    // runAsGod, like every other route here: `config_packs` is platform-global,
    // so this writes rows every tenant then reads, and that belongs in the
    // CRITICAL audit trail rather than happening quietly.
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      'Reload config packs from disk (God View)',
      () => this.configPackLoader.reload(),
    );
  }
}
