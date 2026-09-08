import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../iam/decorators/public.decorator';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { CapabilitiesService } from './capabilities.service';

@Controller('health')
@ApiTags('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly capabilities: CapabilitiesService
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness + readiness probe (checks DB)' })
  @ApiResponse({ status: 200, description: 'Service healthy' })
  @ApiResponse({ status: 503, description: 'Service unhealthy' })
  async check() {
    let database = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      service: 'meru-core',
      vertical: process.env.VERTICAL || 'core',
      database,
      // Counts only. This route is public, so naming which credentials are
      // absent would hand an unauthenticated caller a reconnaissance list.
      capabilities: await this.capabilities.summary(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Which credentials are missing, and what each one breaks.
   *
   * platform_admin only, and guarded with a PlatformRole member rather than a
   * string — `@Roles('admin')` is a role no user holds, which makes a route
   * unreachable rather than protected. That mistake has been made twice here.
   *
   * The third mistake was subtler: `@Roles` sat here with nothing that reads
   * it. `GlobalAuthGuard` (APP_GUARD) authenticates every non-`@Public` route
   * and fills `request.user`, but role checks are `PolicyGuard`'s job and this
   * controller applied it nowhere — so the restriction was inert and any
   * authenticated caller of any role, `client` included, got the report.
   *
   * Fixed with the guard, per ADR 0007 D4.
   *
   * An earlier pass checked the role inline instead, on the assumption that
   * `@UseGuards(PolicyGuard)` would need `HealthModule` to import `IamModule`
   * and risk a wiring fault that only shows at runtime. That assumption was
   * wrong: `PolicyGuard`'s three dependencies are all globally available —
   * `Reflector` and `DataSource` inherently, and `VerticalPolicyService`
   * through `CoreModule`, which is `@Global()`. `TasksModule` proves it
   * empirically, using this guard while importing neither.
   *
   * Class-level rather than method-level is still not an option: `GET /health`
   * above is `@Public()` and must stay anonymous, and `PolicyGuard` throws
   * when there is no user.
   */
  @Get('capabilities')
  @UseGuards(PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Per-capability configuration report' })
  @ApiResponse({ status: 200, description: 'Capability report' })
  @ApiResponse({ status: 403, description: 'Not a platform admin' })
  async capabilityReport() {
    return {
      capabilities: await this.capabilities.report(),
      summary: await this.capabilities.summary(),
    };
  }
}
