import {
  ForbiddenException,
  Request,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from '../../iam/guards/policy.guard';
import { Roles } from '../../iam/decorators/roles.decorator';
import { ConfigPackService } from '../services/config-pack.service';
import { TenancyService } from '../../core/tenancy/tenancy.service';
import { PlatformRole } from '../../iam/enums/platform-role.enum';
import type { AuthenticatedRequest } from '../../common/types';
// Value import, NOT `import type`. A type-only import is erased, so
// `design:paramtypes` degrades to `Object` and ValidationPipe silently
// validates nothing — see the note in dto/config-pack.dto.ts.
import {
  CreateConfigPackDto,
  PinConfigPackDto,
} from '../dto/config-pack.dto';

/**
 * Config-pack administration (CLAUDE.md §4 — Layer 3/4 JSON injection).
 *
 * This controller had NO guard at all, which left `POST /`, `PUT /:id`,
 * `DELETE /:id`, `promote`, `promote-all` and tenant pinning reachable
 * unauthenticated — platform-global config CRUD open to the internet. There is
 * no global APP_GUARD in this app (every controller opts in), so the absence of
 * `@UseGuards` here meant genuinely no authentication, not a default-deny.
 *
 * Reads require a valid token; anything that mutates a pack or a tenant pin
 * requires `platform_admin`, because a pack change propagates to every tenant
 * pinned to it.
 */
@Controller('config-packs')
@ApiTags('config')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 403, description: 'Insufficient role privileges' })
export class ConfigPackController {
  constructor(
    private readonly configPackService: ConfigPackService,
    private readonly tenancyService: TenancyService,
  ) {}

  /**
   * Run work against another tenant's pins.
   *
   * `tenant_config_pins` is tenant-scoped, so every route here that names a
   * `:tenantId` is a cross-tenant operation the moment that id is not the
   * caller's. On the caller's RLS-bound connection those fail in two different
   * and equally bad ways: a write is refused by the policy and surfaces as a
   * 500 carrying the raw Postgres error, and a read simply returns **nothing**
   * — which renders as "this tenant has no pins" and is the worse of the two,
   * because an empty list looks like an answer.
   *
   * Pinning is how a tenant is version-locked to a vertical pack (CLAUDE.md
   * §5.1), so this meant pinning any tenant but your own had never worked.
   *
   * Same rule as /tenants/:id/stats and the operator routes: own tenant is
   * ordinary, another tenant needs platform_admin and goes through runAsGod,
   * which writes a CRITICAL audit entry before the query runs.
   */
  private async forTenant<T>(
    req: AuthenticatedRequest,
    tenantId: string,
    reason: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (tenantId === req.user.tenantId) return work();

    if (!(req.user.roles ?? []).includes(PlatformRole.PLATFORM_ADMIN)) {
      throw new ForbiddenException(
        `${reason} for another tenant requires platform_admin`,
      );
    }

    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      `${reason} for tenant ${tenantId} (God View)`,
      work,
    );
  }

  // ========== CRUD ==========

  @Post()
  @Roles('platform_admin')
  @ApiOperation({
    summary: 'Create a config pack',
    description:
      'Registers a new vertical/country pack. Platform-admin only — packs are ' +
      'global, not tenant-scoped.',
  })
  @ApiResponse({ status: 201, description: 'Config pack created' })
  async create(@Body() dto: CreateConfigPackDto) {
    return this.configPackService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List config packs, optionally filtered by vertical',
  })
  @ApiQuery({
    name: 'vertical',
    required: false,
    example: 'immigration',
    description: 'Filter by vertical (e.g. immigration, banking)',
  })
  @ApiResponse({ status: 200, description: 'Config packs returned' })
  async findAll(@Query('vertical') vertical?: string) {
    return this.configPackService.findAll(vertical);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single config pack by id' })
  @ApiParam({ name: 'id', description: 'Config pack UUID' })
  @ApiResponse({ status: 200, description: 'Config pack returned' })
  @ApiResponse({ status: 404, description: 'Config pack not found' })
  async findById(@Param('id') id: string) {
    return this.configPackService.findById(id);
  }

  @Put(':id')
  @Roles('platform_admin')
  @ApiOperation({ summary: 'Update a config pack' })
  @ApiParam({ name: 'id', description: 'Config pack UUID' })
  @ApiResponse({ status: 200, description: 'Config pack updated' })
  async update(
    @Param('id') id: string,
    @Body() updates: Record<string, unknown>,
  ) {
    return this.configPackService.update(id, updates);
  }

  @Delete(':id')
  @Roles('platform_admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a config pack' })
  @ApiParam({ name: 'id', description: 'Config pack UUID' })
  @ApiResponse({ status: 204, description: 'Config pack deleted' })
  async delete(@Param('id') id: string) {
    await this.configPackService.delete(id);
  }

  // ========== VERSION MANAGEMENT ==========

  @Post(':id/promote')
  @Roles('platform_admin')
  @ApiOperation({
    summary: 'Promote a config pack to a specific version',
  })
  @ApiParam({ name: 'id', description: 'Config pack UUID' })
  @ApiResponse({ status: 201, description: 'Version promoted' })
  async promoteVersion(
    @Param('id') id: string,
    @Body() body: { version: string; userId?: string },
  ) {
    return this.configPackService.promoteVersion(
      id,
      body.version,
      body.userId || 'system',
    );
  }

  @Put(':id/deactivate')
  @Roles('platform_admin')
  @ApiOperation({ summary: 'Deactivate a config pack' })
  @ApiParam({ name: 'id', description: 'Config pack UUID' })
  @ApiResponse({ status: 200, description: 'Config pack deactivated' })
  async deactivate(@Param('id') id: string) {
    return this.configPackService.deactivate(id);
  }

  // ========== TENANT PINNING ==========

  @Post('pin/:tenantId')
  @Roles('platform_admin')
  @ApiOperation({
    summary: 'Pin a config pack version to a tenant',
    description:
      'Version-pins a tenant so pack updates do not silently change its ' +
      'behaviour (CLAUDE.md §5.1).',
  })
  @ApiParam({ name: 'tenantId', description: 'Tenant UUID' })
  @ApiResponse({ status: 201, description: 'Config pack pinned to tenant' })
  async pinToTenant(
    @Request() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
    @Body() dto: PinConfigPackDto,
  ) {
    return this.forTenant(req, tenantId, 'Pin config pack', () =>
      this.configPackService.pinToTenant(tenantId, dto),
    );
  }

  @Delete('pin/:tenantId/:configPackId')
  @Roles('platform_admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a config pack pin from a tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant UUID' })
  @ApiParam({ name: 'configPackId', description: 'Config pack UUID' })
  @ApiResponse({ status: 204, description: 'Pin removed' })
  async unpinFromTenant(
    @Request() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
    @Param('configPackId') configPackId: string,
  ) {
    await this.forTenant(req, tenantId, 'Unpin config pack', () =>
      this.configPackService.unpinFromTenant(tenantId, configPackId),
    );
  }

  @Get('pin/:tenantId')
  @ApiOperation({ summary: 'List the config pack pins for a tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant UUID' })
  @ApiResponse({ status: 200, description: 'Pins returned' })
  async getTenantPins(
    @Request() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
  ) {
    return this.forTenant(req, tenantId, 'Read config pack pins', () =>
      this.configPackService.getTenantPins(tenantId),
    );
  }

  @Get('effective/:tenantId/:code')
  @ApiOperation({
    summary: 'Resolve the effective config for a tenant and pack code',
    description:
      'Applies the four-layer merge (vertical pack + country overlay + tenant ' +
      'pin) and returns the config the tenant actually runs on.',
  })
  @ApiParam({ name: 'tenantId', description: 'Tenant UUID' })
  @ApiParam({
    name: 'code',
    description: 'Config pack code, e.g. au-immigration',
  })
  @ApiResponse({ status: 200, description: 'Effective config returned' })
  async getTenantEffectiveConfig(
    @Request() req: AuthenticatedRequest,
    @Param('tenantId') tenantId: string,
    @Param('code') code: string,
  ) {
    return this.forTenant(req, tenantId, 'Resolve effective config', () =>
      this.configPackService.getTenantEffectiveConfig(tenantId, code),
    );
  }

  // ========== PROMOTE ACROSS ENVIRONMENTS ==========

  @Post(':id/promote-all')
  @Roles('platform_admin')
  @ApiOperation({
    summary: 'Promote a config pack version to every pinned tenant',
    description:
      'Fans a version out across all tenants pinned to this pack. ' +
      'Platform-admin only — this changes behaviour for every tenant at once.',
  })
  @ApiParam({ name: 'id', description: 'Config pack UUID' })
  @ApiResponse({ status: 201, description: 'Version promoted to all tenants' })
  async promoteToAllTenants(
    @Param('id') id: string,
    @Body() body: { version: string; userId?: string },
  ) {
    return this.configPackService.promoteToAllTenants(
      id,
      body.version,
      body.userId || 'system',
    );
  }
}
