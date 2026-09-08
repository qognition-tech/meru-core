import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
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
import { PolicyGuard } from '../../iam/guards/policy.guard';
import { Roles } from '../../iam/decorators/roles.decorator';
import { PlatformRole } from '../../iam/enums/platform-role.enum';
import { FeatureFlagService } from '../services/feature-flag.service';
import { UpsertFeatureFlagDto } from '../dto/upsert-feature-flag.dto';
import type { AuthenticatedRequest } from '../../common/types';

/**
 * Tenant-scoped feature flags (TCM — CLAUDE.md §2 row 2). Reads for any
 * authenticated member of the tenant; mutations restricted to admins because
 * a flag flip changes product behavior for the whole tenant. Cross-tenant
 * flag control for the God UI arrives with tenant-provisioning v2.
 */
@Controller('feature-flags')
@ApiTags('config')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiBearerAuth('JWT-auth')
export class FeatureFlagController {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  @Get()
  @ApiOperation({ summary: "List the tenant's feature flags" })
  @ApiResponse({ status: 200, description: 'Flags retrieved' })
  list(@Request() req: AuthenticatedRequest) {
    return this.featureFlagService.list(req.user.tenantId);
  }

  @Put(':key')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({ summary: 'Create or update a feature flag by key' })
  @ApiParam({ name: 'key', example: 'kanban-v2' })
  @ApiResponse({ status: 200, description: 'Flag upserted' })
  upsert(
    @Request() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Body() dto: UpsertFeatureFlagDto,
  ) {
    return this.featureFlagService.upsert(req.user.tenantId, key, dto);
  }

  @Delete(':key')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a feature flag by key' })
  @ApiParam({ name: 'key', example: 'kanban-v2' })
  @ApiResponse({ status: 204, description: 'Flag deleted' })
  @ApiResponse({ status: 404, description: 'No such flag' })
  async remove(@Request() req: AuthenticatedRequest, @Param('key') key: string) {
    await this.featureFlagService.remove(req.user.tenantId, key);
  }
}
